// ── Shadow-review activation evidence ───────────────────────────────────
//
// The last onboarding check before the feature can start deducting ฿100 from
// real tutors' pay. It answers one question: has the *current* Wise form
// mapping been proven to read production correctly?
//
// It used to require `metadata.outcome === "success"`, which meant "this run
// recorded no source issue of any kind". That conflated pipeline health with
// per-row data tidiness — the one place in the codebase that does, since every
// other money-adjacent gate (`assertPayoutRunPublishable`,
// `revalidateDeductionCandidate`) filters to `scope = 'global'`. One session
// with an ambiguous tutor identity, or one deleted in Wise, marked the whole
// run untrustworthy and blocked activation permanently. It also bought nothing:
// `evaluateSessionCompliance` already returns `assessed: false,
// deductionCandidate: false` for any session whose `sourceStatus !== "ready"`,
// so such a session cannot produce a deduction whatever this gate decides.
//
// What replaces it is both looser and stricter. Session-scoped messiness is
// judged as a *rate* an access manager may acknowledge, exactly as
// `assertPayoutRunPublishable` handles pending reviews. Run-level health is
// absolute, and now includes two conditions the old gate lacked: the mapping
// must be observed parsing a real payload, and no blocking global issue may be
// open *right now* rather than merely absent from one historical run.

/** Sessions must resolve at this rate before the gate passes unacknowledged. */
const MIN_RESOLVABLE_RATIO = 0.8;
/** Recent candidates must be readable from Wise at this rate. */
const MIN_READABLE_RATIO = 0.8;
/**
 * Below this many recent eligible sessions there is not enough evidence to
 * judge, and a small sample could pass on luck. Sized to observed volume of
 * ~50-70 eligible sessions a day; a judgement call, not a derived figure.
 */
const MIN_RECENT_SAMPLE = 20;

export interface PostClassShadowSyncEvidence {
  id: string;
  finishedAt: Date | null;
  detailFetchedCount: number;
  sessionCount: number;
  assessedCount: number;
  metadata: Record<string, unknown>;
}

export type PostClassShadowConditionKey =
  | "run_present"
  | "global_source_healthy"
  | "mapping_observed_healthy"
  | "no_open_global_issues"
  | "detail_fetched"
  | "sessions_seen"
  | "sessions_assessed"
  | "recent_sample"
  | "readable_rate"
  | "resolvable_rate";

export interface PostClassShadowCondition {
  key: PostClassShadowConditionKey;
  passed: boolean;
  /** Human-readable, safe to show an operator verbatim. */
  detail: string;
  /**
   * Present only on acknowledgeable conditions: the exact count the operator
   * must echo back. A stale tab must not wave through a number that has grown.
   */
  acknowledgeCount?: number;
}

export interface PostClassShadowReviewVerdict {
  evidence: PostClassShadowSyncEvidence | null;
  conditions: PostClassShadowCondition[];
  blockedBy: PostClassShadowCondition[];
  acknowledgeable: PostClassShadowCondition[];
  /** Exact total an acknowledgement must echo, or 0 when nothing is waivable. */
  acknowledgeableTotal: number;
  ready: boolean;
}

export interface PostClassShadowReviewInput {
  policyVersion: number;
  mappingVersion: number;
  mappingUpdatedAt: Date;
  /** Live count, not a historical per-run figure. */
  openBlockingGlobalIssues: number;
  /**
   * Persisted state over the trailing collector window — the period whose
   * behaviour predicts the period about to be enforced.
   */
  recentReadiness: { eligible: number; ready: number };
  acknowledgements?: {
    sessionIssues?: number;
    reason?: string;
  };
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return typeof value === "number" ? value : Number(value);
}

/**
 * The newest run that could serve as evidence, before judging its quality.
 *
 * Version and freshness decide *which* run to judge, not how good it is: a run
 * against a superseded mapping is not weak evidence, it is evidence about a
 * different configuration. Selecting it and then failing it would report a
 * misleading reason.
 */
