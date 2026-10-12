import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { get, put } from "@vercel/blob";
import { and, asc, desc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays, bangkokDateStartUtc } from "@/lib/room-capacity/dates";
import { assertCaptureBinding, captureConflict, captureInput, captureTiming, screenshotMime, submissionDuringCapture } from "./capture-model";
import { PostClassNotFoundError, PostClassValidationError } from "./errors";
import { feedbackAutoSubmittedFlag } from "./feedback-proof";

const table = schema.postClassFeedbackCaptures;
async function verifiedImage(pathname: string, sha256: string) {
  const stored = await get(pathname, { access: "private" });
  if (!stored || stored.statusCode !== 200) return false;
  const saved = Buffer.from(await new Response(stored.stream).arrayBuffer());
  return createHash("sha256").update(saved).digest("hex") === sha256;
}
export async function captureClass(sessionId: string, db: Database = getDb()) {
  const [session] = await db.select().from(schema.postClassSessions).where(eq(schema.postClassSessions.id, sessionId)).limit(1);
  if (!session) throw new PostClassNotFoundError("Class not found.");
  const participants = await db.select().from(schema.postClassSessionParticipants).where(eq(schema.postClassSessionParticipants.sessionId, sessionId));
  const binding = { wiseSessionId: session.wiseSessionId, tutorKey: session.canonicalTutorKey ?? "", tutorName: session.canonicalTutorName ?? "",
    students: participants.map(p => p.studentName), subject: typeof session.sourceMetadata.subject === "string" ? session.sourceMetadata.subject : session.className ?? "",
    deadlineAt: session.deadlineAt.toISOString() };
  return { session, binding };
}
export async function listCaptures(sessionId: string, db: Database = getDb()) {
  const { session, binding } = await captureClass(sessionId, db);
  const [rows, events] = await Promise.all([
    db.select().from(table).where(eq(table.sessionId, sessionId)).orderBy(desc(table.capturedAt)),
    captureEvents(session.wiseSessionId, db),
  ]);
  return { binding, captures: rows.map(row => {
    let currentClass = true;
    try { assertCaptureBinding(binding, row.binding); } catch { currentClass = false; }
    return { ...row, pathname: undefined, conflict: captureConflict(row.state, row.observedAt, events), duringCapture: submissionDuringCapture(row.state, row.observedAt, row.capturedAt, events), currentClass,
      currentDeadline: row.deadlineAt.getTime() === session.deadlineAt.getTime(), imageUrl: row.uploadStatus === "ready" ? `/api/post-class-feedback/captures/${row.id}` : null };
  }) };
}
async function captureEvents(wiseSessionId: string, db: Database) {
  const events = await db.select().from(schema.wiseActivityEvents).where(and(eq(schema.wiseActivityEvents.sessionId, wiseSessionId),
    eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent")));
  return events.map(event => ({ ...event, autoSubmitted: feedbackAutoSubmittedFlag(event.payload) }));
}
export async function dueCaptureQueue(date: string, db: Database = getDb()) {
  const start = bangkokDateStartUtc(date), end = bangkokDateStartUtc(addBangkokDays(date, 1));
  const sessions = await db.select().from(schema.postClassSessions).where(and(eq(schema.postClassSessions.eligible, true),
    isNull(schema.postClassSessions.wiseDeletedAt), gte(schema.postClassSessions.deadlineAt, start), lt(schema.postClassSessions.deadlineAt, end)))
    .orderBy(asc(schema.postClassSessions.canonicalTutorName), asc(schema.postClassSessions.scheduledStartAt));
  const classes = await Promise.all(sessions.map(async session => ({ id: session.id, startAt: session.scheduledStartAt,
    endAt: session.scheduledEndAt, sourceStatus: session.sourceStatus, wiseTeacherUserId: session.wiseTeacherUserId, ...await listCaptures(session.id, db) })));
  const [sync] = await db.select().from(schema.postClassSyncRuns).where(eq(schema.postClassSyncRuns.status, "success")).orderBy(desc(schema.postClassSyncRuns.finishedAt)).limit(1);
  const issues = await db.select({ id: schema.postClassSourceIssues.id }).from(schema.postClassSourceIssues).where(and(eq(schema.postClassSourceIssues.status, "open"), eq(schema.postClassSourceIssues.blocksEnforcement, true)));
  const complete = Boolean(sync?.finishedAt && Date.now() - sync.finishedAt.getTime() <= 60 * 60_000 && issues.length === 0);
  return { date, timeZone: "Asia/Bangkok", classes, complete, sourceIssueCount: issues.length, lastSuccessfulSyncAt: sync?.finishedAt ?? null };
}
export async function saveCapture(sessionId: string, raw: unknown, bytes: Buffer | null, actor: string, now = new Date(), db: Database = getDb()) {
  const input = captureInput.parse(raw);
  const { session, binding } = await captureClass(sessionId, db);
  assertCaptureBinding(binding, input);
  if (!binding.tutorKey || !binding.tutorName || (input.mode === "deadline" && (!session.eligible || session.wiseDeletedAt))) throw new PostClassValidationError("The class identity or eligibility needs review.");
  const observedAt = new Date(input.observedAt), capturedAt = new Date(input.capturedAt);
  const timing = captureTiming(session.deadlineAt, capturedAt, input.mode);
  if (observedAt > capturedAt || capturedAt.getTime() > now.getTime() + 5000 || observedAt < session.deadlineAt) throw new PostClassValidationError("Check the observation and capture times.");
  if (input.mode === "deadline" && now.getTime() - capturedAt.getTime() > 60 * 60_000) throw new PostClassValidationError("An old image cannot be added as a new deadline capture. Use a later check.");
  if (!bytes && (input.state !== "uncheckable" || !input.note.trim())) throw new PostClassValidationError("Attach the screenshot, or record why the class could not be checked.");
  const mime = bytes ? screenshotMime(bytes) : null;
  if (bytes) {
    try { await (await import("sharp")).default(bytes, { limitInputPixels: 40_000_000 }).metadata(); }
    catch { throw new PostClassValidationError("The screenshot image could not be read."); }
  }
  const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  const idempotencyKey = createHash("sha256").update(JSON.stringify([sessionId, input, sha256])).digest("hex");
  const id = randomUUID(), pathname = bytes ? `post-class-feedback/captures/${id}` : null;
  const [inserted] = await db.insert(table).values({ id, sessionId, binding, deadlineAt: session.deadlineAt, observedAt, capturedAt,
    mode: input.mode, state: input.state, timing, note: input.note, mime, sha256, size: bytes?.length ?? null, pathname,
    uploadStatus: bytes ? "pending" : "no_image", uploadedBy: actor, idempotencyKey }).onConflictDoNothing({ target: table.idempotencyKey }).returning();
  const [existing] = inserted ? [] : await db.select().from(table).where(eq(table.idempotencyKey, idempotencyKey)).limit(1);
  const row = inserted ?? existing;
  if (!row) throw new Error("Capture record could not be saved.");
  if (!bytes || row.uploadStatus === "ready") return row;
  try {
    const prior = await get(row.pathname!, { access: "private" });
    if (!prior) await put(row.pathname!, bytes, { access: "private", contentType: mime!, addRandomSuffix: false, allowOverwrite: false });
    if (!await verifiedImage(row.pathname!, sha256!)) throw new Error("Image read-back failed.");
    const [ready] = await db.update(table).set({ uploadStatus: "ready", uploadError: null }).where(eq(table.id, row.id)).returning();
    return ready;
  } catch {
    // Another identical upload can win the blob write while this request is waiting.
    if (await verifiedImage(row.pathname!, sha256!).catch(() => false)) {
      const [ready] = await db.update(table).set({ uploadStatus: "ready", uploadError: null }).where(eq(table.id, row.id)).returning();
      return ready;
    }
    const [failed] = await db.update(table).set({ uploadStatus: "failed", uploadError: "Image upload or read-back failed. Retry the same file and metadata." })
      .where(and(eq(table.id, row.id), ne(table.uploadStatus, "ready"))).returning();
    const [current] = failed ? [] : await db.select().from(table).where(eq(table.id, row.id));
    return failed ?? current;
  }
}
