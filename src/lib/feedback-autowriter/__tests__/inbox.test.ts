import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INBOX_GROUPS,
  buildInbox,
  failedPostTitle,
  filterInbox,
  flagReasons,
  holdUrgency,
  incidentTitle,
  isListedIncident,
  isOpenHold,
  openCount,
  type InboxDashboard,
  type InboxItem,
  type InboxReview,
} from "../inbox";
import type { ReviewQueueItem } from "../review-data";

// Made-up tutors and ids; the student is the fixtures' one.
const NOW = new Date("2026-10-06T05:00:00.000Z");
const HOUR = 3_600_000;
const STUDENT = "Somchai (Tom.Ja) Jaidee";
const inHours = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

type Hold = InboxDashboard["holds"][number];
type FailedPost = InboxDashboard["failedPosts"][number];
// A whole queue item, as the page has it: the inbox reads only a few of its fields, never the feedback.
type QueueItem = ReviewQueueItem;
type Incident = InboxReview["incidents"][number];

function hold(id: string, patch: Partial<Hold> = {}): Hold {
  return {
    wiseSessionId: id, tutor: "Anna Example", tutorKey: "Anna", className: STUDENT, classEndedAt: inHours(-20), deadlineAt: inHours(40),
    reason: "sol:unfaithful:scored 95% on the mock paper", alertSentAt: null, hasDraft: false, resolvedBy: null, wiseUrl: null, ...patch,
  };
}

function failedPost(id: string, patch: Partial<FailedPost> = {}): FailedPost {
  return {
    wiseSessionId: id, tutor: "Ben Example", tutorKey: "Ben", className: STUDENT, classEndedAt: inHours(-30), state: "verify_failed",
    reason: "verify_failed", wiseUrl: null, ...patch,
  };
}

const FIELDS = { topics: "Rotation patterns", performance: "Tom spotted symmetry fast.", improvement: "Colour sequences", homework: "" };

function queueItem(id: string, patch: Partial<QueueItem> = {}): QueueItem {
  return {
    wiseSessionId: id, wiseUrl: null, className: STUDENT, tutor: "Chai Example", tutorKey: "Chai", classEndedAt: inHours(-10),
    bangkokDate: "2026-10-05", inclusionReason: "new_tutor", required: true, status: "needs_review", openFlags: [],
    firstShot: {
      postId: `post-${id}`, fields: FIELDS, fieldsSha256: "a".repeat(64), provenance: "snapshot", method: "unchanged",
      postStartedAt: inHours(-9), arm: "sol", evidence: "transcript", outcome: "verified", problems: [],
    },
    current: { fields: FIELDS, source: "first_shot", at: inHours(-9) },
    changed: false, diff: [], corrections: [], fixEvents: [], measuredFixCount: 0, measuredFixesByActor: {}, verdicts: [], currentVerdict: null,
    ...patch,
  };
}

function flag(source: string, note = "The tutor rewrote the homework line") {
  return { id: `flag-${source}`, source, note, suggestedSeverity: null, suggestedCategory: null, createdAt: inHours(-2) };
}

const APPROVED: NonNullable<QueueItem["currentVerdict"]> = {
  id: "v1", verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "owner@example.com", source: "dashboard",
  downgradedFrom: null, createdAt: inHours(-5), current: true,
};

function incident(id: string, patch: Partial<Incident> = {}): Incident {
  return {
    id, kind: "critical_verdict", severity: "critical", summary: "Critical verdict: Wrong person (recorded by owner@example.com)",
    wiseSessionId: null, pushStatus: "sent", lastPushError: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: inHours(-3), ...patch,
  };
}

const dashboard = (patch: Partial<InboxDashboard> = {}): InboxDashboard => ({ holds: [], failedPosts: [], recent: [], ...patch });
const review = (patch: Partial<InboxReview> = {}): InboxReview => ({ queue: [], incidents: [], ...patch });
const ids = (items: readonly InboxItem[]) => items.map((item) => item.id);

