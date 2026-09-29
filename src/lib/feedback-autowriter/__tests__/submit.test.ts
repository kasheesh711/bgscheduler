import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "../roster";
import {
  classifySubmitEvents,
  submitFeedbackGuarded,
  type ClaimPostResult,
  type PostFinishState,
  type PostResult,
  type SubmitFeedbackEvent,
  type SubmitPlan,
  type SubmitStore,
  type WiseFeedbackOps,
} from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { CLASS_ID, GOOD_FIELDS, NOW, QUESTIONS, SESSION_ID, answers, autoBlankSubmission, sessionDetail } from "./fixtures";

const API_ACTOR = "69366668c05630afe5d8a2a4";

type ClaimInput = Parameters<SubmitStore["claimPost"]>[0];

function memoryStore(options: { claim?: ClaimPostResult } = {}): SubmitStore & {
  claims: number;
  claimInputs: ClaimInput[];
  finishes: Array<{ state: PostFinishState; detail: Record<string, unknown> }>;
  halts: string[];
  log: string[];
} {
  const store = {
    claims: 0,
    claimInputs: [] as ClaimInput[],
    finishes: [] as Array<{ state: PostFinishState; detail: Record<string, unknown> }>,
    halts: [] as string[],
    log: [] as string[],
    async claimPost(input: ClaimInput) {
      store.claims += 1;
      store.claimInputs.push(input);
      store.log.push("claim");
      return options.claim ?? { claimed: true as const };
    },
    async finish(state: PostFinishState, detail: Record<string, unknown>) {
      store.finishes.push({ state, detail });
      store.log.push(`finish:${state}`);
    },
    async halt(reason: string) {
      store.halts.push(reason);
      store.log.push("halt");
    },
  };
  return store;
}

