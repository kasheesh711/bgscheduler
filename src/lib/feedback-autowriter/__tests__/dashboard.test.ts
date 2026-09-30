import { describe, expect, it } from "vitest";
import { buildAutowriterDashboard, type DashboardCallRow, type DashboardSessionRow } from "../dashboard";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const control = {
  id: "default",
  mode: "live" as const,
  disabledTutors: ["6976680baf7fbc5ac88c3ea9"],
  haltedAt: null,
  haltReason: null,
  leaseToken: null,
  leaseUntil: null,
  updatedBy: "kevhsh7@gmail.com",
  updatedAt: new Date("2026-09-30T01:00:00.000Z"),
};

function session(id: string, patch: Partial<DashboardSessionRow>): DashboardSessionRow {
  return {
    wiseSessionId: id,
    wiseClassId: "6a0000000000000000000001",
    wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    scheduledEndAt: new Date("2026-09-30T03:00:00.000Z"),
    deadlineAt: new Date("2026-10-02T16:59:59.999Z"),
    state: "pending",
    reason: null,
    arm: null,
    evidence: "summary",
    postStartedAt: null,
    fields: null,
    metadata: {},
    createdAt: new Date("2026-09-30T03:01:00.000Z"),
    updatedAt: new Date("2026-09-30T03:05:00.000Z"),
    className: "Somchai (Tom.Ja) Jaidee",
    ...patch,
  };
}

function call(id: string, patch: Partial<DashboardCallRow>): DashboardCallRow {
  return {
    wiseSessionId: id,
    role: "writer",
    arm: "sol",
    requestedModel: "openai/gpt-6.1-sol",
    ok: true,
    costUsd: 0.0024,
    createdAt: new Date("2026-09-30T03:02:00.000Z"),
    result: null,
    ...patch,
  };
}

