import type { RemovalRunDetail } from "@/lib/tutor-offboarding/removal-types";
import { scorePerson } from "@/lib/tutor-offboarding/score";
import { buildOffboardingDashboard } from "@/lib/tutor-offboarding/data";
import type {
  DecisionRecord,
  FeedTimestamps,
  OffboardingAccount,
  OffboardingDashboard,
  OffboardingDashboardData,
  PersonSignals,
  TutorOffboardingViewer,
} from "@/lib/tutor-offboarding/types";

// Made-up people and @example.com addresses only: never real tutors.

export const FIXTURE_NOW = new Date("2026-10-01T05:00:00.000Z");
export const OWNER: TutorOffboardingViewer = { email: "owner@example.com", isOwner: true, canRemove: true };
export const ADMIN: TutorOffboardingViewer = { email: "admin@example.com", isOwner: false, canRemove: false };

const FRESH: FeedTimestamps = {
  tutorSnapshot: "2026-10-01T04:48:00.000Z",
  progressTests: "2026-10-01T02:57:00.000Z",
  postClass: "2026-10-01T03:13:00.000Z",
  wiseActivity: "2026-10-01T03:02:00.000Z",
  leaveRequests: "2026-10-01T03:15:00.000Z",
};

function daysBefore(days: number): string {
  return new Date(FIXTURE_NOW.getTime() - days * 86_400_000).toISOString();
}

function dayKey(days: number): string {
  return daysBefore(days).slice(0, 10);
}

function account(name: string, overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: `t-${name.toLowerCase()}`, wiseUserId: `u-${name.toLowerCase()}`, displayName: `${name} (${name})`, isOnlineVariant: false,
    email: `${name.toLowerCase()}@example.com`, status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z",
    courseCount: 2, activated: true, availabilityKnown: true, workingHourWindows: 3, ...overrides,
  };
}