describe("INBOX_GROUPS", () => {
  it("names the groups in display order", () => {
    expect(INBOX_GROUPS).toEqual([
      { kind: "incident", label: "Incidents" },
      { kind: "hold", label: "Held" },
      { kind: "review", label: "To review" },
      { kind: "decision", label: "Decisions" },
      { kind: "failed_post", label: "Failed posts" },
      { kind: "expansion_ready", label: "Expansion" },
    ]);
  });
});

describe("buildInbox", () => {
  it("is empty when nothing needs the owner", () => {
    expect(buildInbox(dashboard(), review(), { now: NOW })).toEqual([]);
    expect(buildInbox(dashboard(), null, { now: NOW })).toEqual([]);
    // Nothing to do with: a reviewed class, a voluntary one, an acknowledged or an info incident.
    expect(buildInbox(dashboard(), review({
      queue: [
        queueItem("reviewed", { status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED] }),
        queueItem("optional", { status: "optional", required: false, inclusionReason: "not_sampled" }),
      ],
      incidents: [
        incident("acknowledged", { acknowledgedAt: inHours(-1), acknowledgedBy: "owner@example.com" }),
        incident("info", { severity: "info", kind: "first_shot_unverified", pushStatus: "not_required" }),
      ],
    }), { now: NOW })).toEqual([]);
  });

  it("orders the list: incidents, holds, reviews, decisions, failed posts, expansion", () => {
    const decision: InboxItem = {
      id: "decision:guest", kind: "decision", urgency: "normal", title: "Guest student: include or leave to the tutor?", detail: "Anna Example",
      tutorKey: "Anna", wiseSessionId: null, classEndedAt: null, deadlineAt: null, tutorNotifiedAt: null, action: "decide",
    };
    const expansion: InboxItem = {
      id: "expansion:next", kind: "expansion_ready", urgency: "normal", title: "Confirm the next 3 tutors", detail: "The gate passed.",
      tutorKey: null, wiseSessionId: null, classEndedAt: null, deadlineAt: null, tutorNotifiedAt: null, action: "confirm",
    };
    const items = buildInbox(
      dashboard({ holds: [hold("h1")], failedPosts: [failedPost("f1")] }),
      review({ queue: [queueItem("r1")], incidents: [incident("i1")] }),
      { now: NOW, extras: { decisions: [decision], expansion: [expansion] } },
    );
    expect(ids(items)).toEqual(["incident:i1", "hold:h1", "review:r1", "decision:guest", "failed_post:f1", "expansion:next"]);
    expect(items.map((item) => item.kind)).toEqual(INBOX_GROUPS.map((group) => group.kind));
    expect(items.map((item) => item.action)).toEqual(["open", "open", "review", "decide", "open", "confirm"]);
    // The later PRs' items pass through as they are.
    expect(items[3]).toBe(decision);
    expect(items[5]).toBe(expansion);
    // Nobody is told about a hold yet (the hold tracker is PR 2).
    expect(items.every((item) => item.tutorNotifiedAt === null)).toBe(true);
  });

  it("lists unacknowledged critical incidents, newest first, under the class's tutor when the page knows it", () => {
    const items = buildInbox(
      dashboard({
        holds: [hold("class-held", { tutorKey: "Ben" })],
        recent: [{ wiseSessionId: "class-recent", tutorKey: "Anna", scheduledEndAt: inHours(-50) }],
      }),
      review({
        queue: [queueItem("class-queue", { tutorKey: "Chai", classEndedAt: inHours(-12), status: "reviewed", currentVerdict: APPROVED })],
        incidents: [
          incident("older", { createdAt: inHours(-30), wiseSessionId: "class-recent" }),
          incident("newest", { createdAt: inHours(-1), kind: "api_actor_unmatched", wiseSessionId: "class-queue", summary: "A feedback save by the Wise API user matches no recorded autowriter post" }),
          incident("halt", { createdAt: inHours(-5), kind: "halt", summary: "Posting halted: unknown outcome" }),
          incident("unknown-class", { createdAt: inHours(-40), kind: "credit_entries_changed", wiseSessionId: "class-elsewhere" }),
          incident("on-hold", { createdAt: inHours(-45), kind: "critical_flag", wiseSessionId: "class-held" }),
          incident("new-kind", { createdAt: inHours(-60), kind: "something_new" }),
        ],
      }),
      { now: NOW },
    ).filter((item) => item.kind === "incident");
    expect(ids(items)).toEqual(["incident:newest", "incident:halt", "incident:older", "incident:unknown-class", "incident:on-hold", "incident:new-kind"]);
    expect(items[0]).toEqual({
      id: "incident:newest", kind: "incident", urgency: "critical", title: "A save by the Wise API user that no post explains",
      detail: "A feedback save by the Wise API user matches no recorded autowriter post",
      tutorKey: "Chai", wiseSessionId: "class-queue", classEndedAt: inHours(-12), deadlineAt: null, tutorNotifiedAt: null, action: "open",
    });
    expect(items[1]).toMatchObject({ title: "Posting was halted", detail: "Posting halted: unknown outcome", tutorKey: null, wiseSessionId: null, classEndedAt: null });
    expect(items[2]).toMatchObject({ title: "A critical error was found in a post", tutorKey: "Anna", classEndedAt: inHours(-50) });
    // A class the page does not hold: listed all the same, under no tutor.
    expect(items[3]).toMatchObject({ title: "A post changed the class's credit entries", tutorKey: null, wiseSessionId: "class-elsewhere", classEndedAt: null });
    expect(items[4]).toMatchObject({ title: "A post landed in Wise without verifying", tutorKey: "Ben" });
    expect(items[5]).toMatchObject({ title: "An incident needs a look", urgency: "critical" });
    expect(items.every((item) => item.urgency === "critical" && item.action === "open")).toBe(true);
  });

  it("lists a guided post's style fix after the critical incidents, not red; never a style check that could not run", () => {
    const items = buildInbox(dashboard(), review({
      incidents: [
        incident("style-fix", { createdAt: inHours(-1), kind: "style_review_flagged", severity: "info", pushStatus: "not_required",
          summary: "Guided feedback needs a style correction. Open its evidence and style review." }),
        incident("style-down", { createdAt: inHours(-2), kind: "style_review_unavailable", severity: "info", pushStatus: "not_required" }),
        incident("style-done", { createdAt: inHours(-3), kind: "style_review_flagged", severity: "info", pushStatus: "not_required",
          acknowledgedAt: inHours(-2), acknowledgedBy: "owner@example.com" }),
        incident("atom", { createdAt: inHours(-4), kind: "atom_collection_failed" }),
        incident("other-info", { createdAt: inHours(-1), kind: "first_shot_unverified", severity: "info", pushStatus: "not_required" }),
      ],
    }), { now: NOW });
    expect(ids(items)).toEqual(["incident:atom", "incident:style-fix"]);
    expect(items[0]).toMatchObject({ urgency: "critical", title: "Atom lesson collection failed" });
    expect(items[1]).toMatchObject({ urgency: "normal", title: "A guided post needs a style fix", action: "open" });
  });

  it("lists holds soonest deadline first, with the reason in plain words and no lesson text", () => {
    const items = buildInbox(dashboard({ holds: [
      hold("later", { deadlineAt: inHours(40) }),
      hold("none", { deadlineAt: null, classEndedAt: null, className: null, reason: null }),
      hold("passed", { deadlineAt: inHours(-3), reason: "recording_too_short", tutor: "Ben Example", tutorKey: "Ben", hasDraft: true, alertSentAt: inHours(-19) }),
      hold("soon", { deadlineAt: inHours(10), reason: "attendance_0pct" }),
    ] }), null, { now: NOW });
    expect(ids(items)).toEqual(["hold:passed", "hold:soon", "hold:later", "hold:none"]);
    expect(items[0]).toEqual({
      id: "hold:passed", kind: "hold", urgency: "critical", title: "Recording too short", detail: `Ben Example · ${STUDENT} · draft stored`,
      tutorKey: "Ben", wiseSessionId: "passed", classEndedAt: inHours(-20), deadlineAt: inHours(-3), tutorNotifiedAt: null, action: "open",
    });
    expect(items[1]).toMatchObject({ urgency: "soon", title: "The student's attendance shows 0%", detail: `Anna Example · ${STUDENT}` });
    expect(items[2]).toMatchObject({ urgency: "normal", title: "The judge found a claim the record does not support" });
    expect(items[3]).toMatchObject({ urgency: "normal", title: "No reason recorded", detail: "Anna Example", deadlineAt: null, classEndedAt: null });
    expect(JSON.stringify(items)).not.toContain("scored 95%");
  });

  it("turns a hold amber under 24 hours and red under 6 hours, at exactly those marks", () => {
    const urgencyAt = (msLeft: number) => buildInbox(
      dashboard({ holds: [hold("h", { deadlineAt: new Date(NOW.getTime() + msLeft).toISOString() })] }), null, { now: NOW },
    )[0].urgency;
    expect(urgencyAt(24 * HOUR + 1)).toBe("normal");
    expect(urgencyAt(24 * HOUR)).toBe("normal");
    expect(urgencyAt(24 * HOUR - 1)).toBe("soon");
    expect(urgencyAt(6 * HOUR)).toBe("soon");
    expect(urgencyAt(6 * HOUR - 1)).toBe("critical");
    expect(urgencyAt(0)).toBe("critical");
    expect(urgencyAt(-23 * HOUR)).toBe("critical");
    // The clock is the caller's: the same hold is further along an hour later.
    const items = (now: Date) => buildInbox(dashboard({ holds: [hold("h", { deadlineAt: inHours(6.5) })] }), null, { now });
    expect(items(NOW)[0].urgency).toBe("soon");
    expect(items(new Date(NOW.getTime() + HOUR))[0].urgency).toBe("critical");
  });

  it("leaves out a hold a person has written, and one whose deadline passed a day ago", () => {
    const listed = (patch: Partial<Hold>) => buildInbox(dashboard({ holds: [hold("h", patch)] }), null, { now: NOW }).length === 1;
    const deadlineIn = (msLeft: number) => new Date(NOW.getTime() + msLeft).toISOString();
    // Still waiting: nobody wrote it, and the deadline is ahead, unknown, or passed less than 24 hours ago.
    expect(listed({ deadlineAt: deadlineIn(40 * HOUR) })).toBe(true);
    expect(listed({ deadlineAt: null })).toBe(true);
    expect(listed({ deadlineAt: deadlineIn(-1) })).toBe(true);
    expect(listed({ deadlineAt: deadlineIn(-24 * HOUR + 1) })).toBe(true);
    // Nothing can be done in time any more.
    expect(listed({ deadlineAt: deadlineIn(-24 * HOUR) })).toBe(false);
    expect(listed({ deadlineAt: deadlineIn(-72 * HOUR) })).toBe(false);
    // A person wrote it: off the list at once, however far the deadline.
    expect(listed({ deadlineAt: deadlineIn(40 * HOUR), resolvedBy: "tutor_wrote" })).toBe(false);
    expect(listed({ deadlineAt: deadlineIn(-1), resolvedBy: "tutor_wrote" })).toBe(false);
    expect(listed({ deadlineAt: null, resolvedBy: "tutor_wrote" })).toBe(false);

    const items = buildInbox(dashboard({ holds: [
      hold("written", { deadlineAt: inHours(2), resolvedBy: "tutor_wrote" }),
      hold("stale", { deadlineAt: inHours(-30) }),
      hold("open", { deadlineAt: inHours(30) }),
      hold("just-passed", { deadlineAt: inHours(-2) }),
    ] }), null, { now: NOW });
    expect(ids(items)).toEqual(["hold:just-passed", "hold:open"]);
    // The same rule, for the tutor table's count of open holds.
    expect(isOpenHold({ resolvedBy: null, deadlineAt: inHours(30) }, NOW)).toBe(true);
    expect(isOpenHold({ resolvedBy: "tutor_wrote", deadlineAt: inHours(30) }, NOW)).toBe(false);
    expect(isOpenHold({ resolvedBy: null, deadlineAt: inHours(-30) }, NOW)).toBe(false);
    // A hold that left the list still names its class for an incident about it.
    const about = buildInbox(
      dashboard({ holds: [hold("written", { tutorKey: "Ben", resolvedBy: "tutor_wrote" })] }),
      review({ incidents: [incident("i1", { wiseSessionId: "written" })] }),
      { now: NOW },
    );
    expect(about).toMatchObject([{ id: "incident:i1", tutorKey: "Ben" }]);
  });

  it("lists what is left to review: flagged posts first, then the oldest class first", () => {
    const items = buildInbox(dashboard(), review({ queue: [
      queueItem("newer", { classEndedAt: inHours(-5) }),
      queueItem("flagged-after-approve", {
        classEndedAt: inHours(-2), status: "flagged", currentVerdict: APPROVED, verdicts: [APPROVED], openFlags: [flag("measured_fix")],
        tutor: "Anna Example", tutorKey: "Anna",
      }),
      queueItem("older", { classEndedAt: inHours(-50) }),
      queueItem("flagged-older", { classEndedAt: inHours(-70), status: "flagged", openFlags: [flag("system"), flag("measured_fix")] }),
      // A flag makes even a post that was not sampled one to review.
      queueItem("flagged-unsampled", { classEndedAt: inHours(-60), status: "flagged", required: false, inclusionReason: "not_sampled", openFlags: [flag("agent")] }),
      queueItem("reviewed", { status: "reviewed", currentVerdict: APPROVED }),
      queueItem("optional", { status: "optional", required: false }),
      queueItem("undated", { classEndedAt: null }),
    ] }), { now: NOW });
    expect(ids(items)).toEqual([
      "review:flagged-older", "review:flagged-unsampled", "review:flagged-after-approve", "review:older", "review:newer", "review:undated",
    ]);
    expect(items[0]).toEqual({
      id: "review:flagged-older", kind: "review", urgency: "soon", title: "A flagged post to review",
      detail: `Chai Example · ${STUDENT} · did not verify in Wise; changed in Wise after posting`,
      tutorKey: "Chai", wiseSessionId: "flagged-older", classEndedAt: inHours(-70), deadlineAt: null, tutorNotifiedAt: null, action: "review",
    });
    expect(items[1]).toMatchObject({ urgency: "soon", detail: `Chai Example · ${STUDENT} · flagged by the agent` });
    expect(items[2]).toMatchObject({ urgency: "soon", tutorKey: "Anna" });
    expect(items[3]).toEqual({
      id: "review:older", kind: "review", urgency: "normal", title: "A post to review", detail: `Chai Example · ${STUDENT}`,
      tutorKey: "Chai", wiseSessionId: "older", classEndedAt: inHours(-50), deadlineAt: null, tutorNotifiedAt: null, action: "review",
    });
    // Neither the feedback nor a flag's note (an agent may quote the lesson) reaches the list.
    const text = JSON.stringify(items);
    expect(text).not.toContain("Rotation patterns");
    expect(text).not.toContain("rewrote the homework line");
  });

  it("lists failed posts, latest class first, by what happened to the post", () => {
    const items = buildInbox(dashboard({ failedPosts: [
      failedPost("verify", { classEndedAt: inHours(-30) }),
      failedPost("unknown", { classEndedAt: inHours(-5), state: "unknown_outcome", reason: "unknown_outcome", tutor: "Anna Example", tutorKey: "Anna", className: null }),
      failedPost("rejected", { classEndedAt: inHours(-10), state: "rejected", reason: "rejected" }),
    ] }), null, { now: NOW });
    expect(items).toEqual([
      {
        id: "failed_post:unknown", kind: "failed_post", urgency: "normal", title: "A post's outcome in Wise is unknown", detail: "Anna Example",
        tutorKey: "Anna", wiseSessionId: "unknown", classEndedAt: inHours(-5), deadlineAt: null, tutorNotifiedAt: null, action: "open",
      },
      expect.objectContaining({ id: "failed_post:rejected", title: "Wise rejected a post", detail: `Ben Example · ${STUDENT}` }),
      expect.objectContaining({ id: "failed_post:verify", title: "A post did not verify in Wise" }),
    ]);
  });

  it("still lists holds and failed posts when the review data is unavailable", () => {
    const extras = { decisions: [], expansion: [] };
    const items = buildInbox(dashboard({ holds: [hold("h1")], failedPosts: [failedPost("f1")] }), null, { now: NOW, extras });
    expect(ids(items)).toEqual(["hold:h1", "failed_post:f1"]);
    // Without a clock given, the list is built for now.
    expect(buildInbox(dashboard({ holds: [hold("h1", { deadlineAt: new Date(Date.now() - HOUR).toISOString() })] }), null)[0].urgency).toBe("critical");
  });
});

