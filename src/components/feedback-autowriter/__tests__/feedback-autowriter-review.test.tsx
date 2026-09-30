import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { ReviewUnavailable } from "../feedback-autowriter-dashboard";
import { FeedbackAutowriterQualityPanel, LowerBoundBar } from "../feedback-autowriter-quality-panel";
import {
  FeedbackAutowriterReviewQueue,
  VerdictForm,
  buildVerdictRequest,
  downgradeFor,
  hasHarshJudgement,
  matchesFilter,
  verdictLabel,
} from "../feedback-autowriter-review-queue";

// Synthetic names and ids only.
const FIELDS = { topics: "Rotation patterns", performance: "Alexander spotted symmetry fast.", improvement: "Colour sequences", homework: "" };
const VERDICT_ID = "11111111-1111-4111-8111-111111111111";
const FLAG_ID = "22222222-2222-4222-8222-222222222222";

function item(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    wiseSessionId: "6a0000000000000000000f01",
    wiseUrl: "https://learn.example.com/links?type=classroom_entity",
    className: "Alexander (Alex.Te) Class",
    tutor: "Thanit (Mimi) Montrikittiphant",
    tutorKey: "Mimi",
    classEndedAt: "2026-09-29T08:00:00.000Z",
    bangkokDate: "2026-09-29",
    inclusionReason: "new_tutor",
    required: true,
    status: "needs_review",
    openFlags: [],
    firstShot: {
      postId: "p1", fields: FIELDS, fieldsSha256: "a".repeat(64), provenance: "backfill", method: "pc_first_version",
      postStartedAt: "2026-09-29T08:39:45.000Z", arm: "luna", evidence: "summary", outcome: "verified", problems: [],
    },
    current: { fields: { ...FIELDS, performance: "Alex spotted symmetry fast." }, source: "correction", at: "2026-09-29T13:26:11.000Z" },
    changed: true,
    diff: [{ field: "performance", segments: [
      { kind: "removed", text: "Alexander" }, { kind: "added", text: "Alex" }, { kind: "same", text: " spotted symmetry fast." },
    ] }],
    corrections: [{ kind: "correction", actor: "script:correct-posts (owner@example.com)", reason: "synthetic correction", outcome: "verified", at: "2026-09-29T13:26:11.000Z", provenance: "backfill" }],
    fixEvents: [
      { wiseEventId: "e1", at: "2026-09-29T08:39:45.495Z", actorKind: "autowriter_first", countsAsFix: false, counted: false },
      { wiseEventId: "e2", at: "2026-09-29T13:26:07.299Z", actorKind: "autowriter_correction", countsAsFix: true, counted: true },
      { wiseEventId: "e3", at: "2026-09-30T13:26:07.299Z", actorKind: "other_staff", countsAsFix: true, counted: false },
    ],
    measuredFixCount: 1,
    measuredFixesByActor: { autowriter_correction: 1 },
    verdicts: [],
    currentVerdict: null,
    ...overrides,
  };
}

const APPROVED: NonNullable<ReviewQueueItem["currentVerdict"]> = {
  id: VERDICT_ID, verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "owner@example.com", source: "dashboard",
  downgradedFrom: null, createdAt: "2026-09-29T15:00:00.000Z", current: true,
};
const CRITICAL: NonNullable<ReviewQueueItem["currentVerdict"]> = {
  ...APPROVED, verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person",
};
const MAJOR: NonNullable<ReviewQueueItem["currentVerdict"]> = { ...APPROVED, verdict: "needs_fix", severity: "factual" };

