import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutowriterReview, ReviewQueueItem } from "@/lib/feedback-autowriter/review-data";
import { FeedbackAutowriterQualityPanel, LowerBoundBar } from "../feedback-autowriter-quality-panel";
import { FeedbackAutowriterReviewQueue, matchesFilter } from "../feedback-autowriter-review-queue";

const FIELDS = { topics: "Rotation patterns", performance: "Pasorn spotted symmetry fast.", improvement: "Colour sequences", homework: "" };

function item(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    wiseSessionId: "6aba47d069f1f327513ac027",
    wiseUrl: "https://learn.begiftededucation.com/links?type=classroom_entity",
    className: "Pasorn (Tann.Ch) Class",
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
      postStartedAt: "2026-09-29T08:39:45.000Z", arm: "luna", evidence: "summary",
    },
    current: { fields: { ...FIELDS, performance: "Tann spotted symmetry fast." }, source: "correction", at: "2026-09-29T13:26:11.000Z" },
    changed: true,
    diff: [{ field: "performance", segments: [
      { kind: "removed", text: "Pasorn" }, { kind: "added", text: "Tann" }, { kind: "same", text: " spotted symmetry fast." },
    ] }],
    corrections: [{ actor: "script:nickname-fix (kevhsh7@gmail.com)", reason: "owner naming policy: nickname", outcome: "verified", at: "2026-09-29T13:26:11.000Z", provenance: "backfill" }],
    fixEvents: [
      { wiseEventId: "e1", at: "2026-09-29T08:39:45.495Z", actorKind: "autowriter_first", countsAsFix: false },
      { wiseEventId: "e2", at: "2026-09-29T13:26:07.299Z", actorKind: "autowriter_correction", countsAsFix: true },
    ],
    measuredFixCount: 1,
    verdicts: [],
    currentVerdict: null,
    ...overrides,
  };
}

function review(overrides: Partial<AutowriterReview> = {}): AutowriterReview {
  return {
    generatedAt: "2026-09-30T03:00:00.000Z",
    window: { start: "2026-09-17", end: "2026-09-30", days: 14 },
    gate: {
      status: "head_start", wilsonLower: 0.7225, coverage: 0.889, reasons: ["accuracy lower bound 72.3% < 80% (10/10)"],
      reviewed: 10, accurate: 10, criticalVerdicts: 0, unresolvedCriticalFlags: 0, pendingFlaggedReviews: 0, coverageNum: 8, coverageDen: 9,
      thresholds: { passLowerBound: 0.8, headStartLowerBound: 0.7, minCoverage: 0.7 },
      lastDaily: { date: "2026-09-29", status: "insufficient_data", wilsonLower: 0, createdAt: "2026-09-29T17:27:00.000Z" },
      currentTutors: 5, nextExpansionSize: 8,
    },
    coverage: {
      posted: 8, miss_held: 1, miss_expired: 0, miss_failed: 0, miss_unseen: 0, excluded_tutor_first: 5, excluded_absent: 0,
      excluded_tutor_off: 0, excluded_scope: 0, pending: 0,
    },
    fixRounds: { zero: 2, one: 6, two: 0, threePlus: 0, unresolved: 0 },
    daily: [{
      date: "2026-09-29", liveMode: true, posted: 8, required: 8, reviewed: 0, requiredPending: 8, accurate: 0, cosmetic: 0, factual: 0,
      critical: 0, eligible: 9, coverage: 8 / 9, measuredFixClasses: 6, correctionsVerified: 6,
    }],
    tutors: [{
      tutorKey: "Mimi", displayName: "Thanit (Mimi) Montrikittiphant", phase: "full_review", posted: 6, reviewed: 0, accurate: 0,
      wilsonLower: 0, requiredPending: 6, coverage: 1, coverageNum: 6, coverageDen: 6, measuredFixClasses: 4,
    }],
    queue: [item(), item({ wiseSessionId: "6ab89191c10615490d43a8cf", status: "reviewed", changed: false, diff: [], currentVerdict: {
      id: "v1", verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "kevhsh7@gmail.com", source: "dashboard",
      createdAt: "2026-09-29T15:00:00.000Z", current: true,
    } })],
    incidents: [{ id: "i1", kind: "critical_verdict", severity: "critical", summary: "Critical verdict: Wrong person", wiseSessionId: null, pushStatus: "pending", lastPushError: "email: relay down", createdAt: "2026-09-29T15:00:00.000Z" }],
    lastRun: { status: "succeeded", startedAt: "2026-09-30T02:27:00.000Z", finishedAt: "2026-09-30T02:27:09.000Z", errorSummary: null },
    ...overrides,
  };
}

describe("FeedbackAutowriterQualityPanel", () => {
  it("shows the gate badge, every criterion with its threshold, coverage, daily and per-tutor tables", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterQualityPanel review={review()} />);
    expect(html).toContain("Head start");
    expect(html).toContain("Accuracy lower bound ≥ 80%");
    expect(html).toContain("72.3% (10/10 accurate)");
    expect(html).toContain("No critical verdicts");
    expect(html).toContain("No unresolved critical flags");
    expect(html).toContain("Coverage ≥ 70%");
    expect(html).toContain("No flagged post waiting for review");
    expect(html).toContain("5 tutors → next step 8");
    expect(html).toContain("Tutor wrote first");
    expect(html).toContain("2026-09-29");
    expect(html).toContain("Every post (new)");
    expect(html).toContain("Critical verdict: Wrong person");
    expect(html).toContain("push pending");
  });

  it("marks the 70% head start and 80% pass on the lower-bound bar", () => {
    const html = renderToStaticMarkup(<LowerBoundBar value={0.72} headStart={0.7} pass={0.8} />);
    expect(html).toContain("left:70%");
    expect(html).toContain("left:80%");
    expect(html).toContain("width:72%");
    expect(html).toContain('aria-valuenow="72"');
  });
});

describe("FeedbackAutowriterReviewQueue", () => {
  it("shows the first shot next to the current text, the diff and the measured saves", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterReviewQueue review={review()} canControl={false} onRecorded={() => undefined} />);
    expect(html).toContain("reconstructed · hash-verified");
    expect(html).toContain("the last verified correction");
    expect(html).toContain("<del");
    expect(html).toContain("Pasorn");
    expect(html).toContain("<ins");
    expect(html).toContain("Autowriter — correction");
    expect(html).toContain("Correction by script:nickname-fix (kevhsh7@gmail.com)");
    expect(html).toContain("Needs review (1)");
    expect(html).toContain("All (2)");
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
    const flagged = item({ status: "flagged", openFlags: [{ source: "measured_fix", note: "Tutor saved", createdAt: "2026-09-29T16:00:00.000Z" }] });
    expect(matchesFilter(item(), "required")).toBe(true);
    expect(matchesFilter(item({ currentVerdict: review().queue[1].currentVerdict }), "required")).toBe(false);
    expect(matchesFilter(item({ required: false, inclusionReason: "not_sampled" }), "required")).toBe(false);
    expect(matchesFilter(flagged, "flagged")).toBe(true);
    expect(matchesFilter(item(), "flagged")).toBe(false);
    expect(matchesFilter(item(), "all")).toBe(true);
  });
});
