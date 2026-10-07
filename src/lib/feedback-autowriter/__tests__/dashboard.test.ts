import { describe, expect, it } from "vitest";
import { buildAutowriterDashboard, type DashboardCallRow, type DashboardHoldRow, type DashboardSessionRow } from "../dashboard";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import type { AutowriterSystemStatus } from "../system-status";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const system: AutowriterSystemStatus = {
  writer: { model: "openai/gpt-6.1-sol", effort: "low" },
  tutorWriter: null,
  fallbackWriter: { model: "openai/gpt-6-luna", effort: "max" },
  judge: { model: "z-ai/glm-5.3-flash", efforts: ["medium", "high"] },
  transcriptFirst: true,
  holdSummaryOnly: false,
  secondPass: true,
  promptVersion: 5,
  judgeVersion: 5,
  commit: "abc1234",
};
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
    system,
    holds: [],
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
      system,
      holds: [],
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
        session("f5", { state: "pending", metadata: { handover: "transcript_first", writerErrors: 3, ...fallback("writer_failed") } }),
        session("s1", { state: "verified", postStartedAt: at(3) }),
      ],
    });
    expect(board.summaryFallbacks).toEqual([
      { cause: "no_recording", label: "No recording after 3 h — from summary", count: 2 },
      { cause: "speakers_unclear", label: "Speakers unclear — from summary", count: 1 },
      { cause: "something_new", label: "something_new — from summary", count: 1 },
      { cause: "writer_failed", label: "Writer failed 3 times on the transcript — from summary", count: 1 },
    ]);
    expect(board.latency.byRoute).toEqual([
      { route: "transcript", label: "From the transcript", medianMinutes: 55, p90Minutes: 70, samples: 2 },
      { route: "summary_fallback", label: "From the summary (fallback)", medianMinutes: 200, p90Minutes: 200, samples: 1 },
      { route: "summary", label: "From the summary", medianMinutes: 3, p90Minutes: 3, samples: 1 },
    ]);
    const row = (id: string) => board.recent.find((entry) => entry.wiseSessionId === id);
    expect(row("f1")?.summaryFallback).toEqual({ cause: "no_recording", label: "No recording after 3 h — from summary" });
    expect(row("t3")?.summaryFallback).toBeNull();
    expect(row("f5")?.summaryFallback).toEqual({ cause: "writer_failed", label: "Writer failed 3 times on the transcript — from summary" });
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
    expect(dashboard.tutors.map((tutor) => tutor.tutorKey)).toEqual([
      "Kevin", "Gift", "Ek", "Peat", "Mimi",
      "Ras", "Celeste", "Taki", "Dome", "Mandy", "Grace", "Mint", "Fluke", "Calvin", "Lukas", "A", "Ohm", "Mookie",
      "Aey", "Mikki", "Sagotty", "Buzz", "Linn", "Eng", "Kavin", "Copter", "Amy",
      "Tito", "Petch-Than", "Praew", "Shop", "Tai", "Menika", "Fay", "Pat", "Punlee", "Pech", "Jennie", "Mek-Sila", "Pakgad", "Glai", "Rew", "Win", "Sunday", "Nithit", "Key", "Ayush", "Art",
    ]);
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

  it("counts a draft the judge rejected once, however many of its levels rejected it", () => {
    const judge = (patch: Partial<DashboardCallRow>): DashboardCallRow =>
      call("a", { role: "judge", arm: "glm", requestedModel: "z-ai/glm-5.3-flash", costUsd: 0.0008, ...patch });
    const board = buildAutowriterDashboard({
      now: NOW,
      windowDays: 7,
      control,
      system,
      holds: [],
      sessions: [session("a", { state: "held" }), session("b", { state: "verified" })],
      webhooks: [],
      calls: [
        // v5: Sol's draft rejected at both levels, Luna's only at medium — two drafts.
        judge({ result: { effort: "medium", faithful: false, judgedArm: "sol", judgedGeneration: "gen-1" } }),
        judge({ result: { effort: "high", faithful: false, judgedArm: "sol", judgedGeneration: "gen-1" } }),
        judge({ result: { effort: "medium", faithful: false, judgedArm: "luna", judgedGeneration: "gen-2" } }),
        judge({ result: { effort: "high", faithful: true, judgedArm: "luna", judgedGeneration: "gen-2" } }),
        // Another class's draft that happens to share a generation id is still its own draft.
        judge({ wiseSessionId: "b", result: { effort: "high", faithful: false, judgedArm: "sol", judgedGeneration: "gen-1" } }),
        // Calls from before v5 carry no generation: one draft each, as before.
        judge({ wiseSessionId: "b", result: { faithful: false, judgedArm: "sol" } }),
        judge({ wiseSessionId: "b", result: { faithful: false, judgedArm: "luna" } }),
        judge({ wiseSessionId: "b", result: { faithful: true, judgedArm: "sol" } }),
        judge({ wiseSessionId: "b", result: { error: "judge_unparseable" } }),
      ],
    });
    expect(board.judgeRejections).toBe(5);
  });

  it("shows the union of a stored v5 verdict's two levels, once each", () => {
    const clean = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
    const board = buildAutowriterDashboard({
      now: NOW,
      windowDays: 7,
      control,
      system,
      holds: [],
      calls: [],
      webhooks: [],
      sessions: [
        session("v5", {
          state: "would_submit",
          metadata: {
            judge: {
              faithful: false,
              unsupported: ["scored 95%"],
              misattributed: ["[STUDENT_1] said 8 of the 10 pages"],
              homeworkNotSet: [],
              levels: {
                medium: { ...clean, faithful: false, unsupported: ["scored 95%"] },
                high: { ...clean, faithful: false, unsupported: ["scored 95%"], misattributed: ["[STUDENT_1] said 8 of the 10 pages"] },
              },
            },
          },
        }),
        session("v5-passed", { state: "verified", metadata: { judge: { ...clean, levels: { medium: clean, high: clean } } } }),
      ],
    });
    const problems = (id: string) => board.recent.find((row) => row.wiseSessionId === id)?.judgeUnsupported;
    expect(problems("v5")).toEqual(["wrong person: [STUDENT_1] said 8 of the 10 pages", "scored 95%"]);
    expect(problems("v5-passed")).toEqual([]);
  });

  it("shows every problem of a stored v4 verdict, and only the unsupported quotes of a v3 one", () => {
    const board = buildAutowriterDashboard({
      now: NOW,
      windowDays: 7,
      control,
      system,
      holds: [],
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

describe("buildAutowriterDashboard: what needs the owner", () => {
  const GIFT_MAIN = "695369c028118f629edcb9cb";
  const STRANGER = "6a00000000000000000000aa";
  const build = (input: { sessions?: DashboardSessionRow[]; holds?: DashboardHoldRow[] }) => buildAutowriterDashboard({
    now: NOW, windowDays: 7, control, system, calls: [], webhooks: [], sessions: input.sessions ?? [], holds: input.holds ?? [],
  });
  function hold(id: string, patch: Partial<DashboardHoldRow>): DashboardHoldRow {
    return {
      wiseSessionId: id,
      wiseClassId: "6a0000000000000000000001",
      wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
      scheduledEndAt: new Date("2026-09-30T03:00:00.000Z"),
      deadlineAt: new Date("2026-10-02T16:59:59.999Z"),
      reason: "sol:unfaithful:x",
      alertsSent: {},
      hasDraft: false,
      personWrote: false,
      className: "Somchai (Tom.Ja) Jaidee",
      ...patch,
    };
  }

  it("passes the system status through", () => {
    expect(build({}).system).toEqual(system);
  });

  it("counts the classes that end today in Bangkok for the Today line", () => {
    const yesterday = new Date("2026-09-29T10:00:00.000Z");
    const board = build({ sessions: [
      session("p1", { state: "verified" }),
      session("p2", { state: "awaiting_event" }),
      session("r1", { state: "awaiting_recording" }),
      session("r2", { state: "transcribing" }),
      session("h1", { state: "held", reason: "speakers_unclear" }),
      // 00:30 on the 30th in Bangkok: today.
      session("h2", { state: "held", reason: "sol:unfaithful:x", scheduledEndAt: new Date("2026-09-29T17:30:00.000Z") }),
      session("t1", { state: "skipped_human" }),
      session("g1", { state: "skipped_scope", reason: "class_type_GROUP" }),
      // In-person: never counted.
      session("o1", { state: "skipped_scope", reason: "session_type_OFFLINE" }),
      // Neither today's: yesterday's classes, and a class without an end time.
      session("y1", { state: "verified", scheduledEndAt: yesterday }),
      session("y2", { state: "held", scheduledEndAt: yesterday }),
      session("n1", { state: "verified", scheduledEndAt: null }),
      // Still being written, expired or failed: not on the line.
      session("w1", { state: "pending" }),
      session("e1", { state: "expired" }),
      session("f1", { state: "verify_failed" }),
    ] });
    expect(board.today).toEqual({ date: "2026-09-30", posted: 2, awaitingRecording: 2, held: 2, skippedHuman: 1, skippedScope: 1 });
    // Just after midnight in Bangkok it is a new day with nothing on it yet.
    const next = buildAutowriterDashboard({
      now: new Date("2026-09-30T17:05:00.000Z"), windowDays: 7, control, system, calls: [], webhooks: [], holds: [],
      sessions: [session("p1", { state: "verified" })],
    });
    expect(next.today).toEqual({ date: "2026-10-01", posted: 0, awaitingRecording: 0, held: 0, skippedHuman: 0, skippedScope: 0 });
  });

  it("lists every held class, soonest deadline first, with its tutor, alert time and whether a draft is stored", () => {
    const board = build({ holds: [
      hold("later", { deadlineAt: new Date("2026-10-02T16:59:59.999Z"), alertsSent: { held: "2026-09-30 03:20:05.123456+00" }, hasDraft: true }),
      // Older than any window, its deadline long gone: still a held class.
      hold("old", {
        scheduledEndAt: new Date("2026-08-01T03:00:00.000Z"), deadlineAt: new Date("2026-08-03T16:59:59.999Z"), reason: "recording_too_short",
        wiseTeacherUserId: GIFT_MAIN, alertsSent: { held: "suppressed:shadow" },
      }),
      hold("no-deadline", { deadlineAt: null, scheduledEndAt: null, wiseClassId: null, className: null, reason: null, wiseTeacherUserId: STRANGER }),
      hold("sooner", { deadlineAt: new Date("2026-09-30T16:59:59.999Z"), alertsSent: { held: "2026-09-30 10:20:05.5+07", expired: "2026-09-29 01:00:00+00" } }),
      hold("nobody", { deadlineAt: new Date("2026-10-01T16:59:59.999Z"), wiseTeacherUserId: null }),
    ] });
    expect(board.holds.map((row) => row.wiseSessionId)).toEqual(["old", "sooner", "nobody", "later", "no-deadline"]);
    expect(board.holds[0]).toEqual({
      wiseSessionId: "old",
      tutor: "Wanwisa (Gift) Montrikittiphant",
      tutorKey: "Gift",
      className: "Somchai (Tom.Ja) Jaidee",
      classEndedAt: "2026-08-01T03:00:00.000Z",
      deadlineAt: "2026-08-03T16:59:59.999Z",
      reason: "recording_too_short",
      // The digest was not emailed in shadow mode.
      alertSentAt: null,
      hasDraft: false,
      resolvedBy: null,
      wiseUrl: "https://learn.begiftededucation.com/links?type=classroom_entity&entityType=session&entityId=old&classId=6a0000000000000000000001&profile=teacher",
      noShow: null,
    });
    // Postgres writes the time as text, in the session's time zone.
    expect(board.holds.find((row) => row.wiseSessionId === "later")).toMatchObject({ tutorKey: "Kevin", alertSentAt: "2026-09-30T03:20:05.123Z", hasDraft: true });
    expect(board.holds.find((row) => row.wiseSessionId === "sooner")?.alertSentAt).toBe("2026-09-30T03:20:05.500Z");
    expect(board.holds.find((row) => row.wiseSessionId === "no-deadline")).toEqual({
      wiseSessionId: "no-deadline", tutor: STRANGER, tutorKey: STRANGER, className: null, classEndedAt: null, deadlineAt: null, reason: null,
      alertSentAt: null, hasDraft: false, resolvedBy: null, wiseUrl: null, noShow: null,
    });
    expect(board.holds.find((row) => row.wiseSessionId === "nobody")).toMatchObject({ tutor: "unknown", tutorKey: "unknown" });
    // The window's own counts are untouched by holds from outside it.
    expect(board.totals.held).toBe(0);
  });

  it("marks a held class a person has written since, and leaves it in the list", () => {
    const board = build({ holds: [hold("written", { personWrote: true }), hold("waiting", {})] });
    expect(board.holds.map((row) => [row.wiseSessionId, row.resolvedBy])).toEqual(
      expect.arrayContaining([["written", "tutor_wrote"], ["waiting", null]]),
    );
    expect(board.holds).toHaveLength(2);
  });

  it("lists the window's failed posts, latest class first", () => {
    const at = (hours: number) => new Date(new Date("2026-09-30T00:00:00.000Z").getTime() + hours * 3_600_000);
    const board = build({ sessions: [
      session("ok", { state: "verified" }),
      session("v", { state: "verify_failed", reason: "verify_failed", scheduledEndAt: at(1) }),
      session("u", { state: "unknown_outcome", reason: "unknown_outcome", scheduledEndAt: at(3), wiseTeacherUserId: GIFT_MAIN }),
      session("r", { state: "rejected", reason: "rejected", scheduledEndAt: at(2), wiseClassId: null }),
      session("held", { state: "held" }),
      session("expired", { state: "expired" }),
    ] });
    expect(board.failedPosts).toEqual([
      {
        wiseSessionId: "u", tutor: "Wanwisa (Gift) Montrikittiphant", tutorKey: "Gift", className: "Somchai (Tom.Ja) Jaidee",
        classEndedAt: "2026-09-30T03:00:00.000Z", state: "unknown_outcome", reason: "unknown_outcome",
        wiseUrl: "https://learn.begiftededucation.com/links?type=classroom_entity&entityType=session&entityId=u&classId=6a0000000000000000000001&profile=teacher",
      },
      {
        wiseSessionId: "r", tutor: "Kevin (Kev) Y. Hsieh", tutorKey: "Kevin", className: "Somchai (Tom.Ja) Jaidee",
        classEndedAt: "2026-09-30T02:00:00.000Z", state: "rejected", reason: "rejected", wiseUrl: null,
      },
      expect.objectContaining({ wiseSessionId: "v", state: "verify_failed", classEndedAt: "2026-09-30T01:00:00.000Z" }),
    ]);
    expect(board.totals.failed).toBe(3);
    expect(build({}).failedPosts).toEqual([]);
  });

  it("gives every recent class the tutor key the tutor table and the review queue use", () => {
    const board = build({ sessions: [
      session("k", { state: "verified" }),
      session("g", { state: "verified", wiseTeacherUserId: GIFT_MAIN }),
      session("s", { state: "held", wiseTeacherUserId: STRANGER }),
      session("n", { state: "pending", wiseTeacherUserId: null }),
    ] });
    const keyOf = (id: string) => board.recent.find((row) => row.wiseSessionId === id)?.tutorKey;
    expect([keyOf("k"), keyOf("g"), keyOf("s"), keyOf("n")]).toEqual(["Kevin", "Gift", STRANGER, "unknown"]);
    expect(board.tutors.map((tutor) => tutor.tutorKey)).toEqual(expect.arrayContaining(["Kevin", "Gift"]));
  });
});