describe("the words and colours the drawer shares with the list", () => {
  it("names an incident and a failed post as the list does", () => {
    expect(incidentTitle("halt")).toBe("Posting was halted");
    expect(incidentTitle("critical_verdict")).toBe("A critical error was found in a post");
    expect(incidentTitle("something_new")).toBe("An incident needs a look");
    // Each job names its own trouble; the forward scan keeps its kind for when it exists.
    expect(incidentTitle("scan_failed")).toBe("The forward scan failed");
    expect(incidentTitle("atom_collection_failed")).toBe("Atom lesson collection failed");
    expect(incidentTitle("style_review_flagged")).toBe("A guided post needs a style fix");
    expect(incidentTitle("style_review_unavailable")).toBe("A guided post's style check could not run");
    expect(incidentTitle("style_review_source_missing")).toBe("A guided post is missing its evidence or fact checks");
    expect(failedPostTitle("verify_failed")).toBe("A post did not verify in Wise");
    expect(failedPostTitle("unknown_outcome")).toBe("A post's outcome in Wise is unknown");
    expect(failedPostTitle("rejected")).toBe("Wise rejected a post");
  });

  it("keeps an incident in the list until acknowledged when it is critical or a style fix", () => {
    expect(isListedIncident({ kind: "halt", severity: "critical", acknowledgedAt: null })).toBe(true);
    expect(isListedIncident({ kind: "halt", severity: "critical", acknowledgedAt: inHours(-1) })).toBe(false);
    expect(isListedIncident({ kind: "style_review_flagged", severity: "info", acknowledgedAt: null })).toBe(true);
    expect(isListedIncident({ kind: "style_review_flagged", severity: "info", acknowledgedAt: inHours(-1) })).toBe(false);
    expect(isListedIncident({ kind: "style_review_unavailable", severity: "info", acknowledgedAt: null })).toBe(false);
    expect(isListedIncident({ kind: "first_shot_unverified", severity: "info", acknowledgedAt: null })).toBe(false);
  });

  it("says why a post is flagged from its flags' sources, each once, never from a flag's note", () => {
    expect(flagReasons([flag("system"), flag("measured_fix"), flag("measured_fix")])).toBe("did not verify in Wise; changed in Wise after posting");
    expect(flagReasons([flag("agent"), flag("owner"), flag("api_unmatched")])).toBe("flagged by the agent; flagged by the owner; an API save no post explains");
    expect(flagReasons([flag("something_new")])).toBe("flagged");
    expect(flagReasons([])).toBe("");
  });

  it("rates a hold by the time left to its deadline", () => {
    expect(holdUrgency(inHours(30), NOW)).toBe("normal");
    expect(holdUrgency(inHours(10), NOW)).toBe("soon");
    expect(holdUrgency(inHours(2), NOW)).toBe("critical");
    expect(holdUrgency(inHours(-2), NOW)).toBe("critical");
    expect(holdUrgency(null, NOW)).toBe("normal");
  });
});