describe("buildAutowriterDashboard", () => {
  const dashboard = buildAutowriterDashboard({
    now: NOW,
    windowDays: 7,
    control,
    sessions: [
      session("a", { state: "verified", arm: "sol", postStartedAt: new Date("2026-09-30T03:02:00.000Z"), fields: { topics: "t" } }),
      session("b", { state: "verified", arm: "luna", postStartedAt: new Date("2026-09-30T03:04:00.000Z") }),
      session("c", { state: "held", reason: "sol:unfaithful:x", metadata: { judge: { unsupported: ["scored 95%"] } } }),
      session("d", { state: "skipped_human" }),
      session("e", { state: "unknown_outcome" }),
      // A shadow draft GLM wrote before the switch to Sol.
      session("f", { state: "would_submit", arm: "glm" }),
      // In-person classes (Wise type OFFLINE) on either account: not the autowriter's business, never shown.
      session("onsite-1", { state: "skipped_scope", reason: "session_type_OFFLINE" }),
      session("onsite-2", { state: "skipped_scope", reason: "session_type_OFFLINE", wiseTeacherUserId: "695369c028118f629edcb986" }),
      session("onsite-3", { state: "skipped_scope", reason: "session_type_in_person_title" }),
      // Gift's online class on her main account.
      session("g", { state: "verified", arm: "sol", wiseTeacherUserId: "695369c028118f629edcb9cb", postStartedAt: new Date("2026-09-30T03:03:00.000Z") }),
      // Out of scope for another reason (a group class) is still shown.
      session("h", { state: "skipped_scope", reason: "student_count_3" }),
    ],
    calls: [
      call("a", {}),
      call("a", { role: "judge", arm: "glm", requestedModel: "z-ai/glm-5.3-flash", costUsd: 0.0008, result: { faithful: true } }),
      call("b", { costUsd: 0.0024 }),
      call("b", { role: "judge", arm: "glm", requestedModel: "z-ai/glm-5.3-flash", costUsd: 0.0008, result: { faithful: false } }),
      call("b", { arm: "luna", requestedModel: "openai/gpt-6-luna", costUsd: 0.0012 }),
    ],
    webhooks: [
      { eventName: "MeetingEndedEvent", outcome: "verified", receivedAt: new Date("2026-09-30T03:00:05.000Z") },
      { eventName: "AttendanceComputedEvent", outcome: "already_handled:verified", receivedAt: new Date("2026-09-30T03:03:00.000Z") },
      { eventName: null, outcome: null, receivedAt: new Date("2026-09-30T02:00:00.000Z") },
    ],
  });

  it("counts states the way an operator reads them, leaving in-person classes out", () => {
    expect(dashboard.totals).toMatchObject({
      seen: 8, posted: 3, verified: 3, shadowDrafts: 1, held: 1, skippedHuman: 1, skippedScope: 1, failed: 1, expired: 0,
    });
    expect(dashboard.recent.map((row) => row.wiseSessionId)).not.toEqual(expect.arrayContaining(["onsite-1"]));
    expect(dashboard.recent.some((row) => row.wiseSessionId.startsWith("onsite"))).toBe(false);
  });

  it("measures latency from class end to the POST", () => {
    expect(dashboard.latency).toMatchObject({ medianMinutes: 3, p90Minutes: 4, samples: 3 });
    expect(dashboard.latency.byRoute).toEqual([
      { route: "transcript", label: "From the transcript", medianMinutes: null, p90Minutes: null, samples: 0 },
      { route: "summary_fallback", label: "From the summary (fallback)", medianMinutes: null, p90Minutes: null, samples: 0 },
      { route: "summary", label: "From the summary", medianMinutes: 3, p90Minutes: 4, samples: 3 },
    ]);
    expect(dashboard.summaryFallbacks).toEqual([]);
  });

  it("shows transcript first: fallbacks by cause, each row's fallback, and class end → post by evidence", () => {
    const at = (minutes: number) => new Date(new Date("2026-09-30T03:00:00.000Z").getTime() + minutes * 60_000);
    const fallback = (cause: string) => ({ summaryFallback: { cause, at: "2026-09-30T06:00:00.000Z" } });
    const board = buildAutowriterDashboard({
      now: NOW,
      windowDays: 7,
      control,
      calls: [],
      webhooks: [],
      sessions: [
        session("t1", { state: "verified", evidence: "transcript", postStartedAt: at(40) }),
        session("t2", { state: "verified", evidence: "transcript", postStartedAt: at(70) }),
        session("t3", { state: "awaiting_recording", evidence: "transcript", reason: "transcript_first", metadata: { handover: "transcript_first" } }),
        session("f1", { state: "verified", postStartedAt: at(200), metadata: { handover: "transcript_first", ...fallback("no_recording") } }),
        session("f2", { state: "held", reason: "thai_summary_no_transcript", metadata: fallback("speakers_unclear") }),
        session("f3", { state: "pending", metadata: fallback("no_recording") }),
        session("f4", { state: "pending", metadata: fallback("something_new") }),
        session("s1", { state: "verified", postStartedAt: at(3) }),
      ],
    });
    expect(board.summaryFallbacks).toEqual([
      { cause: "no_recording", label: "No recording after 3 h — from summary", count: 2 },
      { cause: "speakers_unclear", label: "Speakers unclear — from summary", count: 1 },
      { cause: "something_new", label: "something_new — from summary", count: 1 },
    ]);
    expect(board.latency.byRoute).toEqual([
      { route: "transcript", label: "From the transcript", medianMinutes: 55, p90Minutes: 70, samples: 2 },
      { route: "summary_fallback", label: "From the summary (fallback)", medianMinutes: 200, p90Minutes: 200, samples: 1 },
      { route: "summary", label: "From the summary", medianMinutes: 3, p90Minutes: 3, samples: 1 },
    ]);
    const row = (id: string) => board.recent.find((entry) => entry.wiseSessionId === id);
    expect(row("f1")?.summaryFallback).toEqual({ cause: "no_recording", label: "No recording after 3 h — from summary" });
    expect(row("t3")?.summaryFallback).toBeNull();
    expect(board.totals.awaitingRecording).toBe(1);
  });

  it("totals billed cost by model and per draft", () => {
    expect(dashboard.cost.totalUsd).toBeCloseTo(0.0076, 6);
    expect(dashboard.cost.perDraftUsd).toBeCloseTo(0.0076 / 4, 4);
    expect(dashboard.cost.byModel.find((entry) => entry.role === "writer" && entry.model === "openai/gpt-6.1-sol")?.calls).toBe(2);
    expect(dashboard.cost.byModel.find((entry) => entry.role === "judge" && entry.model === "z-ai/glm-5.3-flash")?.calls).toBe(2);
    expect(dashboard.judgeRejections).toBe(1);
    // Luna's share of the drafts, whichever writer (Sol now, GLM before 30 Sep) wrote the rest.
    expect(dashboard.fallbackShare).toBeCloseTo(1 / 4, 3);
    expect(dashboard.recent.find((row) => row.wiseSessionId === "a")?.arm).toBe("sol");
  });

  it("reports one row and switch per tutor across both Wise accounts, and recent rows with Wise links", () => {
    expect(dashboard.tutors.map((tutor) => tutor.tutorKey)).toEqual(["Kevin", "Gift", "Ek", "Peat", "Mimi"]);
    // Only Ek's Online account is switched off (per account, from the CLI): partly on.
    expect(dashboard.tutors.find((tutor) => tutor.tutorKey === "Ek")).toMatchObject({
      enabled: false, partlyEnabled: true, wiseUserIds: ["6976680baf7fbc5ac88c3ea9", "695369c028118f629edcba05"],
    });
    const kevin = dashboard.tutors.find((tutor) => tutor.tutorKey === "Kevin");
    expect(kevin).toMatchObject({ displayName: "Kevin (Kev) Y. Hsieh", enabled: true, partlyEnabled: false, seen: 7, posted: 2, held: 1 });
    expect(kevin?.wiseUserIds).toEqual([KEVIN_ONLINE_WISE_USER_ID, "695369c028118f629edcb986"]);
    const gift = dashboard.tutors.find((tutor) => tutor.tutorKey === "Gift");
    expect(gift).toMatchObject({ displayName: "Wanwisa (Gift) Montrikittiphant", seen: 1, posted: 1 });
    expect(dashboard.recent.find((row) => row.wiseSessionId === "g")?.tutor).toBe("Wanwisa (Gift) Montrikittiphant");
    const held = dashboard.recent.find((row) => row.wiseSessionId === "c");
    expect(held?.judgeUnsupported).toEqual(["scored 95%"]);
    expect(held?.wiseUrl).toBe("https://learn.begiftededucation.com/links?type=classroom_entity&entityType=session&entityId=c&classId=6a0000000000000000000001&profile=teacher");
  });

  it("shows every problem of a stored v4 verdict, and only the unsupported quotes of a v3 one", () => {
    const board = buildAutowriterDashboard({
      now: NOW,
      windowDays: 7,
      control,
      calls: [],
      webhooks: [],
      sessions: [
        session("v3", { state: "held", metadata: { judge: { faithful: false, unsupported: ["scored 95%"] } } }),
        session("v4", {
          state: "held",
          metadata: {
            judge: {
              faithful: false,
              unsupported: ["scored 95%"],
              misattributed: ["[STUDENT_1] said 8 of the 10 pages"],
              homeworkNotSet: ["three problems by Friday"],
            },
          },
        }),
        session("none", { state: "pending", metadata: { judge: null } }),
      ],
    });
    const problems = (id: string) => board.recent.find((row) => row.wiseSessionId === id)?.judgeUnsupported;
    expect(problems("v3")).toEqual(["scored 95%"]);
    expect(problems("v4")).toEqual([
      "wrong person: [STUDENT_1] said 8 of the 10 pages",
      "homework not set: three problems by Friday",
      "scored 95%",
    ]);
    expect(problems("none")).toEqual([]);
  });

  it("summarises webhook deliveries by event and outcome", () => {
    expect(dashboard.webhooks.byEvent).toEqual(expect.arrayContaining([{ eventName: "unparsed", count: 1 }]));
    expect(dashboard.webhooks.byOutcome).toEqual(expect.arrayContaining([{ outcome: "already_handled", count: 1 }]));
    expect(dashboard.webhooks.lastReceivedAt).toBe("2026-09-30T03:03:00.000Z");
    expect(dashboard.control).toMatchObject({ mode: "live", disabledTutors: ["6976680baf7fbc5ac88c3ea9"] });
  });
});
