import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { attemptDeductionReportDelivery, loadDeductionReport, sendDeductionReport } from "../deduction-report";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import { captureClass, dueCaptureQueue, listCaptures, saveCapture } from "../captures";

vi.mock("server-only", () => ({}));
const blobs = vi.hoisted(() => ({ files: new Map<string, Buffer>(), fail: false, race: false, secondPut: false, release: null as (() => void) | null }));
vi.mock("@vercel/blob", () => ({
  put: async (path: string, bytes: Buffer) => {
    if (blobs.fail) throw new Error("Unavailable");
    if (blobs.race && blobs.files.has(path)) { blobs.secondPut = true; blobs.release?.(); throw new Error("Overwrite rejected"); }
    blobs.files.set(path, bytes);
    if (blobs.race) await new Promise<void>(resolve => { blobs.release = resolve; });
  },
  get: async (path: string) => { if (blobs.race && !blobs.secondPut) return null; const bytes = blobs.files.get(path); return bytes ? { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null; },
}));
let handle: Awaited<ReturnType<typeof startTestDb>>;
const deadline = new Date("2026-10-11T16:59:59.999Z"), now = new Date("2026-10-12T01:00:00Z");
const db = () => handle.db as unknown as Database;
beforeAll(async () => { handle = await startTestDb(); }, 60_000);
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); blobs.files.clear(); blobs.fail = false; blobs.race = false; blobs.secondPut = false; blobs.release = null; });
async function seed(status: "pending_review" | "waived" = "pending_review") {
  const [session] = await handle.db.insert(schema.postClassSessions).values({ wiseSessionId: "wise-1", wiseClassId: "class-1", className: "Maths",
    canonicalTutorKey: "one", canonicalTutorName: "Tutor One", scheduledStartAt: new Date("2026-10-09T03:00:00Z"), scheduledEndAt: new Date("2026-10-09T04:00:00Z"), deadlineAt: deadline,
    finalStatus: "ENDED", eligible: true, sourceStatus: "ready", timingStatus: "late", sourceMetadata: { subject: "Maths" } }).returning();
  await handle.db.insert(schema.postClassSessionParticipants).values({ sessionId: session.id, participantKey: "student-1", studentName: "Student One", creditsConsumed: 1, billable: true });
  const [deduction] = await handle.db.insert(schema.postClassDeductions).values({ sessionId: session.id, status, defaultFinanceMonth: "2026-10-01" }).returning();
  await handle.db.insert(schema.postClassDeductionActions).values({ deductionId: deduction.id, action: "candidate_created", toStatus: "pending_review", amountMinor: 10000,
    actorEmail: "system", idempotencyKey: "candidate:wise-1", occurredAt: new Date("2026-10-11T17:00:01Z") });
  return session;
}
describe("deduction report and screenshot storage", () => {
  it("keeps final run counts correct when recipient retries finish in parallel", async () => {
    const result = await sendDeductionReport(now, db(), { sendEmail: async () => { throw new ScheduleEmailRejection("Not accepted"); } });
    const rows = await handle.db.select().from(schema.postClassNotificationDeliveries);
    const later = new Date(now.getTime() + 60 * 60_000);
    await Promise.all(rows.map(row => attemptDeductionReportDelivery(row.id, db(), { sendEmail: async () => ({ id: `accepted-${row.id}` }) }, later)));
    const [run] = await handle.db.select().from(schema.postClassNotificationRuns).where(eq(schema.postClassNotificationRuns.id, result.runId));
    expect(run.status).toBe("sent"); expect(run.sentCount).toBe(3); expect(run.failedCount).toBe(0);
  });
  it("keeps a concurrent duplicate upload ready after an overwrite rejection", async () => {
    const session = await seed(); const { binding } = await captureClass(session.id, db());
    const at = new Date("2026-10-11T17:00:00Z");
    const input = { ...binding, mode: "deadline", state: "missing", observedAt: at.toISOString(), capturedAt: at.toISOString() };
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=", "base64");
    blobs.race = true;
    const saved = await Promise.all([saveCapture(session.id, input, image, "reviewer@example.com", at, db()), saveCapture(session.id, input, image, "reviewer@example.com", at, db())]);
    expect(saved.every(row => row.uploadStatus === "ready")).toBe(true);
    const listed = await listCaptures(session.id, db()); expect(listed.captures).toHaveLength(1); expect(listed.captures[0].imageUrl).toBeTruthy();
  });
  it("keeps failed and later evidence with both observation and capture times in the report", async () => {
    const session = await seed(); const { binding } = await captureClass(session.id, db());
    const at = new Date("2026-10-11T17:00:00Z");
    await saveCapture(session.id, { ...binding, mode: "deadline", state: "uncheckable", observedAt: at.toISOString(), capturedAt: at.toISOString(), note: "Wise sign-in failed" }, null, "reviewer@example.com", at, db());
    const later = new Date("2026-10-12T02:00:00Z");
    await saveCapture(session.id, { ...binding, mode: "current", state: "uncheckable", observedAt: later.toISOString(), capturedAt: later.toISOString(), note: "Later access check failed" }, null, "reviewer@example.com", later, db());
    const report = await loadDeductionReport(new Date("2026-10-13T01:00:00Z"), db());
    expect(report.text).toContain("Missing verified deadline evidence"); expect(report.text).toContain("later check");
    expect(report.text).toContain("observed"); expect(report.text).toContain("captured");
  });
  it("selects the creation day and retains the current waived status", async () => {
    await seed("waived");
    const report = await loadDeductionReport(new Date("2026-10-13T01:00:00Z"), db());
    expect(report.metadata.rows).toHaveLength(1);
    expect(report.metadata.rows[0].status).toBe("waived");
    expect((await loadDeductionReport(now, db())).metadata.rows).toHaveLength(0);
  });
  it("saves one frozen report and sends each recipient once on a repeat run", async () => {
    await seed();
    const received: string[] = [];
    const sender = { sendEmail: async (input: { to: string }) => { received.push(input.to); return { id: `accepted-${received.length}` }; } };
    const at = new Date("2026-10-13T01:00:00Z");
    expect((await sendDeductionReport(at, db(), sender)).sent).toBe(3);
    await sendDeductionReport(at, db(), sender);
    expect(received).toEqual(["kevhsh7@gmail.com", "pakwalaan@gmail.com", "k.waritpariya@gmail.com"]);
    const deliveries = await handle.db.select().from(schema.postClassNotificationDeliveries);
    expect(deliveries.every(row => Boolean(row.providerMessageId))).toBe(true);
  });
  it("does not resend an uncertain acceptance", async () => {
    const seen: string[] = [];
    const sender = { sendEmail: async (input: { to: string }) => { seen.push(input.to); throw new Error("Timeout after possible acceptance"); } };
    expect((await sendDeductionReport(now, db(), sender)).status).toBe("unknown");
    await sendDeductionReport(now, db(), sender);
    expect(seen).toHaveLength(3);
    expect((await handle.db.select().from(schema.postClassNotificationDeliveries)).every(row => row.status === "unknown")).toBe(true);
  });
  it("selects only projected deductions and removes a class after compliant feedback", async () => {
    const session = await seed();
    await handle.db.insert(schema.postClassSettings).values({ id: "default", enforcementMode: "live" });
    const [assessment] = await handle.db.insert(schema.postClassAssessments).values({
      sessionId: session.id, assessmentKey: "capture-projection", policyVersion: 1, mappingVersion: 1,
      sourceStatus: "ready", contentStatus: "blank", timingStatus: "not_due", enforcementMode: "live",
      fieldFailures: ["combined_characters:0/300"], details: { policyApplies: true, deadlineAt: deadline.toISOString(), timingReviewRequired: false },
    }).returning();
    expect((await dueCaptureQueue("2026-10-11", db())).classes.map(row => row.id)).toEqual([session.id]);
    await handle.db.update(schema.postClassAssessments).set({ rawOnTime: true, adjustedCompliant: true, fieldFailures: [] }).where(eq(schema.postClassAssessments.id, assessment.id));
    expect((await dueCaptureQueue("2026-10-11", db())).classes).toEqual([]);
  });
  it("records upload failure, retries without duplicates and flags deadline changes", async () => {
    const session = await seed();
    const queue = await dueCaptureQueue("2026-10-11", db());
    expect(queue.classes).toEqual([]); expect(queue.dueClassCount).toBe(1); expect(queue.unresolvedClassCount).toBe(1);
    const { binding } = await captureClass(session.id, db());
    const at = new Date("2026-10-11T17:00:00Z");
    const input = { ...binding, mode: "deadline", state: "missing", observedAt: at.toISOString(), capturedAt: at.toISOString(), note: "Wise pending" };
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=", "base64");
    blobs.fail = true;
    expect((await saveCapture(session.id, input, image, "reviewer@example.com", at, db())).uploadStatus).toBe("failed");
    blobs.fail = false;
    const saved = await saveCapture(session.id, input, image, "reviewer@example.com", at, db());
    expect(saved.uploadStatus).toBe("ready");
    expect((await listCaptures(session.id, db())).captures).toHaveLength(1);
    await handle.db.update(schema.postClassSessions).set({ canonicalTutorName: "Tutor Two" }).where(eq(schema.postClassSessions.id, session.id));
    expect((await listCaptures(session.id, db())).captures[0].currentClass).toBe(false);
    await handle.db.update(schema.postClassSessions).set({ canonicalTutorName: "Tutor One" }).where(eq(schema.postClassSessions.id, session.id));
    await handle.db.update(schema.postClassSessions).set({ deadlineAt: new Date("2026-10-12T16:59:59.999Z") }).where(eq(schema.postClassSessions.id, session.id));
    expect((await listCaptures(session.id, db())).captures[0].currentDeadline).toBe(false);
    await expect(saveCapture(session.id, input, image, "reviewer@example.com", at, db())).rejects.toThrow("deadlineAt");
  });
});
