import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import {
  CORRECTION_LOCK_BUDGET_MS,
  CORRECTION_READ_BACK_DELAY_MS,
  CORRECTION_READ_RETRIES,
  CORRECTION_READ_RETRY_INTERVAL_MS,
  CorrectionRefusedError,
  agentCorrectionDedupeKey,
  correctPostGuarded,
  inCorrectionWindow,
  type CorrectPostInput,
  type CorrectionPlan,
  type CorrectionPostStartInput,
  type CorrectionSettleOutcome,
  type CorrectionStore,
} from "../correction";
import { AUTOWRITER_TEACHER_ALLOWLIST, KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import { feedbackBodyHash, fieldsHash } from "../submit";
import {
  AI_SUSPECT,
  API_ACTOR,
  BASE,
  BILLING,
  CORRECTED,
  FIRST_SHOT_AT,
  OTHER_STUDENT,
  OTHER_TEACHER,
  STANDARD_ORDER,
  START,
  clock,
  fakeWise,
  firstShotSave,
  postedDetail,
  save,
  type FakeWiseOptions,
  type Field,
} from "./correction-fixtures";
import { CLASS_ID, QUESTIONS, SESSION_ID, STUDENT_ID, SUBMISSION_ID, autoBlankSubmission } from "./fixtures";

interface StoreOptions {
  preconditions?: string[] | Error;
  lock?: { ok: false; reason: string } | Error;
  /** Runs when the lock is taken (e.g. time passing). */
  onLock?: () => void;
  record?: Error;
  /** Settle calls (1-based) that throw. */
  settleFails?: number[];
}

function memoryStore(log: string[], options: StoreOptions = {}) {
  const store = {
    releases: 0,
    records: [] as Array<{ plan: CorrectionPlan; input: CorrectionPostStartInput }>,
    settles: [] as Array<{ postId: string; outcome: CorrectionSettleOutcome; verification: Record<string, unknown>; session?: unknown }>,
    halts: [] as string[],
    incidents: [] as Array<{ dedupeKey: string; summary: string; detail: Record<string, unknown>; wiseSessionId: string }>,
    async preconditions() {
      log.push("store:preconditions");
      if (options.preconditions instanceof Error) throw options.preconditions;
      return options.preconditions ?? [];
    },
    async lock() {
      log.push("store:lock");
      if (options.lock instanceof Error) throw options.lock;
      if (options.lock) return options.lock;
      options.onLock?.();
      return {
        ok: true as const,
        lock: {
          release: async () => {
            log.push("store:release");
            store.releases += 1;
            return true;
          },
        },
      };
    },
    async recordPostStart(plan: CorrectionPlan, input: CorrectionPostStartInput) {
      log.push("store:record");
      if (options.record) throw options.record;
      store.records.push({ plan, input });
      return { postId: "post-1", postStartedAt: new Date() };
    },
    async settle(postId: string, input: { outcome: CorrectionSettleOutcome; verification: Record<string, unknown>; session?: unknown }) {
      log.push(`store:settle:${input.outcome}`);
      if (options.settleFails?.includes(store.settles.length + store.failedSettles + 1)) {
        store.failedSettles += 1;
        throw new Error("settle failed");
      }
      store.settles.push({ postId, ...input });
    },
    failedSettles: 0,
    async halt(reason: string) {
      log.push("store:halt");
      store.halts.push(reason);
    },
    async incident(input: { dedupeKey: string; summary: string; detail: Record<string, unknown>; wiseSessionId: string }) {
      log.push("store:incident");
      store.incidents.push(input);
    },
  };
  return store satisfies CorrectionStore;
}

function plan(overrides: Partial<CorrectionPlan> = {}): CorrectionPlan {
  return {
    wiseSessionId: SESSION_ID,
    wiseClassId: CLASS_ID,
    wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    base: { fields: BASE, fieldsSha256: fieldsHash(BASE), submissionId: SUBMISSION_ID, billing: BILLING, firstShotPostedAt: FIRST_SHOT_AT },
    fields: CORRECTED,
    fieldsSha256: fieldsHash(CORRECTED),
    reason: "performance_misstated: the tutor's own words show he self-corrected",
    rootCauseRef: "synthetic-root-cause-1",
    pipeline: { promptVersion: 9, judgeVersion: 5 },
    evidence: "transcript",
    arm: "sol",
    mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS,
    ...overrides,
  };
}

/** One run with fresh fakes; `wise`/`store` options shape them, `input` overrides the call. */
async function run(options: {
  wise?: FakeWiseOptions;
  store?: StoreOptions;
  input?: Partial<CorrectPostInput>;
  start?: Date;
} = {}) {
  const log: string[] = [];
  const time = clock(options.start);
  const wise = fakeWise(time, log, options.wise);
  const store = memoryStore(log, options.store);
  const outcome = await correctPostGuarded({
    ops: wise,
    store,
    plan: plan(),
    apiActorId: API_ACTOR,
    allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
    disabledTutors: [],
    aiSuspect: AI_SUSPECT,
    textProblems: () => [],
    now: time.now,
    sleep: time.sleep,
    eventWaitMs: 0,
    ...options.input,
  });
  return { outcome, log, wise, store, time };
}

/** Nothing was locked, recorded, settled, halted, reported or posted. */
function expectUntouched(result: Awaited<ReturnType<typeof run>>) {
  expect(result.wise.postFeedback).not.toHaveBeenCalled();
  expect(result.log.filter((entry) => /^store:(lock|record|settle|halt|incident|release)/u.test(entry))).toEqual([]);
}

/** Refused under the lock: released exactly once, nothing recorded or posted. */
function expectReleasedUnsent(result: Awaited<ReturnType<typeof run>>) {
  expect(result.wise.postFeedback).not.toHaveBeenCalled();
  expect(result.store.releases).toBe(1);
  expect(result.log.filter((entry) => /^store:(record|settle|halt|incident)/u.test(entry))).toEqual([]);
}

describe("inCorrectionWindow", () => {
  const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 2, 19, minute, second));
  it("allows UTC minutes 10–15 and 40–45 only, edges included", () => {
    for (const minute of [10, 11, 15, 40, 45]) expect(inCorrectionWindow(at(minute))).toBe(true);
    expect(inCorrectionWindow(at(15, 59))).toBe(true);
    expect(inCorrectionWindow(at(45, 59))).toBe(true);
    for (const minute of [9, 16, 39, 46]) expect(inCorrectionWindow(at(minute))).toBe(false);
    expect(inCorrectionWindow(at(9, 59))).toBe(false);
  });

  it("is closed on every cron minute that touches the autowriter or Wise feedback", () => {
    // sync-wise, backstop sweep, review job, Atom collector, Wise activity sync.
    for (const minute of [0, 30, 8, 22, 38, 52, 27, 6, 21, 36, 51, 2, 17, 32, 47]) expect(inCorrectionWindow(at(minute))).toBe(false);
  });
});