function person(name: string, overrides: Partial<PersonSignals> = {}): PersonSignals {
  const lastTaughtAt = overrides.lastTaughtAt === undefined ? daysBefore(120) : overrides.lastTaughtAt;
  return {
    canonicalKey: name, displayName: name, accounts: [account(name)], lastTaughtAt,
    lastTaughtBySource: { ledger: lastTaughtAt, pastBlocks: lastTaughtAt, postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null,
    fullTime: false, ...overrides,
  };
}

const PEOPLE: PersonSignals[] = [
  person("Aria", { lastTaughtAt: null, accounts: [account("Aria", { workingHourWindows: 0, courseCount: 0, activated: false })] }),
  person("Bodhi", { accounts: [account("Bodhi", { workingHourWindows: 0 }), account("Bodhi", { wiseTeacherId: "t-bodhi-on", isOnlineVariant: true, displayName: "Bodhi (Bodhi) Online", email: "bodhi.online@example.com", workingHourWindows: 0 })] }),
  person("Cleo", { lastTaughtAt: daysBefore(160) }),
  person("Dara", { lastTaughtAt: daysBefore(35) }),
  person("Lena", { lastTaughtAt: daysBefore(50) }),
  person("Emil", { lastTaughtAt: daysBefore(70), lastTeacherActionAt: daysBefore(6) }),
  person("Fern", { upcomingSessions: 6, nextSessionAt: "2026-10-02T03:00:00.000Z", lastTaughtAt: daysBefore(1) }),
  person("Gus", { accounts: [account("Gus", { relation: "ADMIN" })], lastAdminActionAt: daysBefore(1), lastTaughtAt: daysBefore(40) }),
  person("Hana", { accounts: [account("Hana", { relation: "ADMIN" })], lastTaughtAt: null }),
  person("Ivo", { lastTaughtAt: daysBefore(150) }),
  person("Juno", { lastTaughtAt: null, accounts: [account("Juno", { joinedOn: daysBefore(20) })] }),
  person("Kai", { lastTaughtAt: daysBefore(3) }),
];

/** Weekly class dates from `fromDays` down to (at least) `toDays` days before FIXTURE_NOW. */
function weekly(fromDays: number, toDays: number): string[] {
  const days: string[] = [];
  for (let day = fromDays; day >= toDays; day -= 7) days.push(dayKey(day));
  return days;
}

// A history shaped like the real one (1 Oct 2026): 40 tutors teach weekly, 6 came back after a 30-62 day break,
// 14 stopped for good 95+ days ago. Curve: 60+ days idle → 91% never came back, based on 60 tutors.
const TAUGHT: Record<string, string[]> = Object.fromEntries([
  ...Array.from({ length: 40 }, (_, index) => [`weekly-${index}`, weekly(200, index % 7)]),
  ...[30, 35, 40, 45, 50, 62].map((gap, index) => [`returned-${index}`, [...weekly(200, 130), ...weekly(130 - gap, 3)]]),
  ...Array.from({ length: 14 }, (_, index) => [`left-${index}`, weekly(200, 95 + index * 5)]),
]);

const DECISIONS: DecisionRecord[] = [
  { id: "d-ivo", canonicalKey: "Ivo", note: "Back after his exams in January", snoozeUntil: "2026-12-29T05:00:00.000Z", likelihoodAtDecision: 96,
    bandAtDecision: "very_likely_gone", reasons: ["Last class 150 days ago (4 May)"], decidedByEmail: "admin@example.com",
    decidedAt: "2026-09-30T05:00:00.000Z", revokedAt: null, revokedByEmail: null },
  { id: "d-kai", canonicalKey: "Kai", note: null, snoozeUntil: "2026-12-01T05:00:00.000Z", likelihoodAtDecision: 72,
    bandAtDecision: "likely_gone", reasons: ["Last class 33 days ago (27 Jul)"], decidedByEmail: "admin@example.com",
    decidedAt: "2026-09-02T05:00:00.000Z", revokedAt: "2026-09-10T05:00:00.000Z", revokedByEmail: "owner@example.com" },
];

function build(viewer: TutorOffboardingViewer, feeds: FeedTimestamps, people: PersonSignals[]): OffboardingDashboardData {
  return buildOffboardingDashboard({
    signals: { snapshotId: "snap", snapshotCreatedAt: "2026-10-01T04:48:00.000Z", generatedAt: "2026-10-01T04:50:00.000Z", people, taughtDates: TAUGHT },
    feeds,
    decisions: DECISIONS,
    grants: viewer.isOwner ? [{ email: "ops@example.com", grantedByEmail: "owner@example.com", grantedAt: "2026-09-30T02:00:00.000Z" }] : null,
    viewer,
    now: FIXTURE_NOW,
  });
}

export function dashboardFixture(viewer: TutorOffboardingViewer = OWNER): OffboardingDashboardData {
  return build(viewer, FRESH, PEOPLE);
}

export function staleDashboardFixture(): OffboardingDashboardData {
  return build(OWNER, { ...FRESH, tutorSnapshot: "2026-09-30T20:00:00.000Z", leaveRequests: null }, PEOPLE);
}

export function emptyDashboardFixture(): OffboardingDashboardData {
  return build(OWNER, FRESH, PEOPLE.filter((signals) => ["Fern", "Gus", "Kai"].includes(signals.canonicalKey)));
}

export function notSetUpFixture(): OffboardingDashboard {
  return { available: false, reason: "not_set_up", viewer: ADMIN };
}

/** Synthetic confirmation evidence; no private Sheet content enters the preview. */
export function confirmedDashboardFixture(viewer: TutorOffboardingViewer = OWNER): OffboardingDashboardData {
  const data = dashboardFixture(viewer);
  const proof = (sourceRow: number, sourceName: string) => ({ sourceRow, sourceName, checkedAt: "2026-10-01T04:45:00.000Z", sourceUrl: "https://example.com/tutors", match: "email" as const });
  for (const row of [...data.inbox, ...data.excluded, ...data.staff]) {
    if (["Aria", "Fern", "Gus"].includes(row.signals.canonicalKey)) row.termination = proof(row.signals.canonicalKey === "Aria" ? 12 : 13, `${row.signals.displayName} Fictional`);
  }
  const signals = PEOPLE.find((person) => person.canonicalKey === "Kai")!;
  data.inbox.push({ signals, score: scorePerson(signals, { now: FIXTURE_NOW, curve: data.curve, snoozedKeys: new Set(), freshnessOk: true }), openDecision: null, termination: proof(14, "Kai Fictional") });
  data.terminationSource = { status: "ready", checkedAt: "2026-10-01T04:45:00.000Z", sourceUrl: "https://example.com/tutors", confirmedRows: 5, matchedPeople: 4, unmatched: [{ sourceRow: 15, sourceName: "Nori Fictional", reason: "No matching Wise account" }] };
  return data;
}

export function removalRunFixture(mode: "manual" | "live" = "manual", status: RemovalRunDetail["status"] = "previewed"): RemovalRunDetail {
  const candidates = dashboardFixture().inbox.filter((row) => ["Aria", "Bodhi"].includes(row.signals.canonicalKey));
  const runId = "00000000-0000-4000-8000-000000000001";
  const accounts: RemovalRunDetail["accounts"] = candidates.flatMap((row) => row.signals.accounts.map((account, index) => ({
    id: `${row.signals.canonicalKey}-${index}`, runId, canonicalKey: row.signals.canonicalKey, displayName: row.signals.displayName,
    wiseTeacherId: account.wiseTeacherId, wiseUserId: account.wiseUserId, isOnlineVariant: account.isOnlineVariant,
    accountSnapshot: { _id: account.wiseTeacherId, userId: { _id: account.wiseUserId ?? "fictional-user", name: account.displayName, email: account.email ?? "fictional@example.com" }, relation: "TEACHER", joinedOn: account.joinedOn ?? undefined, classes: [] },
    likelihoodAtPreview: row.score.likelihood, reasons: row.score.reasons.map((reason) => reason.text), plan: "remove" as const, skipReason: null,
    status: status === "previewed" ? "planned" as const : mode === "manual" ? "manual_required" as const : "verified" as const,
    errorMessage: null, sentAt: status !== "previewed" && mode === "live" ? FIXTURE_NOW.toISOString() : null, verifiedAt: null, localStateBefore: null,
  })));
  return { id: runId, status, mode, reason: status === "previewed" ? null : "Confirmed departure by owner", previewToken: "fictional-preview-token", previewExpiresAt: "2026-10-01T05:15:00.000Z", tutorCount: 2, accountCount: 3, createdByEmail: "owner@example.com", createdAt: FIXTURE_NOW.toISOString(), appliedByEmail: status === "previewed" ? null : "owner@example.com", appliedAt: status === "previewed" ? null : FIXTURE_NOW.toISOString(), finishedAt: status === "previewed" || status === "applying" ? null : FIXTURE_NOW.toISOString(), accounts };
}

export function partialRemovalRunFixture(): RemovalRunDetail {
  const run = removalRunFixture("live", "applied_with_errors");
  run.accounts[1].status = "unknown";
  run.accounts[1].errorMessage = "The response was not confirmed";
  run.accounts[2].status = "not_removed";
  return run;
}
