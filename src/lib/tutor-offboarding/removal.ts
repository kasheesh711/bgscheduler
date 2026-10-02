import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sqlStateOf } from "@/lib/db/sql-state";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { resolveOnboardingIdentities } from "@/lib/tutor-onboarding/planner";
import { loadAccountMappings } from "@/lib/tutor-onboarding/sync";
import { getWiseTeacherUserId, type WiseTeacher } from "@/lib/wise/types";
import { buildOffboardingDashboard } from "./data";
import { listDecisions } from "./decisions";
import { TutorOffboardingError } from "./errors";
import { hasRemovalGrant } from "./grants";
import { loadOffboardingSignals, loadFeedTimestamps } from "./signals";
import { assertCompleteRoster, personUnsafeReason, removalMode } from "./removal-safety";
import { getRemovalRun } from "./removal-store";
import { readRemovalWiseEvidence, readRemovalRoster, removeWiseParticipantOnce, type RemovalWiseEvidence, type RemovalRequestResult } from "./removal-wise";
import type { OffboardingPersonRow, TutorOffboardingViewer } from "./types";
import type { RemovalApplyInput, RemovalRunDetail } from "./removal-types";
export { getRemovalRun, listRemovalRuns } from "./removal-store";

const runs = schema.tutorOffboardingRuns; const accounts = schema.tutorOffboardingRunAccounts;
export interface RemovalOptions {
  db?: Database; now?: () => Date; env?: Record<string, string | undefined>;
  readWise?: () => Promise<RemovalWiseEvidence>; readRoster?: () => Promise<WiseTeacher[]>;
  removeParticipant?: (userId: string) => Promise<RemovalRequestResult>;
  loadRows?: (db: Database, viewer: TutorOffboardingViewer, now: Date) => Promise<OffboardingPersonRow[]>;
}
async function requireGrant(viewer: TutorOffboardingViewer, db: Database) {
  if (!await hasRemovalGrant(viewer.email, db)) throw new TutorOffboardingError("You are not allowed to remove tutors.", 403);
}
export async function loadRemovalRows(db: Database, viewer: TutorOffboardingViewer, now: Date): Promise<OffboardingPersonRow[]> {
  const [signals, feeds, decisions] = await Promise.all([loadOffboardingSignals(db, now), loadFeedTimestamps(db), listDecisions(db, now)]);
  if (!signals || !feeds.tutorSnapshot) throw new TutorOffboardingError("No current tutor snapshot is available.", 409);
  const dashboard = buildOffboardingDashboard({ signals, feeds, decisions, grants: null, viewer, now });
  return [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff];
}
export async function resolveRemovalRoster(db: Database, roster: WiseTeacher[]) {
  assertCompleteRoster(roster);
  const [aliases, prior] = await Promise.all([db.select().from(schema.tutorAliases), loadAccountMappings(db)]);
  return resolveOnboardingIdentities(roster, aliases, prior);
}
async function pendingRequestIds(db: Database, excludeRunId?: string): Promise<{ teachers: Set<string>; users: Set<string> }> {
  const rows = await db.select({ teacher: accounts.wiseTeacherId, user: accounts.wiseUserId }).from(accounts)
    .where(and(inArray(accounts.status, ["sending", "sent", "unknown"]), excludeRunId ? ne(accounts.runId, excludeRunId) : undefined));
  return { teachers: new Set(rows.map(r => r.teacher)), users: new Set(rows.flatMap(r => r.user ? [r.user] : [])) };
}
export async function previewRemovalRun(viewer: TutorOffboardingViewer, canonicalKeys: string[], options: RemovalOptions = {}): Promise<RemovalRunDetail> {
  const db = options.db ?? getDb(); const now = (options.now ?? (() => new Date()))();
  await requireGrant(viewer, db);
  const keys = [...new Set(canonicalKeys)];
  if (!keys.length || keys.length > 100 || keys.some(k => !k?.trim())) throw new TutorOffboardingError("Select between 1 and 100 people.", 422);
  const rows = await (options.loadRows ?? loadRemovalRows)(db, viewer, now);
  if (keys.some(k => !rows.some(r => r.signals.canonicalKey === k))) throw new TutorOffboardingError("A selected person is no longer on the current roster.", 409);
  const evidence = await (options.readWise ?? readRemovalWiseEvidence)();
  const identity = await resolveRemovalRoster(db, evidence.roster);
  const pending = await pendingRequestIds(db); const id = randomUUID();
  const values: Array<typeof accounts.$inferInsert> = [];
  for (const key of keys) {
    const row = rows.find(r => r.signals.canonicalKey === key)!;
    const group = identity.groups.find(g => g.canonicalKey === key);
    const current = evidence.roster.filter(t => group?.members.some(m => m.wiseTeacherId === t._id));
    const expected = row.signals.accounts.map(a => evidence.roster.find(t => t._id === a.wiseTeacherId)).filter((t): t is WiseTeacher => Boolean(t));
    const unsafe = !row.score.removable ? row.score.removableBlockedBy ?? "This person is not eligible for removal."
      : expected.length !== row.signals.accounts.length ? "Wise account membership changed; create a new preview."
      : row.signals.accounts.some(a => getWiseTeacherUserId(expected.find(t => t._id === a.wiseTeacherId)!) !== a.wiseUserId) ? "Wise user identity changed; create a new preview."
      : row.signals.accounts.some(a => pending.teachers.has(a.wiseTeacherId) || (a.wiseUserId !== null && pending.users.has(a.wiseUserId))) ? "A previous request needs roster reconciliation before a new preview."
      : personUnsafeReason({ expected, current, sessions: evidence.sessions, blocked: identity.blocked.has(key), now });
    for (const account of row.signals.accounts) {
      const snapshot = evidence.roster.find(t => t._id === account.wiseTeacherId) ?? { _id: account.wiseTeacherId };
      values.push({ runId: id, canonicalKey: key, displayName: account.displayName, wiseTeacherId: account.wiseTeacherId,
        wiseUserId: account.wiseUserId, isOnlineVariant: account.isOnlineVariant, accountSnapshot: snapshot,
        likelihoodAtPreview: row.score.likelihood, reasons: row.score.reasons.map(r => r.text),
        plan: unsafe ? "skip" : "remove", skipReason: unsafe, status: unsafe ? "skipped" : "planned", updatedAt: now });
    }
  }
  await requireGrant(viewer, db);
  await withDatabaseTransaction(db, async tx => {
    await tx.insert(runs).values({ id, status: "previewed", mode: removalMode(options.env), previewToken: createHash("sha256").update(JSON.stringify({ id, mode: removalMode(options.env), values })).digest("hex"),
      previewExpiresAt: new Date(now.getTime() + 15 * 60_000), tutorCount: keys.length,
      accountCount: values.filter(a => a.plan === "remove").length, createdByEmail: viewer.email, createdAt: now });
    if (values.length) await tx.insert(accounts).values(values);
  });
  return (await getRemovalRun(id, db))!;
}
function tokenMatches(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** The only application workflow permitted to send removal requests. Never retries a persisted request. */
export async function applyRemovalRun(viewer: TutorOffboardingViewer, runId: string, input: RemovalApplyInput, options: RemovalOptions = {}): Promise<RemovalRunDetail> {
  const db = options.db ?? getDb(); const clock = options.now ?? (() => new Date()); const now = clock();
  await requireGrant(viewer, db);
  let run = await getRemovalRun(runId, db);
  if (!run) throw new TutorOffboardingError("Removal preview not found.", 404);
  if (run.status !== "previewed") throw new TutorOffboardingError("This preview has already been used.", 409);
  if (Date.parse(run.previewExpiresAt) <= now.getTime()) {
    await db.update(runs).set({ status: "expired" }).where(and(eq(runs.id, runId), eq(runs.status, "previewed")));
    throw new TutorOffboardingError("The preview expired. Create a new preview.", 409);
  }
  if (!input.confirmed || !tokenMatches(run.previewToken, input.previewToken) || input.accountCount !== run.accountCount || input.reason.trim().length < 10) throw new TutorOffboardingError("Confirm the saved preview, account count and a reason of at least 10 characters.", 422);
  if (run.mode !== removalMode(options.env)) throw new TutorOffboardingError("Removal mode changed. Create a new preview.", 409);
  try {
    await withDatabaseTransaction(db, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tutor_offboarding_apply'))`);
      await requireGrant(viewer, tx);
      const changed = await tx.update(runs).set({ status: "applying", reason: input.reason.trim(), appliedByEmail: viewer.email, appliedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.status, "previewed"))).returning({ id: runs.id });
      if (!changed.length) throw new TutorOffboardingError("This preview has already been used.", 409);
    });
  } catch (error) {
    if (sqlStateOf(error) === "23505") throw new TutorOffboardingError("Another removal is being applied. Wait for its results.", 409);
    throw error;
  }
  // All failures below leave an auditable applying run. Reconciliation settles interrupted runs without POST.
  const loadRows = options.loadRows ?? loadRemovalRows;
  const readWise = options.readWise ?? readRemovalWiseEvidence;
  // Full pagination is read once immediately before the execution batch. Each request also
  // revalidates current database safety and roster membership, and the batch has a 4 min budget.
  const batchEvidence = await readWise();
  const skippedPeople = new Set<string>();
  for (const account of run.accounts.filter(a => a.plan === "remove")) {
    if (skippedPeople.has(account.canonicalKey)) continue;
    let unsafe: string | null = null;
    try {
      await requireGrant(viewer, db);
      if (run.mode !== removalMode(options.env)) unsafe = "Removal mode changed during execution.";
      if (clock().getTime() - now.getTime() > 4 * 60_000) unsafe = "Execution time budget reached. Create a new preview for unsent accounts.";
      const [rows, roster] = await Promise.all([loadRows(db, viewer, clock()), (options.readRoster ?? readRemovalRoster)()]);
      const evidence = { roster, sessions: batchEvidence.sessions };
      const row = rows.find(r => r.signals.canonicalKey === account.canonicalKey);
      const identity = await resolveRemovalRoster(db, evidence.roster);
      run = (await getRemovalRun(runId, db))!;
      const pending = await pendingRequestIds(db, runId);
      if (run.accounts.some(a => a.canonicalKey === account.canonicalKey && (pending.teachers.has(a.wiseTeacherId) || (a.wiseUserId !== null && pending.users.has(a.wiseUserId))))) unsafe = "A previous request needs roster reconciliation; no request was sent.";
      const group = identity.groups.find(g => g.canonicalKey === account.canonicalKey);
      const remaining = run.accounts.filter(a => a.canonicalKey === account.canonicalKey && a.status !== "verified");
      unsafe ??= !row?.score.removable ? row?.score.removableBlockedBy ?? "Person is no longer eligible." : personUnsafeReason({
        expected: remaining.map(a => a.accountSnapshot), current: evidence.roster.filter(t => group?.members.some(m => m.wiseTeacherId === t._id)),
        sessions: evidence.sessions, blocked: identity.blocked.has(account.canonicalKey), now: clock() });
    } catch (error) {
      unsafe = error instanceof TutorOffboardingError && error.status === 403 ? "Removal permission was revoked." : "Fresh Wise or eligibility verification failed; no request was sent.";
    }
    if (unsafe) {
      skippedPeople.add(account.canonicalKey);
      await db.update(accounts).set({ status: "skipped", skipReason: unsafe, updatedAt: clock() })
        .where(and(eq(accounts.runId, runId), eq(accounts.canonicalKey, account.canonicalKey), eq(accounts.status, "planned")));
      continue;
    }
    await requireGrant(viewer, db);
    if (run.mode === "manual") {
      await db.update(accounts).set({ status: "manual_required", updatedAt: clock() }).where(and(eq(accounts.id, account.id), eq(accounts.status, "planned")));
      continue;
    }
    // Persist before calling Wise. A crash after this commit may only be reconciled, never resent.
    const started = await db.update(accounts).set({ status: "sending", sentAt: clock(), updatedAt: clock(), requestPayload: { userId: account.wiseUserId } })
      .where(and(eq(accounts.id, account.id), eq(accounts.status, "planned"))).returning({ id: accounts.id });
    if (!started.length) continue;
    const result = await (options.removeParticipant ?? removeWiseParticipantOnce)(account.wiseUserId!);
    await db.update(accounts).set({ ...result, updatedAt: clock() }).where(eq(accounts.id, account.id));
    try {
      const roster = await (options.readRoster ?? readRemovalRoster)(); assertCompleteRoster(roster);
      const present = roster.some(t => t._id === account.wiseTeacherId || (typeof t.userId === "string" ? t.userId : t.userId?._id) === account.wiseUserId);
      await db.update(accounts).set({ status: present ? "not_removed" : "verified", verifiedAt: clock(), updatedAt: clock() }).where(eq(accounts.id, account.id));
      if (present) skippedPeople.add(account.canonicalKey);
    } catch { skippedPeople.add(account.canonicalKey); }
  }
  // Skipped remainder after an unknown/failed partial person cannot get a second request.
  await db.update(accounts).set({ status: "skipped", skipReason: "A previous account could not be verified; reconcile the roster.", updatedAt: clock() })
    .where(and(eq(accounts.runId, runId), eq(accounts.status, "planned")));
  run = (await getRemovalRun(runId, db))!;
  await db.update(runs).set({ status: run.accounts.some(a => a.plan === "remove" && !["verified", "manual_required"].includes(a.status)) ? "applied_with_errors" : "applied", finishedAt: clock() }).where(eq(runs.id, runId));
  // Cleanup is reconciler-owned and Wise read-only. Manual runs keep local state until absence is proven.
  const { reconcileRemovalRuns } = await import("./reconcile");
  await reconcileRemovalRuns(db, await (options.readRoster ?? readRemovalRoster)(), clock());
  return (await getRemovalRun(runId, db))!;
}