function review(overrides: Partial<AutowriterReview> = {}): AutowriterReview {
  return {
    available: true,
    generatedAt: "2026-09-30T03:00:00.000Z",
    window: { start: "2026-09-17", end: "2026-09-30", days: 14 },
    gate: {
      status: "head_start", wilsonLower: 0.7225, coverage: 0.889, reasons: ["accuracy lower bound 72.2% < 80% (10/10)"],
      reviewed: 10, accurate: 10, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0, requiredPending: 2,
      unrecordedPosts: 0, unexplainedApiWrites: 0, coverageNum: 8, coverageDen: 9,
      thresholds: { passLowerBound: 0.8, headStartLowerBound: 0.7, minCoverage: 0.7 },
      lastDaily: { date: "2026-09-29", status: "insufficient_data", wilsonLower: 0, createdAt: "2026-09-29T17:27:00.000Z" },
      currentTutors: 5, nextExpansionSize: 8,
    },
    coverage: {
      posted: 8, miss_held: 1, miss_late: 1, miss_expired: 0, miss_failed: 0, miss_unseen: 0, excluded_tutor_first: 5,
      excluded_data_quality: 1, excluded_tutor_off: 0, excluded_not_live: 2, excluded_scope: 0, pending: 0,
    },
    fixRounds: { zero: 2, one: 6, two: 0, threePlus: 0, unresolved: 0 },
    daily: [{
      date: "2026-09-29", liveMode: true, posted: 8, required: 8, reviewed: 0, requiredPending: 8, accurate: 0, cosmetic: 0, factual: 0,
      critical: 0, eligible: 9, coverage: 8 / 9, measuredFixClasses: 6, correctionsVerified: 6,
    }],
    tutors: [{
      tutorKey: "Mimi", displayName: "Thanit (Mimi) Montrikittiphant", phase: "full_review", textsInWise: 6, reviewed: 0, accurate: 0,
      wilsonLower: 0, requiredPending: 6, coverage: 1, coverageNum: 6, coverageDen: 6, measuredFixClasses: 4,
    }],
    queue: [item(), item({ wiseSessionId: "6a0000000000000000000f02", status: "reviewed", changed: false, diff: [], currentVerdict: APPROVED })],
    queueTotals: { needsReview: 1, flagged: 0, all: 2, shown: 2 },
    incidents: [
      { id: "i1", kind: "critical_verdict", severity: "critical", summary: "Critical verdict: Wrong person", wiseSessionId: null, pushStatus: "failed",
        lastPushError: "email: relay down", acknowledgedAt: null, acknowledgedBy: null, createdAt: "2026-09-29T15:00:00.000Z" },
      { id: "i2", kind: "api_actor_unmatched", severity: "critical", summary: "Unmatched API save", wiseSessionId: null, pushStatus: "sent",
        lastPushError: null, acknowledgedAt: "2026-09-30T01:00:00.000Z", acknowledgedBy: "owner@example.com", createdAt: "2026-09-29T16:00:00.000Z" },
    ],
    lastRun: { status: "succeeded", startedAt: "2026-09-30T02:27:00.000Z", finishedAt: "2026-09-30T02:27:09.000Z", errorSummary: null, dailyGateSkipped: "activity_mirror_stale: last successful Wise activity sync never" },
    ...overrides,
  };
}

describe("FeedbackAutowriterQualityPanel", () => {
  it("shows the gate badge, every criterion with its threshold, coverage, daily and per-tutor tables", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterQualityPanel review={review()} />);
    expect(html).toContain("Head start");
    expect(html).toContain("Accuracy lower bound ≥ 80%");
    // A measured ratio is rounded down: 72.25% reads 72.2%, never a rounded-up value.
    expect(html).toContain("72.2% (10/10 accurate)");
    expect(html).toContain("No critical verdicts");
    expect(html).toContain("No unresolved critical flags");
    expect(html).toContain("Coverage ≥ 70%");
    expect(html).toContain("No flagged post waiting for review");
    expect(html).toContain("Every required post reviewed");
    expect(html).toContain("2 waiting");
    expect(html).toContain("Every posted first shot recorded");
    expect(html).toContain("No unexplained API write to Wise");
    expect(html).toContain("5 tutors → next step 8");
    expect(html).toContain("Tutor wrote first");
    expect(html).toContain("Written after our draft");
    expect(html).toContain("Not live (shadow/off)");
    expect(html).toContain("Data quality");
    expect(html).not.toContain("of which absence");
    expect(html).toContain("Cosmetic / major / critical");
    expect(html).toContain("Texts in Wise");
    expect(html).toContain("2026-09-29");
    expect(html).toContain("Every post (new)");
    expect(html).toContain("Critical verdict: Wrong person");
    expect(html).toContain("push FAILED — not delivered");
    expect(html).toContain("acknowledged by owner@example.com");
    expect(html).toContain("nightly gate not recorded yet (activity_mirror_stale");
  });

  it("offers Acknowledge on an unacknowledged critical incident to the owner only", () => {
    const viewer = renderToStaticMarkup(<FeedbackAutowriterQualityPanel review={review()} />);
    const owner = renderToStaticMarkup(<FeedbackAutowriterQualityPanel review={review()} canControl />);
    expect(viewer).not.toContain(">Acknowledge<");
    expect(owner.match(/>Acknowledge</gu)).toHaveLength(1);
  });

  it("marks the 70% head start and 80% pass on the lower-bound bar", () => {
    const html = renderToStaticMarkup(<LowerBoundBar value={0.72} headStart={0.7} pass={0.8} />);
    expect(html).toContain("left:70%");
    expect(html).toContain("left:80%");
    expect(html).toContain("width:72%");
    expect(html).toContain('aria-valuenow="72"');
  });
});

