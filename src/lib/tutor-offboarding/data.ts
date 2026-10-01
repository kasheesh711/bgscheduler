import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { buildCalibrationCurve } from "./calibration";
import { scorePerson } from "./score";
import { buildTerminationMatches, type TerminationSnapshot } from "./termination-source";
import type {
  DecisionRecord,
  FeedKey,
  FeedTimestamps,
  FreshnessReport,
  GrantRecord,
  OffboardingDashboardData,
  OffboardingPersonRow,
  OffboardingSignals,
  TutorOffboardingViewer,
} from "./types";

/** OFF-07: how old each feed may be before scores turn provisional. */
export const FEEDS: ReadonlyArray<{ key: FeedKey; label: string; maxAgeHours: number }> = [
  { key: "tutorSnapshot", label: "Wise roster and upcoming classes", maxAgeHours: 2 },
  { key: "progressTests", label: "Class attendance", maxAgeHours: 72 },
  { key: "postClass", label: "Class feedback sessions", maxAgeHours: 72 },
  { key: "wiseActivity", label: "Wise activity", maxAgeHours: 72 },
  { key: "leaveRequests", label: "Leave requests", maxAgeHours: 72 },
];

export function evaluateFreshness(timestamps: FeedTimestamps, now: Date): FreshnessReport {
  const feeds = FEEDS.map(({ key, label, maxAgeHours }) => {
    const lastSuccessAt = timestamps[key];
    const age = lastSuccessAt === null ? NaN : now.getTime() - Date.parse(lastSuccessAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeHours * 3_600_000;
    return { key, label, lastSuccessAt, maxAgeHours, fresh };
  });
  return { ok: feeds.every((feed) => feed.fresh), feeds };
}

/** The latest open (not undone, not expired) decision per canonical key. */
export function openDecisionsByKey(decisions: DecisionRecord[], now: Date): Map<string, DecisionRecord> {
  const open = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.revokedAt !== null || Date.parse(decision.snoozeUntil) <= now.getTime()) continue;
    const current = open.get(decision.canonicalKey);
    if (!current || decision.decidedAt > current.decidedAt) open.set(decision.canonicalKey, decision);
  }
  return open;
}

const byName = (a: OffboardingPersonRow, b: OffboardingPersonRow) => a.signals.displayName.localeCompare(b.signals.displayName);

/** Pure: scores everyone and splits them into the page's lists. */
export function buildOffboardingDashboard(input: {
  signals: OffboardingSignals;
  feeds: FeedTimestamps;
  decisions: DecisionRecord[];
  grants: GrantRecord[] | null;
  viewer: TutorOffboardingViewer;
  now: Date;
  terminationSnapshot?: TerminationSnapshot;
}): OffboardingDashboardData {
  const freshness = evaluateFreshness(input.feeds, input.now);
  // OFF-07: fresh feed metadata cannot bless people loaded from a different snapshot.
  if (input.signals.snapshotCreatedAt !== input.feeds.tutorSnapshot) {
    freshness.ok = false;
    const snapshotFeed = freshness.feeds.find((feed) => feed.key === "tutorSnapshot")!;
    snapshotFeed.fresh = false;
    snapshotFeed.lastSuccessAt = input.signals.snapshotCreatedAt;
  }
  const termination = input.terminationSnapshot
    ? buildTerminationMatches(input.signals.people, input.terminationSnapshot, input.now) : null;
  const curve = buildCalibrationCurve(new Map(Object.entries(input.signals.taughtDates)), bangkokDateKey(input.now));
  const open = openDecisionsByKey(input.decisions, input.now);
  const snoozedKeys = new Set(open.keys());
  const rows: OffboardingPersonRow[] = input.signals.people.map((signals) => ({
    signals,
    score: scorePerson(signals, { now: input.now, curve, snoozedKeys, freshnessOk: freshness.ok }),
    openDecision: open.get(signals.canonicalKey) ?? null,
    ...(termination?.byKey[signals.canonicalKey] ? { termination: termination.byKey[signals.canonicalKey] } : {}),
  }));
  const inbox = rows.filter((row) => !row.score.exclusion && (row.score.band !== "active" || row.termination !== undefined))
    .sort((a, b) => b.score.likelihood - a.score.likelihood || byName(a, b));
  const veryLikely = inbox.filter((row) => row.score.band === "very_likely_gone");
  const names = new Map(input.signals.people.map((person) => [person.canonicalKey, person.displayName]));
  return {
    servedAt: input.now.toISOString(),
    generatedAt: input.signals.generatedAt,
    snapshotCreatedAt: input.signals.snapshotCreatedAt,
    freshness,
    curve,
    inbox,
    activeCount: rows.filter((row) => !row.score.exclusion && row.score.band === "active" && row.termination === undefined).length,
    excluded: rows.filter((row) => row.score.exclusion && row.score.exclusion.code !== "wise_admin").sort(byName),
    staff: rows.filter((row) => row.score.exclusion?.code === "wise_admin").sort(byName),
    decisions: input.decisions.map((decision) => ({ ...decision, displayName: names.get(decision.canonicalKey) ?? decision.canonicalKey })),
    grants: input.grants,
    viewer: input.viewer,
    ...(termination ? { terminationSource: termination.source } : {}),
    summary: {
      veryLikely: veryLikely.length,
      likely: inbox.filter((row) => row.score.band === "likely_gone").length,
      unclear: inbox.filter((row) => row.score.band === "unclear").length,
      veryLikelyAccounts: veryLikely.reduce((total, row) => total + row.signals.accounts.length, 0),
    },
  };
}