describe("agentCorrectionDedupeKey", () => {
  it("is one key per class", () => {
    expect(agentCorrectionDedupeKey(SESSION_ID)).toBe(`agent-correction:${SESSION_ID}`);
  });
});

describe("correctPostGuarded: a correction that lands", () => {
  it("verifies text, billing, credit entry and our event, with exactly one POST under the lock", async () => {
    const result = await run();
    expect(result.outcome).toMatchObject({ status: "verified", postId: "post-1" });
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
    expect(result.wise.posts).toEqual([{
      answers: STANDARD_ORDER.map((field) => ({ answer: CORRECTED[field] })),
      sessionStatus: "COMPLETED",
      creditsConsumed: 1,
    }]);
    // Reads before the lock, the fresh read and the events after it, the posts row before the POST, release last.
    expect(result.log).toEqual([
      "store:preconditions", "wise:detail#1", "wise:credits#1", "store:lock", "wise:detail#2", "wise:events#1",
      "store:record", "wise:post", "wise:detail#3", "wise:credits#2", "wise:events#2", "store:settle:verified", "store:release",
    ]);
    expect(result.store.records[0].input).toMatchObject({ studentWiseUserId: STUDENT_ID, baselineCredits: [1] });
    expect(result.store.records[0].input.freshReadAt).toEqual(START);
    const [settled] = result.store.settles;
    expect(settled.session).toMatchObject({
      fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), fromSha256: fieldsHash(BASE), reason: plan().reason,
    });
    expect(settled.verification).toMatchObject({
      httpStatus: 200, landed: true, creditEntries: 1, event: { actorId: API_ACTOR, autoSubmitted: false },
    });
    expect(result.store.halts).toEqual([]);
    expect(result.store.incidents).toEqual([]);
    expect(result.time.sleep).toHaveBeenCalledWith(CORRECTION_READ_BACK_DELAY_MS);
  });

  it("posts the current billing with the answers in the form's own order", async () => {
    const order: Field[] = ["homework", "topics", "improvement", "performance"];
    const result = await run({ wise: { order } });
    expect(result.outcome.status).toBe("verified");
    expect(result.wise.posts).toEqual([{
      answers: order.map((field) => ({ answer: CORRECTED[field] })),
      sessionStatus: "COMPLETED",
      creditsConsumed: 1,
    }]);
  });

  it("settles awaiting_event (session text updated) and releases when our event is not seen yet", async () => {
    const result = await run({ wise: { eventsAfterPost: () => [] } });
    expect(result.outcome).toMatchObject({ status: "awaiting_event", postId: "post-1" });
    expect(result.store.settles.map((settled) => settled.outcome)).toEqual(["awaiting_event"]);
    expect(result.store.settles[0].session).toMatchObject({ fields: CORRECTED, fromSha256: fieldsHash(BASE) });
    expect(result.store.settles[0].verification).toMatchObject({ event: null, landed: true });
    expect(result.log.slice(-2)).toEqual(["store:settle:awaiting_event", "store:release"]);
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("ignores a student's own feedback save since the first shot (their form, not the teacher's text)", async () => {
    const result = await run({ wise: { eventsBefore: [firstShotSave(), save(new Date(FIRST_SHOT_AT.getTime() + 60_000), STUDENT_ID, "STUDENT")] } });
    expect(result.outcome.status).toBe("verified");
  });
});

describe("correctPostGuarded: dry run", () => {
  it("reads and checks everything but never locks, records, settles or posts", async () => {
    const result = await run({ input: { dryRun: true } });
    expect(result.outcome).toMatchObject({ status: "preflight_ok" });
    if (result.outcome.status !== "preflight_ok") throw new Error("unreachable");
    expect(result.outcome.guards).toEqual([
      "plan", "window", "db_preconditions", "wise_state_before_lock", "credit_baseline", "lock (not taken: dry run)",
      "wise_state_under_lock (without the lock: dry run)", "no_save_since_first_shot (without the lock: dry run)", "stop",
    ]);
    expectUntouched(result);
    expect(result.log).toEqual(["store:preconditions", "wise:detail#1", "wise:credits#1", "wise:detail#2", "wise:events#1"]);
    // The body hash is the live run's.
    const live = await run();
    expect(live.outcome.status).toBe("verified");
    expect(result.outcome.bodyHash).toBe(feedbackBodyHash(live.wise.posts[0]));
  });

  it("says, rather than refuses, that the window is not enforced outside it", async () => {
    const result = await run({ input: { dryRun: true }, start: new Date("2026-10-02T19:22:00.000Z") });
    expect(result.outcome).toMatchObject({ status: "preflight_ok" });
    if (result.outcome.status !== "preflight_ok") throw new Error("unreachable");
    expect(result.outcome.guards).toContain("window (not enforced: dry run outside the window)");
    expectUntouched(result);
  });

  it("refuses on the same checks as a live run", async () => {
    const result = await run({ input: { dryRun: true }, wise: { detailOn: (call) => call === 2 ? postedDetail({ text: CORRECTED }) : undefined } });
    expect(result.outcome).toEqual({ status: "refused", stage: "wise", reason: "wise_text_differs_from_last_post" });
    expectUntouched(result);
  });
});

describe("correctPostGuarded: refusals before anything is read", () => {
  const long = "x".repeat(5_001);
  const cases: Array<[string, Partial<CorrectPostInput>, string]> = [
    ["fields_malformed", { plan: plan({ fields: { ...CORRECTED, homework: undefined as unknown as string } }) }, "fields_malformed"],
    ["hash_mismatch", { plan: plan({ fieldsSha256: fieldsHash(BASE) }) }, "hash_mismatch"],
    ["base_hash_mismatch", { plan: plan({ base: { ...plan().base, fieldsSha256: fieldsHash(CORRECTED) } }) }, "base_hash_mismatch"],
    ["no_change", { plan: plan({ fields: BASE, fieldsSha256: fieldsHash(BASE) }) }, "no_change"],
    ["reason_missing", { plan: plan({ reason: "  " }) }, "reason_missing"],
    ["reason_too_long", { plan: plan({ reason: "r".repeat(501) }) }, "reason_too_long"],
    ["root_cause_missing (none)", { plan: plan({ rootCauseRef: null }) }, "root_cause_missing"],
    ["root_cause_missing (blank)", { plan: plan({ rootCauseRef: "  " }) }, "root_cause_missing"],
    ["api_actor_missing", { apiActorId: "" }, "api_actor_missing"],
    ["the caller's text check", { textProblems: () => ["markdown:topics"] }, "text:markdown:topics"],
    ["a text check that throws", { textProblems: () => { throw new TypeError("bad"); } }, "text:check_failed:TypeError"],
    [
      "Wise's answer limit",
      { plan: plan({ fields: { ...CORRECTED, homework: long }, fieldsSha256: fieldsHash({ ...CORRECTED, homework: long }) }) },
      "text:too_long:homework",
    ],
    [
      "whitespace no draft posts",
      { plan: plan({ fields: { ...CORRECTED, topics: `${CORRECTED.topics}\r\n` }, fieldsSha256: fieldsHash({ ...CORRECTED, topics: `${CORRECTED.topics}\r\n` }) }) },
      "text:untidy:topics",
    ],
    ["stop_requested", { stopRequested: () => true }, "stop_requested"],
  ];
  it.each(cases)("refuses %s", async (_name, input, reason) => {
    const result = await run({ input });
    expect(result.outcome).toEqual({ status: "refused", stage: "plan", reason });
    expectUntouched(result);
    expect(result.log).toEqual([]);
  });

  it("refuses a text Class Feedback would not accept (a correction must never create a deduction)", async () => {
    const thin = { topics: "Fractions.", performance: "Good.", improvement: "Practise.", homework: "" };
    const result = await run({ input: { plan: plan({ fields: thin, fieldsSha256: fieldsHash(thin) }) } });
    expect(result.outcome).toMatchObject({ status: "refused", stage: "plan" });
    if (result.outcome.status !== "refused") throw new Error("unreachable");
    expect(result.outcome.reason).toMatch(/(?:^|,)text:policy:combined_characters:/u);
    expectUntouched(result);
  });

  // Each passes the caller's (empty) check: the executor's own checks must refuse it.
  const unsafe: Array<[string, Partial<Record<Field, string>>, string]> = [
    ["absence wording (Class Feedback would mark the session ineligible)", { homework: "Student was absent today." },
      "text:attendance_wording:missed_or_no_show:homework"],
    ["a leftover name placeholder", { performance: CORRECTED.performance.replace("Somchai", "[STUDENT_1]") }, "text:placeholder_token:performance"],
    ["Thai text", { topics: `${CORRECTED.topics} (เศษส่วน)` }, "text:thai_text:topics"],
    ["markdown", { improvement: `**Next steps**\n${CORRECTED.improvement}` }, "text:markdown:improvement"],
  ];
  it.each(unsafe)("refuses %s with an empty caller check", async (_name, change, reason) => {
    const fields = { ...CORRECTED, ...change };
    const result = await run({ input: { plan: plan({ fields, fieldsSha256: fieldsHash(fields) }), textProblems: () => [] } });
    expect(result.outcome).toMatchObject({ status: "refused", stage: "plan" });
    if (result.outcome.status !== "refused") throw new Error("unreachable");
    expect(result.outcome.reason.split(",")).toContain(reason);
    expectUntouched(result);
    expect(result.log).toEqual([]);
  });

  it("refuses a near-copy of the tutor's feedback on another class, never of the class's own first shot", async () => {
    const other = await run({ input: { aiSuspect: { ...AI_SUSPECT, priorFeedback: [{ key: "6a00000000000000000000e1", fields: CORRECTED }] } } });
    expect(other.outcome).toMatchObject({ status: "refused", stage: "plan", reason: "text:ai_suspect:similar_prior_feedback" });
    expectUntouched(other);
    const own = await run({ input: { aiSuspect: { ...AI_SUSPECT, priorFeedback: [{ key: SESSION_ID, fields: BASE }] } } });
    expect(own.outcome.status).toBe("verified");
  });

  it("allows the student's own Thai name, as a draft's check does", async () => {
    const fields = Object.fromEntries(Object.entries(CORRECTED).map(([field, text]) => [field, text.replaceAll("Somchai", "สมชาย")])) as typeof CORRECTED;
    const thaiNamed = plan({ fields, fieldsSha256: fieldsHash(fields) });
    const result = await run({ input: { plan: thaiNamed, aiSuspect: { ...AI_SUSPECT, studentNames: ["สมชาย ใจดี", "สมชาย"] } } });
    // The name passed every text check: the correction lands.
    expect(result.outcome).toMatchObject({ status: "verified" });
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("refuses without the AI-suspect context (a student and a tutor name)", async () => {
    for (const aiSuspect of [
      { ...AI_SUSPECT, studentNames: [] },
      { ...AI_SUSPECT, tutorNames: [" "] },
      undefined as unknown as typeof AI_SUSPECT,
    ]) {
      const result = await run({ input: { aiSuspect } });
      expect(result.outcome).toEqual({ status: "refused", stage: "plan", reason: "ai_suspect_input_missing" });
      expectUntouched(result);
    }
  });

  it("refuses outside the window, before the database or Wise is read", async () => {
    const result = await run({ start: new Date("2026-10-02T19:16:00.000Z") });
    expect(result.outcome).toEqual({ status: "refused", stage: "window", reason: "outside_window" });
    expect(result.log).toEqual([]);
  });
});

describe("correctPostGuarded: database preconditions", () => {
  it("refuses with the store's codes before any Wise read", async () => {
    const one = await run({ store: { preconditions: ["row_changed"] } });
    expect(one.outcome).toEqual({ status: "refused", stage: "db", reason: "row_changed" });
    expect(one.log).toEqual(["store:preconditions"]);
    const two = await run({ store: { preconditions: ["owner_flag_open", "deadline_near"] } });
    expect(two.outcome).toEqual({ status: "refused", stage: "db", reason: "owner_flag_open,deadline_near" });
  });

  it("refuses when the preconditions cannot be read", async () => {
    const result = await run({ store: { preconditions: Object.assign(new Error("db down"), { code: "57P01" }) } });
    expect(result.outcome).toEqual({ status: "refused", stage: "db", reason: "preconditions_failed:57P01" });
    expectUntouched(result);
  });
});

describe("correctPostGuarded: Wise before the lock (no lock is taken)", () => {
  const two = (overrides: Record<string, unknown>) => autoBlankSubmission({ _id: "6a00000000000000000000c1", metadata: null, ...overrides });
  const cases: Array<[string, FakeWiseOptions, string]> = [
    ["an unreadable session", { detailOn: (call) => call === 1 ? new Error("down") : undefined }, "detail_read_failed:Error"],
    ["another session", { detailOn: () => postedDetail({ detail: { _id: "6a00000000000000000000d1" } }) }, "id_mismatch"],
    ["a disabled form", {
      detailOn: () => ({ ...postedDetail(), feedbackForm: { _id: "form1", profile: "teacher", enabled: false, questions: QUESTIONS } }),
    }, "form:feedback_form_missing_or_disabled"],
    ["a form that drifted (a required question gone)", {
      detailOn: () => postedDetail({ order: ["topics", "improvement", "homework"] }),
    }, "form:feedback_form_mapping_form_drift:missing required mapping: performance"],
    ["answers out of the form's order", {
      detailOn: () => postedDetail({ answerOrder: ["performance", "topics", "improvement", "homework"] }),
    }, "form:existing_answers_not_in_form_order"],
    ["two teacher submissions", {
      detailOn: () => ({ ...postedDetail(), feedbackSubmissions: [...postedDetail().feedbackSubmissions, two({})] }),
    }, "submission:count_2"],
    ["another submission", { detailOn: () => postedDetail({ submission: { _id: "6a00000000000000000000c2" } }) }, "submission:id_changed"],
    ["a submission flagged auto again", {
      detailOn: () => postedDetail({ submission: { metadata: { autoSubmitted: true } } }),
    }, "submission:auto_flagged"],
    ["changed billing", { detailOn: () => postedDetail({ submission: { sessionStatus: "ABSENT" } }) }, "submission:billing_changed"],
    ["changed credits", { detailOn: () => postedDetail({ submission: { creditsConsumed: 0 } }) }, "submission:billing_changed"],
    ["a meeting not ended", { detailOn: () => postedDetail({ detail: { meetingStatus: "STARTED" } }) }, "submission:meeting_STARTED"],
    ["another teacher", {
      detailOn: () => postedDetail({ detail: { userId: { _id: OTHER_TEACHER, name: "Synthetic Teacher" } } }),
    }, "teacher:changed"],
    ["text a person edited", {
      detailOn: () => postedDetail({ text: { ...BASE, homework: "Worksheet 4 by Friday." } }),
    }, "wise_text_differs_from_last_post"],
    ["text that differs only in whitespace (never squashed)", {
      detailOn: () => postedDetail({ text: { ...BASE, performance: `${BASE.performance} ` } }),
    }, "wise_text_differs_from_last_post"],
    ["no student with a Wise account", {
      detailOn: () => postedDetail({ detail: { participants: [
        { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
        { name: "Guest", isTeacher: false, inMeetingDuration: 3700 },
      ] } }),
    }, "student_id_missing"],
    ["two students with Wise accounts", {
      detailOn: () => postedDetail({ detail: { participants: [
        { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
        { wiseUserId: STUDENT_ID, name: "Somchai Jaidee", isTeacher: false, inMeetingDuration: 3700 },
        { wiseUserId: OTHER_STUDENT, name: "Malee Sukjai", isTeacher: false, inMeetingDuration: 3700 },
      ] } }),
    }, "student_count_2"],
    ["an unreadable credit history", { creditsOn: () => new Error("down") }, "credits_read_failed:Error"],
    ["a second charge", { credits: [{ credit: 1 }, { credit: 1 }] }, "credit_baseline:session_credit_entries_2"],
    ["no charge", { credits: [] }, "credit_baseline:session_credit_entries_0"],
    ["a charge other than the billed one", { credits: [{ credit: 0 }] }, "credit_baseline:session_credit_0"],
  ];
  it.each(cases)("refuses %s", async (_name, wise, reason) => {
    const result = await run({ wise });
    expect(result.outcome).toEqual({ status: "refused", stage: "wise", reason });
    expectUntouched(result);
  });

  it("refuses a teacher off the roster or switched off", async () => {
    const offRoster = await run({ input: { allowlist: new Set<string>() } });
    expect(offRoster.outcome).toEqual({ status: "refused", stage: "wise", reason: "teacher:not_allowlisted" });
    expectUntouched(offRoster);
    const off = await run({ input: { disabledTutors: [KEVIN_ONLINE_WISE_USER_ID] } });
    expect(off.outcome).toEqual({ status: "refused", stage: "wise", reason: "teacher:disabled" });
    expectUntouched(off);
  });
});

describe("correctPostGuarded: a form without a field the corrected text fills", () => {
  it("refuses before the lock", async () => {
    const fields = { ...CORRECTED, homework: "Worksheet 4 by Friday." };
    const result = await run({
      wise: { order: ["topics", "performance", "improvement"] },
      input: { plan: plan({ fields, fieldsSha256: fieldsHash(fields) }) },
    });
    expect(result.outcome).toEqual({ status: "refused", stage: "wise", reason: "form:form_lacks_field:homework" });
    expectUntouched(result);
  });
});

describe("correctPostGuarded: the lock", () => {
  it("refuses when the store cannot take it", async () => {
    const result = await run({ store: { lock: { ok: false, reason: "sweep_running" } } });
    expect(result.outcome).toEqual({ status: "refused", stage: "lock", reason: "lock:sweep_running" });
    expect(result.wise.postFeedback).not.toHaveBeenCalled();
    expect(result.store.releases).toBe(0);
    expect(result.log.at(-1)).toBe("store:lock");
  });

  it("refuses when taking it fails", async () => {
    const result = await run({ store: { lock: new Error("db down") } });
    expect(result.outcome).toEqual({ status: "refused", stage: "lock", reason: "lock:error:Error" });
    expect(result.wise.postFeedback).not.toHaveBeenCalled();
  });
});

describe("correctPostGuarded: the fresh read under the lock (refused → released, nothing sent)", () => {
  const second = (detail: Record<string, unknown> | Error) => (call: number) => (call === 2 ? detail : undefined);
  const cases: Array<[string, FakeWiseOptions, string, "wise" | "lock" | "plan"]> = [
    ["an unreadable session", { detailOn: second(new Error("down")) }, "detail_read_failed:Error", "wise"],
    ["a person's edit since the read before the lock", {
      detailOn: second(postedDetail({ text: { ...BASE, improvement: `${BASE.improvement} Also revise ratios.` } })),
    }, "wise_text_differs_from_last_post", "wise"],
    ["a billing change since the read before the lock", {
      detailOn: second(postedDetail({ submission: { sessionStatus: "ABSENT" } })),
    }, "submission:billing_changed", "wise"],
    ["another billed student", {
      detailOn: second(postedDetail({ detail: { participants: [
        { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 3800 },
        { wiseUserId: OTHER_STUDENT, name: "Malee Sukjai", isTeacher: false, inMeetingDuration: 3700, absolutePercentAttendance: 98 },
      ] } })),
    }, "student_changed", "wise"],
    ["a tutor's save since the first shot", {
      eventsBefore: [firstShotSave(), save(new Date(FIRST_SHOT_AT.getTime() + 3_600_000), KEVIN_ONLINE_WISE_USER_ID, "TEACHER")],
    }, "foreign_save_since_post", "wise"],
    ["a save by an unknown actor since the first shot", {
      eventsBefore: [firstShotSave(), save(new Date(FIRST_SHOT_AT.getTime() + 60_000), null, null, null)],
    }, "foreign_save_since_post", "wise"],
    ["a second API save since the first shot", {
      eventsBefore: [firstShotSave(), save(new Date(FIRST_SHOT_AT.getTime() + 7_200_000), API_ACTOR, "OWNER")],
    }, "extra_api_save", "wise"],
    ["no first-shot save in the events read", { eventsBefore: [] }, "first_shot_save_missing", "wise"],
    ["unreadable events", { eventsOn: () => new Error("down") }, "events_read_failed:Error", "wise"],
  ];
  it.each(cases)("refuses %s", async (_name, wise, reason, stage) => {
    const result = await run({ wise });
    expect(result.outcome).toEqual({ status: "refused", stage, reason });
    expectReleasedUnsent(result);
    // The refusing read came after the lock.
    expect(result.log.indexOf("store:lock")).toBeLessThan(result.log.indexOf("wise:detail#2"));
  });

  it("refuses once the lock budget is spent", async () => {
    const log: string[] = [];
    const time = clock();
    const wise = fakeWise(time, log);
    const store = memoryStore(log, { onLock: () => time.advance(CORRECTION_LOCK_BUDGET_MS) });
    const outcome = await correctPostGuarded({
      ops: wise, store, plan: plan(), apiActorId: API_ACTOR, allowlist: AUTOWRITER_TEACHER_ALLOWLIST, disabledTutors: [],
      aiSuspect: AI_SUSPECT, textProblems: () => [], now: time.now, sleep: time.sleep, eventWaitMs: 0,
    });
    expect(outcome).toEqual({ status: "refused", stage: "lock", reason: "lock_budget" });
    expect(wise.postFeedback).not.toHaveBeenCalled();
    expect(store.releases).toBe(1);
    expect(store.records).toEqual([]);
  });

  it("refuses a STOP that appears while the lock is held", async () => {
    const stopRequested = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const result = await run({ input: { stopRequested } });
    expect(result.outcome).toEqual({ status: "refused", stage: "plan", reason: "stop_requested" });
    expectReleasedUnsent(result);
  });
});

describe("correctPostGuarded: the posts row is claimed before the POST", () => {
  const cases: Array<[string, Error, string, "lock" | "db"]> = [
    ["the lock is lost (an owner pause or resume)", new CorrectionRefusedError("lock:lost"), "lock:lost", "lock"],
    ["the session row moved", new CorrectionRefusedError("row_changed"), "row_changed", "db"],
    ["a second agent correction (unique dedupe key)", Object.assign(new Error("duplicate"), { cause: { code: "23505" } }), "already_corrected", "db"],
    ["any other database error", Object.assign(new Error("boom"), { code: "57P01" }), "record_failed:57P01", "db"],
  ];
  it.each(cases)("refuses when %s — released, never posted", async (_name, error, reason, stage) => {
    const result = await run({ store: { record: error } });
    expect(result.outcome).toEqual({ status: "refused", stage, reason });
    expect(result.wise.postFeedback).not.toHaveBeenCalled();
    expect(result.store.releases).toBe(1);
    expect(result.log.filter((entry) => /^store:(settle|halt|incident)/u.test(entry))).toEqual([]);
  });
});

describe("correctPostGuarded: what the one POST did", () => {
  const safetyOrder = (log: string[]) => log.filter((entry) => /^store:(halt|settle|incident|release)/u.test(entry));

  it("HTTP 429 with the base text still in Wise: not_sent, released, never retried", async () => {
    const result = await run({ wise: { postResult: { kind: "rate_limited", status: 429 } } });
    expect(result.outcome).toEqual({ status: "not_sent", postId: "post-1", reason: "wise_rate_limited" });
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
    expect(result.store.settles).toMatchObject([{ outcome: "not_sent", verification: { httpStatus: 429, stillBase: true } }]);
    expect(result.store.settles[0]).not.toHaveProperty("session");
    expect(safetyOrder(result.log)).toEqual(["store:settle:not_sent", "store:release"]);
    expect(result.store.halts).toEqual([]);
  });

  it("HTTP 429 but the text changed anyway: halt → settle unknown_outcome → incident, lock kept", async () => {
    const result = await run({ wise: { postResult: { kind: "rate_limited", status: 429 }, applyPost: true } });
    expect(result.outcome).toMatchObject({ status: "safety", postId: "post-1" });
    if (result.outcome.status !== "safety") throw new Error("unreachable");
    expect(result.outcome.problems).toEqual(["http_429", "submission_changed_after_429"]);
    expect(safetyOrder(result.log)).toEqual(["store:halt", "store:settle:unknown_outcome", "store:incident"]);
    expect(result.store.releases).toBe(0);
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 with Wise unreadable: keeps the lock while it re-reads, then halts", async () => {
    const result = await run({
      wise: { postResult: { kind: "rate_limited", status: 429 }, detailOn: (call) => call >= 3 ? new Error("down") : undefined },
    });
    expect(result.outcome).toMatchObject({ status: "safety" });
    expect(result.time.sleep.mock.calls.filter(([ms]) => ms === CORRECTION_READ_RETRY_INTERVAL_MS)).toHaveLength(CORRECTION_READ_RETRIES);
    expect(safetyOrder(result.log)).toEqual(["store:halt", "store:settle:unknown_outcome", "store:incident"]);
    expect(result.store.releases).toBe(0);
  });

  it("HTTP 4xx: halts before reading back, then settles rejected — no response body recorded, lock kept", async () => {
    const result = await run({ wise: { postResult: { kind: "rejected", status: 400, body: "lesson text echoed back" }, applyPost: false } });
    expect(result.outcome).toMatchObject({ status: "safety", postId: "post-1" });
    expect(result.log.indexOf("store:halt")).toBeLessThan(result.log.indexOf("wise:detail#3"));
    expect(safetyOrder(result.log)).toEqual(["store:halt", "store:settle:rejected", "store:incident"]);
    const [settled] = result.store.settles;
    expect(settled.verification).toMatchObject({ httpStatus: 400, stillBase: true, landed: false });
    expect(JSON.stringify([settled, result.store.halts, result.store.incidents])).not.toContain("lesson text");
    expect(result.store.incidents).toMatchObject([{ dedupeKey: `correction_failed:${SESSION_ID}`, wiseSessionId: SESSION_ID }]);
    expect(result.store.releases).toBe(0);
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("an unknown outcome (5xx or a network error): halt → settle unknown_outcome → incident", async () => {
    const http = await run({ wise: { postResult: { kind: "unknown", error: "HTTP 503: upstream text" } } });
    expect(http.outcome).toMatchObject({ status: "safety" });
    if (http.outcome.status !== "safety") throw new Error("unreachable");
    expect(http.outcome.problems[0]).toBe("http_503");
    expect(safetyOrder(http.log)).toEqual(["store:halt", "store:settle:unknown_outcome", "store:incident"]);
    expect(JSON.stringify([http.store.settles, http.store.halts, http.store.incidents])).not.toContain("upstream text");

    const thrown = await run({ wise: { postResult: new TypeError("fetch failed") } });
    expect(thrown.outcome).toMatchObject({ status: "safety" });
    if (thrown.outcome.status !== "safety") throw new Error("unreachable");
    expect(thrown.outcome.problems[0]).toBe("post_error:TypeError");
    expect(thrown.wise.postFeedback).toHaveBeenCalledTimes(1);
    expect(thrown.store.releases).toBe(0);
  });

  const mismatches: Array<[string, FakeWiseOptions, string]> = [
    ["Wise stored other text", { storeAs: (fields) => ({ ...fields, performance: `${fields.performance}!` }) }, "field_mismatch:performance"],
    ["Wise kept the old text after a 2xx", { storeAs: () => BASE }, "field_mismatch:performance"],
    ["a second charge appeared", { creditsAfterPost: [{ credit: 1 }, { credit: 1 }] }, "credit_entries_changed:[1]->[1,1]"],
    ["the submission was replaced", {
      detailOn: (call) => call === 3 ? postedDetail({ text: CORRECTED, submission: { _id: "6a00000000000000000000c3" } }) : undefined,
    }, "submission_id_changed"],
    ["the billing changed", {
      detailOn: (call) => call === 3 ? postedDetail({ text: CORRECTED, submission: { creditsConsumed: 0 } }) : undefined,
    }, "credits_0"],
    ["someone else saved inside the POST window", {
      eventsAfterPost: (postedAt) => [
        save(new Date(postedAt.getTime() - 1_000), KEVIN_ONLINE_WISE_USER_ID, "TEACHER"),
        save(new Date(postedAt.getTime() + 500), API_ACTOR, "OWNER"),
      ],
    }, "foreign_submit_event_in_post_window"],
    ["a second API save landed inside the POST window", {
      eventsAfterPost: (postedAt) => [
        save(new Date(postedAt.getTime() + 500), API_ACTOR, "OWNER"),
        save(new Date(postedAt.getTime() + 900), API_ACTOR, "OWNER"),
      ],
    }, "extra_api_save_in_post_window:1"],
  ];
  it.each(mismatches)("2xx but %s: halt → settle verify_failed → incident, lock kept", async (_name, wise, problem) => {
    const result = await run({ wise });
    expect(result.outcome).toMatchObject({ status: "safety", postId: "post-1" });
    if (result.outcome.status !== "safety") throw new Error("unreachable");
    expect(result.outcome.problems).toContain(problem);
    expect(safetyOrder(result.log)).toEqual(["store:halt", "store:settle:verify_failed", "store:incident"]);
    expect(result.store.settles[0]).not.toHaveProperty("session");
    expect(result.store.releases).toBe(0);
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("read failures only: keeps the lock, re-reads every 30 s, and verifies once Wise answers", async () => {
    const result = await run({ wise: { detailOn: (call) => call === 3 || call === 4 ? new Error("down") : undefined } });
    expect(result.outcome).toMatchObject({ status: "verified" });
    expect(result.time.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      CORRECTION_READ_BACK_DELAY_MS, CORRECTION_READ_RETRY_INTERVAL_MS, CORRECTION_READ_RETRY_INTERVAL_MS,
    ]);
    // Never released while Wise could not be read.
    expect(result.log.indexOf("store:release")).toBe(result.log.length - 1);
    expect(result.store.halts).toEqual([]);
    expect(result.wise.postFeedback).toHaveBeenCalledTimes(1);
  });

  it("read failures only, for 4 minutes: safety, lock kept", async () => {
    const result = await run({ wise: { creditsOn: (call) => call >= 2 ? new Error("down") : undefined } });
    expect(result.outcome).toMatchObject({ status: "safety" });
    if (result.outcome.status !== "safety") throw new Error("unreachable");
    expect(result.outcome.problems).toEqual(["credits_reread_failed:Error", "read_failed_after_retries"]);
    expect(result.time.sleep.mock.calls.filter(([ms]) => ms === CORRECTION_READ_RETRY_INTERVAL_MS)).toHaveLength(CORRECTION_READ_RETRIES);
    expect(safetyOrder(result.log)).toEqual(["store:halt", "store:settle:verify_failed", "store:incident"]);
    expect(result.store.releases).toBe(0);
  });

  it("a text that landed but could not be recorded: halt, settle verify_failed, incident — lock kept", async () => {
    const result = await run({ store: { settleFails: [1] } });
    expect(result.outcome).toMatchObject({ status: "safety" });
    if (result.outcome.status !== "safety") throw new Error("unreachable");
    expect(result.outcome.problems).toEqual(["settle_failed:Error"]);
    expect(safetyOrder(result.log)).toEqual([
      "store:settle:verified", "store:halt", "store:settle:verify_failed", "store:incident",
    ]);
    expect(result.store.settles).toMatchObject([{ outcome: "verify_failed", verification: { landed: true } }]);
    expect(result.store.releases).toBe(0);
  });

  it("reports a settle or incident that fails on the safety path without hiding the halt", async () => {
    const result = await run({ wise: { creditsAfterPost: [] }, store: { settleFails: [1] } });
    expect(result.outcome).toMatchObject({ status: "safety" });
    if (result.outcome.status !== "safety") throw new Error("unreachable");
    expect(result.outcome.problems).toEqual(["credit_entries_changed:[1]->[]", "settle_failed:Error"]);
    expect(result.store.halts).toHaveLength(1);
    expect(result.store.incidents).toHaveLength(1);
  });
});