const ourEvent = (): SubmitFeedbackEvent => ({ at: new Date(Date.now() + 1_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" });

/** Fake Wise applying a POST the way the web-app edit does: same submission id, auto flag cleared. */
function fakeWise(options: {
  initial?: ReturnType<typeof sessionDetail>;
  postResult?: PostResult;
  applyPost?: boolean;
  storeAnswersAs?: (body: WiseFeedbackPostBody) => string[];
  creditsBefore?: Array<{ credit: number }>;
  creditsAfter?: Array<{ credit: number }>;
  events?: () => SubmitFeedbackEvent[];
} = {}): WiseFeedbackOps & { posts: WiseFeedbackPostBody[] } {
  let detail = options.initial ?? sessionDetail();
  let credits = options.creditsBefore ?? [{ credit: 1 }];
  let posted = false;
  const posts: WiseFeedbackPostBody[] = [];
  return {
    posts,
    getSessionDetail: vi.fn(async () => ({ data: structuredClone(detail) })),
    getSessionDetailById: vi.fn(async () => ({ data: structuredClone(detail) })),
    postFeedback: vi.fn(async (_classId: string, _sessionId: string, body: WiseFeedbackPostBody) => {
      posts.push(body);
      if (options.applyPost !== false) {
        posted = true;
        const stored = options.storeAnswersAs?.(body) ?? body.answers.map((answer) => answer.answer);
        detail = {
          ...detail,
          feedbackSubmissions: [autoBlankSubmission({
            answers: answers(stored as [string, string, string, string]),
            metadata: null,
            sessionStatus: body.sessionStatus,
            creditsConsumed: body.creditsConsumed,
          })],
        };
        credits = options.creditsAfter ?? credits;
      }
      return options.postResult ?? ({ kind: "sent", status: 200 } as const);
    }),
    getSessionCreditEntries: vi.fn(async () => credits),
    findFeedbackEvents: vi.fn(async () => (posted ? (options.events?.() ?? [ourEvent()]) : [])),
  };
}

const plan: SubmitPlan = {
  sessionId: SESSION_ID,
  classId: CLASS_ID,
  arm: "glm",
  fields: GOOD_FIELDS,
  billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
  expected: { kind: "auto_blank", submissionId: "6a0000000000000000000004", sessionStatus: "COMPLETED", creditsConsumed: 1 },
  mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS,
};
const base = {
  plan,
  gateInput: { now: NOW, allowlist: AUTOWRITER_TEACHER_ALLOWLIST },
  apiActorId: API_ACTOR,
  remainingMs: () => 600_000,
  sleep: async () => {},
  eventWaitMs: 0,
};

describe("submitFeedbackGuarded", () => {
  it("completes Wise's blank once and verifies text, billing, credit entry and the owner's submit event", async () => {
    const ops = fakeWise();
    const store = memoryStore();
    const outcome = await submitFeedbackGuarded({ ...base, ops, store });
    expect(outcome).toMatchObject({ status: "verified", event: { actorId: API_ACTOR } });
    expect(ops.posts).toEqual([{
      answers: [{ answer: GOOD_FIELDS.topics }, { answer: GOOD_FIELDS.performance }, { answer: GOOD_FIELDS.improvement }, { answer: "" }],
      sessionStatus: "COMPLETED",
      creditsConsumed: 1,
    }]);
    expect(store.claims).toBe(1);
    // The claim is bound to the teacher Wise showed in the fresh read.
    expect(store.claimInputs[0]).toMatchObject({ teacherId: "696e2c4343579bbada2340ed" });
    expect(store.claimInputs[0].freshReadAt).toBeInstanceOf(Date);
    expect(store.finishes.map((finish) => finish.state)).toEqual(["verified"]);
    expect(store.halts).toEqual([]);
  });

  it("preflight (dry run) reads and gates but never claims or posts", async () => {
    const ops = fakeWise();
    const store = memoryStore();
    expect((await submitFeedbackGuarded({ ...base, ops, store, dryRun: true })).status).toBe("preflight_ok");
    expect(ops.posts).toHaveLength(0);
    expect(store.claims).toBe(0);
  });

  it("never posts over feedback a human wrote after the draft was generated", async () => {
    const written = autoBlankSubmission({ metadata: null, answers: answers(["Tutor wrote this", "", "", ""]) });
    const ops = fakeWise({ initial: sessionDetail({ feedbackSubmissions: [written] }) });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store })).toEqual({ status: "aborted_precheck", reason: "human_submission", gate: true });
    expect(ops.posts).toHaveLength(0);
    expect(store.claims).toBe(0);
  });

  it("does not post when the store refuses the claim (paused, halted, off, tutor off, lease lost)", async () => {
    const ops = fakeWise();
    expect(await submitFeedbackGuarded({ ...base, ops, store: memoryStore({ claim: { claimed: false, reason: "conditions" } }) }))
      .toEqual({ status: "not_claimed", reason: "conditions" });
    expect(ops.posts).toHaveLength(0);
  });

  it("does not post while another session's POST is still in flight", async () => {
    const ops = fakeWise();
    expect(await submitFeedbackGuarded({ ...base, ops, store: memoryStore({ claim: { claimed: false, reason: "post_in_flight" } }) }))
      .toEqual({ status: "not_claimed", reason: "post_in_flight" });
    expect(ops.posts).toHaveLength(0);
  });

  it("does not claim without enough function time left for the POST and its checks", async () => {
    const ops = fakeWise();
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store, remainingMs: () => 60_000 }))
      .toEqual({ status: "aborted_precheck", reason: "function_budget_too_small_for_post" });
    expect(store.claims).toBe(0);
  });

  it("refuses when the credit history does not show exactly the auto-submission's charge", async () => {
    const ops = fakeWise({ creditsBefore: [] });
    expect(await submitFeedbackGuarded({ ...base, ops, store: memoryStore() }))
      .toEqual({ status: "aborted_precheck", reason: "credit_baseline:session_credit_entries_0" });
    expect(ops.posts).toHaveLength(0);
  });

  it("refuses non-empty homework when the form has no homework question", async () => {
    const ops = fakeWise({
      initial: sessionDetail({
        feedbackForm: { questions: QUESTIONS.slice(0, 3) },
        feedbackSubmissions: [autoBlankSubmission({ answers: answers(["", "", "", ""]).slice(0, 3) })],
      }),
    });
    const outcome = await submitFeedbackGuarded({ ...base, ops, store: memoryStore(), plan: { ...plan, fields: { ...GOOD_FIELDS, homework: "Worksheet 3" } } });
    expect(outcome).toEqual({ status: "aborted_precheck", reason: "form_lacks_field:homework" });
  });

  it("treats a 429 as not sent when the auto-submission is unchanged", async () => {
    const ops = fakeWise({ postResult: { kind: "rate_limited", status: 429 }, applyPost: false });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store })).toEqual({ status: "rate_limited" });
    expect(store.finishes.map((finish) => finish.state)).toEqual(["pending"]);
    expect(store.halts).toEqual([]);
  });

  it("records an unclear POST as unknown, halts, and never re-posts", async () => {
    const ops = fakeWise({ postResult: { kind: "unknown", error: "TimeoutError" } });
    const store = memoryStore();
    const outcome = await submitFeedbackGuarded({ ...base, ops, store });
    expect(outcome.status).toBe("unknown_outcome");
    expect(ops.posts).toHaveLength(1);
    expect(store.finishes.map((finish) => finish.state)).toEqual(["unknown_outcome"]);
    // Halt first, so nothing else posts while the read-back runs.
    expect(store.log).toEqual(["claim", "halt", "finish:unknown_outcome"]);
  });

  it("records a 4xx as rejected and halts before reading back", async () => {
    const ops = fakeWise({ postResult: { kind: "rejected", status: 400, body: "bad" }, applyPost: false });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store })).toEqual({ status: "rejected", httpStatus: 400, body: "bad" });
    expect(store.log).toEqual(["claim", "halt", "finish:rejected"]);
  });

  it("leaves a sent POST for reconciliation when only the read-back failed (no halt)", async () => {
    const ops = fakeWise();
    let reads = 0;
    const detailAfterPost = ops.getSessionDetail;
    ops.getSessionDetail = vi.fn(async (classId: string, sessionId: string) => {
      reads += 1;
      if (reads === 3) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return detailAfterPost(classId, sessionId);
    });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store }))
      .toEqual({ status: "unverified", problems: ["verify_read_failed:TimeoutError"] });
    expect(store.finishes).toEqual([]);
    expect(store.halts).toEqual([]);
  });

  it("fails verification (and halts) when Wise stores different text", async () => {
    const ops = fakeWise({ storeAnswersAs: (body) => body.answers.map((answer, index) => index === 0 ? "changed" : answer.answer) });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store })).toEqual({ status: "verify_failed", problems: ["field_mismatch:topics"] });
    expect(store.halts).toHaveLength(1);
  });

  it("fails verification on a second charge for the session", async () => {
    const ops = fakeWise({ creditsAfter: [{ credit: 1 }, { credit: 1 }] });
    expect(await submitFeedbackGuarded({ ...base, ops, store: memoryStore() }))
      .toEqual({ status: "verify_failed", problems: ["session_credit_entries_2"] });
  });

  it("halts when a tutor or admin submitted inside the POST window (possible overwrite)", async () => {
    const tutorEvent: SubmitFeedbackEvent = { at: new Date(), autoSubmitted: null, actorId: "tutor", actorRole: "TEACHER" };
    const ops = fakeWise({ events: () => [tutorEvent, ourEvent()] });
    const store = memoryStore();
    expect(await submitFeedbackGuarded({ ...base, ops, store }))
      .toEqual({ status: "verify_failed", problems: ["foreign_submit_event_in_post_window"] });
    expect(store.halts).toHaveLength(1);
  });

  it("does not count an edit made after our POST as a possible overwrite", async () => {
    const laterAdminEdit: SubmitFeedbackEvent = { at: new Date(Date.now() + 60_000), autoSubmitted: null, actorId: "admin", actorRole: "ADMIN" };
    const ops = fakeWise({ events: () => [ourEvent(), laterAdminEdit] });
    expect((await submitFeedbackGuarded({ ...base, ops, store: memoryStore() })).status).toBe("verified");
  });

  it("ignores student feedback events in the window", async () => {
    const studentEvent: SubmitFeedbackEvent = { at: new Date(), autoSubmitted: null, actorId: "student", actorRole: "STUDENT" };
    const ops = fakeWise({ events: () => [studentEvent, ourEvent()] });
    expect((await submitFeedbackGuarded({ ...base, ops, store: memoryStore() })).status).toBe("verified");
  });

  it("waits for the confirming event in a later run when it is not there yet", async () => {
    const ops = fakeWise({ events: () => [] });
    const store = memoryStore();
    expect((await submitFeedbackGuarded({ ...base, ops, store })).status).toBe("awaiting_event");
    expect(store.finishes.map((finish) => finish.state)).toEqual(["awaiting_event"]);
  });

  it("does not accept an auto-flagged or someone else's event as confirmation", async () => {
    const autoEvent: SubmitFeedbackEvent = { ...ourEvent(), autoSubmitted: true };
    const ops = fakeWise({ events: () => [autoEvent] });
    expect((await submitFeedbackGuarded({ ...base, ops, store: memoryStore() })).status).toBe("awaiting_event");
  });
});