describe("filterInbox", () => {
  const items = buildInbox(
    dashboard({ holds: [hold("h-anna"), hold("h-ben", { tutorKey: "Ben" })], failedPosts: [failedPost("f-ben")] }),
    review({ queue: [queueItem("r-chai"), queueItem("r-anna", { tutorKey: "Anna" })], incidents: [incident("i-halt", { kind: "halt" })] }),
    { now: NOW },
  );

  it("keeps every item when no tutor is chosen", () => {
    expect(filterInbox(items, null)).toEqual(items);
    expect(filterInbox(items, null)).not.toBe(items);
  });

  it("keeps a tutor's items, in order, and the items that belong to no tutor", () => {
    expect(ids(filterInbox(items, "Anna"))).toEqual(["incident:i-halt", "hold:h-anna", "review:r-anna"]);
    expect(ids(filterInbox(items, "Ben"))).toEqual(["incident:i-halt", "hold:h-ben", "failed_post:f-ben"]);
    // A tutor with nothing open still sees what concerns everyone.
    expect(ids(filterInbox(items, "Dao"))).toEqual(["incident:i-halt"]);
    expect(filterInbox([], "Anna")).toEqual([]);
  });
});

describe("openCount", () => {
  it("counts classes, not rows: a class with a post to review and an incident about it is one", () => {
    const items = buildInbox(
      dashboard({ holds: [hold("h-anna")], failedPosts: [failedPost("r-chai")] }),
      review({
        queue: [queueItem("r-chai"), queueItem("r-anna", { tutorKey: "Anna" })],
        incidents: [incident("i-chai", { wiseSessionId: "r-chai" }), incident("i-chai-2", { wiseSessionId: "r-chai" })],
      }),
      { now: NOW },
    );
    // Two incidents, a review and a failed post of one class, a hold, and another review: three classes.
    expect(items).toHaveLength(6);
    expect(openCount(items)).toBe(3);
  });

  it("counts each item about no class on its own", () => {
    const items = buildInbox(dashboard({ holds: [hold("h-anna")] }), review({
      incidents: [incident("i-halt", { kind: "halt" }), incident("i-scan", { kind: "scan_failed" })],
    }), { now: NOW });
    expect(openCount(items)).toBe(3);
    expect(openCount([])).toBe(0);
  });
});