function selectCandidateRun(
  runs: PostClassShadowSyncEvidence[],
  input: PostClassShadowReviewInput,
): PostClassShadowSyncEvidence | null {
  return runs.find((run) =>
    run.finishedAt !== null
    && run.finishedAt.getTime() >= input.mappingUpdatedAt.getTime()
    && metadataNumber(run.metadata, "policyVersion") === input.policyVersion
    && metadataNumber(run.metadata, "mappingVersion") === input.mappingVersion) ?? null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const ACKNOWLEDGEABLE_KEYS: readonly PostClassShadowConditionKey[] = [
  "readable_rate",
  "resolvable_rate",
];

/**
 * Judge whether a shadow sync proves the pipeline is ready for live enforcement.
 *
 * Pure — the caller supplies the live open-issue count. Every condition is
 * reported whether or not it passed, so the UI can render a checklist instead
 * of one undifferentiated failure string.
 *
 * Fails closed on missing metadata: a run predating these fields cannot prove
 * anything, and the remedy is one fresh shadow sync.
 */
export function classifyPostClassShadowReviewEvidence(
  runs: PostClassShadowSyncEvidence[],
  input: PostClassShadowReviewInput,
): PostClassShadowReviewVerdict {
  const conditions: PostClassShadowCondition[] = [];
  const run = selectCandidateRun(runs, input);

  if (!run) {
    conditions.push({
      key: "run_present",
      passed: false,
      detail: "No completed shadow sync has run against the current Wise form mapping and policy"
        + " version. Run one from Settings, then inspect the collected sessions.",
    });
    return {
      evidence: null,
      conditions,
      blockedBy: conditions,
      acknowledgeable: [],
      acknowledgeableTotal: 0,
      ready: false,
    };
  }

  conditions.push({
    key: "run_present",
    passed: true,
    detail: `Evidence: sync run finished ${run.finishedAt?.toISOString() ?? "unknown"}.`,
  });

  const globalHealthy = run.metadata.globalSourceHealthy === true;
  conditions.push({
    key: "global_source_healthy",
    passed: globalHealthy,
    detail: globalHealthy
      ? "Wise source health was proven run-wide."
      : "That run could not prove Wise source health run-wide (a blocking global issue or form"
        + " drift). Fix the source, then run a fresh shadow sync.",
  });

  const mappingHealthy = run.metadata.mappingObservedHealthy === true;
  conditions.push({
    key: "mapping_observed_healthy",
    passed: mappingHealthy,
    detail: mappingHealthy
      ? "The current mapping parsed real Wise payloads with no drift."
      : "The current mapping was never observed parsing a Wise payload cleanly in that run."
        + " Check the field mapping, then run a fresh shadow sync.",
  });

  const noOpenGlobal = input.openBlockingGlobalIssues === 0;
  conditions.push({
    key: "no_open_global_issues",
    passed: noOpenGlobal,
    detail: noOpenGlobal
      ? "No blocking global source issue is open."
      : `${input.openBlockingGlobalIssues} blocking global source issue`
        + `${input.openBlockingGlobalIssues === 1 ? " is" : "s are"} still open.`
        + " Resolve them before confirming.",
  });

  conditions.push({
    key: "detail_fetched",
    passed: run.detailFetchedCount > 0,
    detail: run.detailFetchedCount > 0
      ? `${run.detailFetchedCount} session details fetched from Wise.`
      : "That run fetched no session detail from Wise, so it proves nothing.",
  });

  conditions.push({
    key: "sessions_seen",
    passed: run.sessionCount > 0,
    detail: run.sessionCount > 0
      ? `${run.sessionCount} sessions observed.`
      : "That run observed no sessions. Run a shadow sync over dates that contain classes.",
  });

  conditions.push({
    key: "sessions_assessed",
    passed: run.assessedCount > 0,
    detail: run.assessedCount > 0
      ? `${run.assessedCount} sessions assessed.`
      : "That run assessed no sessions, so compliance was never exercised.",
  });

  // Both rates below are scoped to the recent collector window. Measured over
  // a run's whole candidate pool instead, they are dominated by the unbounded
  // event and recheck lanes: in production a run routinely observes nineteen
  // months-old sessions and one current one, so the unscoped rate described a
  // historical backlog that can never be enforced. Sessions ending before the
  // activation instant are assessed but can never produce a deduction.
  const { eligible: recentEligible, ready: recentReady } = input.recentReadiness;
  const enoughRecent = recentEligible >= MIN_RECENT_SAMPLE;
  conditions.push({
    key: "recent_sample",
    passed: enoughRecent,
    detail: enoughRecent
      ? `${recentEligible} eligible sessions in the recent window to judge on.`
      : `Only ${recentEligible} eligible sessions in the recent window — too few to prove the`
        + " pipeline works. Let the collector run over a period that contains classes.",
  });

  const rollingSelected = metadataNumber(run.metadata, "rollingSelectedCount");
  const rollingSaved = metadataNumber(run.metadata, "rollingSavedCount");
  // Fail closed on absent metadata and on a zero denominator alike. A run that
  // read nothing recent has proven nothing, and treating that as a pass would
  // make this gate weaker than the one it replaced.
  const hasRollingCounts = Number.isFinite(rollingSelected) && Number.isFinite(rollingSaved);
  const readableRatio = ratio(rollingSaved, rollingSelected);
  const unreadable = hasRollingCounts ? Math.max(0, rollingSelected - rollingSaved) : 0;
  const readable = hasRollingCounts
    && rollingSelected > 0
    && readableRatio >= MIN_READABLE_RATIO;
  conditions.push({
    key: "readable_rate",
    passed: readable,
    detail: readable
      ? `${percent(readableRatio)} of recent sessions were readable from Wise`
        + ` (${rollingSaved} of ${rollingSelected}; the run also touched`
        + ` ${metadataNumber(run.metadata, "candidateCount") || run.sessionCount} older candidates,`
        + " which are not judged here)."
      : !hasRollingCounts
        ? "That run predates recent-window reporting. Run a fresh shadow sync."
        : rollingSelected === 0
          ? "That run read no sessions from the recent window, so it proves nothing about the"
            + " period about to be enforced. Run a fresh shadow sync."
          : `Only ${percent(readableRatio)} of ${rollingSelected} recent sessions could be read`
            + ` from Wise (${unreadable} failed). That usually means a Wise access or contract`
            + " problem rather than messy data.",
    ...(readable ? {} : { acknowledgeCount: unreadable }),
  });

  const resolvableRatio = ratio(recentReady, recentEligible);
  const unresolved = Math.max(0, recentEligible - recentReady);
  const resolvable = enoughRecent && resolvableRatio >= MIN_RESOLVABLE_RATIO;
  conditions.push({
    key: "resolvable_rate",
    passed: resolvable,
    detail: resolvable
      ? `${percent(resolvableRatio)} of recent eligible sessions resolved cleanly`
        + ` (${recentReady} of ${recentEligible}).`
      : `${unresolved} of ${recentEligible} recent eligible sessions could not be resolved to a`
        + " tutor and billing evidence. A few is normal; this many usually means tutor aliases or"
        + " billing mapping need attention.",
    ...(resolvable ? {} : { acknowledgeCount: unresolved }),
  });

  const failed = conditions.filter((condition) => !condition.passed);
  const acknowledgeable = failed.filter((condition) =>
    ACKNOWLEDGEABLE_KEYS.includes(condition.key));
  const absolute = failed.filter((condition) => !ACKNOWLEDGEABLE_KEYS.includes(condition.key));
  const acknowledgeableTotal = acknowledgeable.reduce(
    (total, condition) => total + (condition.acknowledgeCount ?? 0),
    0,
  );

  // Clears the rate conditions only by echoing the exact total the server just
  // computed, with a reason. Mirrors `assertPayoutRunPublishable`.
  const acknowledged = acknowledgeable.length > 0
    && input.acknowledgements?.sessionIssues === acknowledgeableTotal
    && (input.acknowledgements?.reason?.trim().length ?? 0) > 0;

  const blockedBy = acknowledged ? absolute : [...absolute, ...acknowledgeable];
  return {
    evidence: run,
    conditions,
    blockedBy,
    acknowledgeable,
    acknowledgeableTotal,
    ready: blockedBy.length === 0,
  };
}