describe("classifySubmitEvents", () => {
  const freshReadAt = new Date("2026-09-30T08:00:00.000Z");
  const postStartedAt = new Date("2026-09-30T08:00:04.000Z");
  const at = (offsetMs: number) => new Date(postStartedAt.getTime() + offsetMs);
  const input = { apiActorId: API_ACTOR, freshReadAt, postStartedAt };

  it("counts a teacher save between the fresh read and the POST as foreign", () => {
    const events: SubmitFeedbackEvent[] = [{ at: at(-2_000), autoSubmitted: null, actorId: "t", actorRole: "TEACHER" }];
    expect(classifySubmitEvents(events, input).foreign).toHaveLength(1);
  });

  it("ignores saves after the POST window, auto-submissions and students", () => {
    const events: SubmitFeedbackEvent[] = [
      { at: at(30_000), autoSubmitted: null, actorId: "t", actorRole: "TEACHER" },
      { at: at(-1_000), autoSubmitted: true, actorId: "t", actorRole: "TEACHER" },
      { at: at(-1_000), autoSubmitted: null, actorId: "s", actorRole: "STUDENT" },
    ];
    expect(classifySubmitEvents(events, input).foreign).toEqual([]);
  });

  it("takes ours only from the API owner, not auto-flagged, from the POST on", () => {
    const early: SubmitFeedbackEvent = { at: at(-60_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" };
    const mine: SubmitFeedbackEvent = { at: at(1_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" };
    expect(classifySubmitEvents([early], input).ours).toBeUndefined();
    expect(classifySubmitEvents([early, mine], input).ours).toBe(mine);
  });
});