describe("the modules the page runs in the browser", () => {
  const DIRECTORY = path.resolve(__dirname, "..");
  /** What a module loads when it runs: every import that is not `import type`. */
  function runtimeImports(file: string): string[] {
    const source = fs.readFileSync(path.join(DIRECTORY, file), "utf8");
    return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]);
  }

  it("load nothing but each other: no database layer, no server-only module, no package", () => {
    const loaded = new Set<string>();
    const outside = new Set<string>();
    const visit = (file: string) => {
      if (loaded.has(file)) return;
      loaded.add(file);
      for (const specifier of runtimeImports(file)) {
        if (specifier.startsWith("./")) visit(`${specifier.slice(2)}.ts`);
        else outside.add(`${file} → ${specifier}`);
      }
    };
    // The to-do list and the gate sentence are built on the client, from the payloads the page already has.
    visit("inbox.ts");
    visit("gate-sentence.ts");
    expect([...loaded].toSorted()).toEqual(["gate-sentence.ts", "hold-reasons.ts", "inbox.ts", "quality.ts"]);
    expect([...outside]).toEqual([]);
    // The check itself sees a server module's imports.
    expect(runtimeImports("trends.ts")).toEqual(expect.arrayContaining(["drizzle-orm", "@/lib/db/schema", "./dashboard"]));
  });
});