describe("ReviewUnavailable", () => {
  it("says a missing migration and a load failure apart", () => {
    expect(renderToStaticMarkup(<ReviewUnavailable reason="review_tables_missing" />)).toContain("migration 0101");
    const failed = renderToStaticMarkup(<ReviewUnavailable reason="load_failed" />);
    expect(failed).toContain("could not load");
    expect(failed).not.toContain("migration 0101");
  });
});

describe("FeedbackAutowriterReviewQueue", () => {
  it("shows the first shot next to the current text, the diff and the measured saves", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review()} canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("reconstructed · hash-verified");
    expect(html).toContain("the last verified correction");
    expect(html).toContain("<del");
    expect(html).toContain("Alexander");
    expect(html).toContain("<ins");
    expect(html).toContain("Autowriter — correction");
    expect(html).toContain("after approval — not counted");
    expect(html).toContain("Correction by script:correct-posts (owner@example.com)");
    expect(html).toContain("1 measured fix (Autowriter — correction 1)");
    expect(html).toContain("Needs review (1)");
    expect(html).toContain("All (2)");
  });

  it("labels the nickname re-post a policy change, never a fix", () => {
    const policy = item({
      current: { ...item().current, source: "policy" },
      corrections: [{ kind: "policy", actor: "script:nickname-fix (owner@example.com)", reason: "owner naming policy: nickname", outcome: "verified", at: "2026-09-29T13:26:11.000Z", provenance: "backfill" }],
      fixEvents: [
        { wiseEventId: "e1", at: "2026-09-29T08:39:45.495Z", actorKind: "autowriter_first", countsAsFix: false, counted: false },
        { wiseEventId: "e2", at: "2026-09-29T13:26:07.299Z", actorKind: "autowriter_policy", countsAsFix: false, counted: false },
      ],
      measuredFixCount: 0,
      measuredFixesByActor: {},
    });
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review({ queue: [policy] })} canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("the owner&#x27;s policy re-post (not a fix)");
    expect(html).toContain("Autowriter — policy re-post (not a fix)");
    expect(html).toContain("Policy re-post (not a fix) by script:nickname-fix (owner@example.com)");
    expect(html).not.toContain("· fix</strong>");
    expect(html).not.toContain("Correction by");
  });

  it("says Wise holds no text when Class Feedback last read none there, the first shot's text struck out", () => {
    const cleared = item({
      current: { fields: { topics: "", performance: "", improvement: "", homework: "" }, source: "wise_no_text", at: "2026-09-30T02:13:00.000Z" },
      diff: [{ field: "topics", segments: [{ kind: "removed", text: FIELDS.topics }] }],
    });
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review({ queue: [cleared] })} canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("none in Wise, as Class Feedback last read it");
    expect(html).toContain(`${FIELDS.topics}</del>`);
    expect(html).not.toContain("unchanged since the first post");
  });

  it("counts the filters from the database totals and says when the queue is a subset", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review({ queueTotals: { needsReview: 40, flagged: 3, all: 350, shown: 2 } })}
      canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("Needs review (40)");
    expect(html).toContain("Flagged (3)");
    expect(html).toContain("Showing 2 of 350");
  });

  it("names the first shot's writer by its arm: a Sol draft as Sol, never GLM", () => {
    const html = (arm: string) => renderToStaticMarkup(<FeedbackAutowriterReviewQueue
      review={review({ queue: [item({ firstShot: { ...item().firstShot, arm } })] })} canControl={false} onRecorded={() => undefined} />);
    expect(html("sol")).toContain("· GPT-6.1 Sol");
    expect(html("sol")).not.toContain("GLM Flash");
    expect(html("luna")).toContain("· GPT-6 Luna");
    expect(html("glm")).toContain("· GLM Flash");
  });

  it("warns when a first shot landed in Wise without verifying", () => {
    const landed = item({ firstShot: { ...item().firstShot, outcome: "verify_failed", problems: ["session_credit_entries_2"] } });
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review({ queue: [landed] })} canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("Landed but did not verify");
    expect(html).toContain("session_credit_entries_2");
  });

  it("gives Approve / Needs fix only to the owner; everyone else reads", () => {
    const viewer = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review()} canControl={false} onRecorded={() => undefined} />);
    const owner = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review()} canControl onRecorded={() => undefined} />);
    expect(viewer).not.toContain("verdict-controls");
    expect(viewer).not.toContain(">Approve<");
    expect(viewer).toContain("Read-only: only Kevin records verdicts.");
    expect(owner).toContain("verdict-controls");
    expect(owner).toContain(">Approve<");
    expect(owner).toContain("Needs fix");
  });

  it("filters: required-unreviewed, flagged, all", () => {
    const flagged = item({ status: "flagged", openFlags: [{ id: FLAG_ID, source: "measured_fix", note: "Tutor saved", suggestedSeverity: null, suggestedCategory: null, createdAt: "2026-09-29T16:00:00.000Z" }] });
    expect(matchesFilter(item(), "required")).toBe(true);
    expect(matchesFilter(item({ currentVerdict: APPROVED }), "required")).toBe(false);
    expect(matchesFilter(item({ required: false, inclusionReason: "not_sampled" }), "required")).toBe(false);
    expect(matchesFilter(flagged, "flagged")).toBe(true);
    expect(matchesFilter(item(), "flagged")).toBe(false);
    expect(matchesFilter(item(), "all")).toBe(true);
  });
});

describe("VerdictForm", () => {
  it("starts Needs fix with no severity chosen and cannot record until one is", () => {
    const html = renderToStaticMarkup(<VerdictForm item={item()} onRecorded={() => undefined} initialMode="needs_fix" />);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a severity…<\/option>/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record needs fix<\/button>/u);
    expect(html).toContain("Major (real fix)");
    expect(html).not.toContain("Factual (real fix)");
  });

  it("labels the stored factual severity as the owner's major", () => {
    expect(verdictLabel(MAJOR)).toBe("Needs fix · Major (real fix)");
    expect(verdictLabel({ ...APPROVED, downgradedFrom: "critical" })).toBe("Approved (downgraded from critical)");
    expect(verdictLabel({ ...APPROVED, verdict: "needs_fix", severity: "cosmetic", downgradedFrom: "factual" })).toBe("Needs fix · cosmetic (downgraded from major)");
  });
});

describe("buildVerdictRequest", () => {
  const form = { severity: null, category: null, note: "", downgradeConfirmed: false };

  it("never defaults a Needs fix to a severity", () => {
    expect(buildVerdictRequest(item(), "needs_fix", form)).toEqual({ ok: false, error: "Choose a severity." });
    expect(buildVerdictRequest(item(), "needs_fix", { ...form, severity: "critical" })).toEqual({ ok: false, error: "Choose the critical category." });
  });

  it("pins the verdict to what the page showed: first shot, current verdict and open flags", () => {
    const flagged = item({ currentVerdict: APPROVED, openFlags: [{ id: FLAG_ID, source: "measured_fix", note: null, suggestedSeverity: null, suggestedCategory: null, createdAt: "2026-09-30T00:00:00.000Z" }] });
    expect(buildVerdictRequest(flagged, "needs_fix", { ...form, severity: "factual", note: " real fix " })).toEqual({ ok: true, body: {
      wiseSessionId: "6a0000000000000000000f01", fieldsSha256: "a".repeat(64), currentVerdictId: VERDICT_ID, seenFlagIds: [FLAG_ID],
      verdict: "needs_fix", severity: "factual", criticalCategory: null, note: "real fix",
    } });
  });

  it("turns a milder verdict on a critical or major judgement into a confirmed downgrade with a note", () => {
    const critical = item({ currentVerdict: CRITICAL });
    const major = item({ currentVerdict: MAJOR });
    const suggested = item({ openFlags: [{ id: FLAG_ID, source: "system", note: null, suggestedSeverity: "critical", suggestedCategory: "billing_status", createdAt: "2026-09-30T00:00:00.000Z" }] });
    expect([hasHarshJudgement(critical), hasHarshJudgement(major), hasHarshJudgement(suggested), hasHarshJudgement(item())]).toEqual([true, true, true, false]);
    expect(downgradeFor(major, "needs_fix", "factual")).toBeNull();
    expect(downgradeFor(major, "needs_fix", "cosmetic")).toBe("factual");
    expect(buildVerdictRequest(critical, "approve", form)).toEqual({ ok: false, error: "A downgrade from critical needs a note saying why." });
    expect(buildVerdictRequest(critical, "approve", { ...form, note: "misclick" })).toEqual({ ok: false, error: "Confirm the downgrade from critical." });
    const request = buildVerdictRequest(critical, "approve", { ...form, note: "misclick", downgradeConfirmed: true });
    expect(request).toMatchObject({ ok: true, body: { verdict: "approve", confirmDowngrade: true, note: "misclick" } });
    // Approving a class judged major after its fix would quietly make the first shot accurate: it is a downgrade too.
    expect(buildVerdictRequest(major, "approve", form)).toEqual({ ok: false, error: "A downgrade from major needs a note saying why." });
    // Re-recording the same judgement (e.g. to answer a new flag) and critical to critical are no downgrades.
    expect(buildVerdictRequest(major, "needs_fix", { ...form, severity: "factual" })).toMatchObject({ ok: true });
    expect(buildVerdictRequest(critical, "needs_fix", { ...form, severity: "critical", category: "invented_content" })).toMatchObject({ ok: true });
  });
});
