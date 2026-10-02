import { vi } from "vitest";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { CorrectionAiSuspectInput } from "../correction";
import type { PostResult, SubmitFeedbackEvent } from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { GOOD_FIELDS, QUESTIONS, STUDENT_NAME, autoBlankSubmission, sessionDetail } from "./fixtures";

/** Shared fakes for the agent-correction tests (unit and integration). Synthetic ids and invented lesson text only. */

export const API_ACTOR = "69366668c05630afe5d8a2a4";
export const OTHER_TEACHER = "6a00000000000000000000aa";
export const OTHER_STUDENT = "6a00000000000000000000bb";
export const START = new Date("2026-10-02T19:11:00.000Z"); // UTC minute 11: inside the window
export const FIRST_SHOT_AT = new Date("2026-10-02T09:40:00.000Z");
export const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 } as const;
export const BASE: FeedbackFieldAnswers = GOOD_FIELDS;
export const CORRECTED: FeedbackFieldAnswers = {
  ...GOOD_FIELDS,
  performance: "Somchai found common denominators quickly and explained each step of both word problems clearly. He checked every simplification with the highest common factor and corrected his own slips without prompting.",
};

/** The AI-suspect context of the synthetic class: the student's names, the tutor's, no prior feedback. */
export const AI_SUSPECT: CorrectionAiSuspectInput = { studentNames: [STUDENT_NAME, "Somchai"], tutorNames: ["Kevin Hsieh", "Kev"], priorFeedback: [] };

export type Field = keyof FeedbackFieldAnswers;
export const STANDARD_ORDER: Field[] = ["topics", "performance", "improvement", "homework"];
export const QUESTION_OF: Record<Field, (typeof QUESTIONS)[number]> = {
  topics: QUESTIONS[0], performance: QUESTIONS[1], improvement: QUESTIONS[2], homework: QUESTIONS[3],
};

/** A session whose one teacher submission holds `text` (our first shot, as Wise shows it after the POST). */
export function postedDetail(input: {
  text?: FeedbackFieldAnswers;
  order?: Field[];
  answerOrder?: Field[];
  submission?: Record<string, unknown>;
  detail?: Record<string, unknown>;
} = {}) {
  const order = input.order ?? STANDARD_ORDER;
  const text = input.text ?? BASE;
  return sessionDetail({
    feedbackForm: { _id: "form1", profile: "teacher", enabled: true, questions: order.map((field) => QUESTION_OF[field]) },
    feedbackSubmissions: [autoBlankSubmission({
      answers: (input.answerOrder ?? order).map((field, index) => ({
        _id: `a${index + 1}`, questionText: QUESTION_OF[field].questionText, type: QUESTION_OF[field].type, answer: text[field],
      })),
      metadata: null,
      ...input.submission,
    })],
    ...input.detail,
  });
}

export function clock(start = START) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
    sleep: vi.fn(async (ms: number) => { current += ms; }),
  };
}
export type Clock = ReturnType<typeof clock>;

export const save = (at: Date, actorId: string | null, actorRole: string | null, autoSubmitted: boolean | null = false): SubmitFeedbackEvent =>
  ({ at, actorId, actorRole, autoSubmitted });
export const firstShotSave = () => save(new Date(FIRST_SHOT_AT.getTime() + 1_000), API_ACTOR, "OWNER");

export interface FakeWiseOptions {
  order?: Field[];
  /** The detail for one getSessionDetail call (1-based), or an Error to throw; undefined → Wise's current state. */
  detailOn?: (call: number) => Record<string, unknown> | Error | undefined;
  postResult?: PostResult | Error;
  applyPost?: boolean;
  /** What Wise stores for a POST (default: exactly what was sent). */
  storeAs?: (fields: FeedbackFieldAnswers) => FeedbackFieldAnswers;
  credits?: Array<{ credit: number }>;
  creditsAfterPost?: Array<{ credit: number }>;
  creditsOn?: (call: number) => Error | undefined;
  eventsBefore?: SubmitFeedbackEvent[];
  eventsAfterPost?: (postedAt: Date) => SubmitFeedbackEvent[];
  eventsOn?: (call: number) => Error | undefined;
}

/** Fake Wise applying the POST the way the web-app edit does: same submission id, billing as sent. */
export function fakeWise(time: Clock, log: string[], options: FakeWiseOptions = {}) {
  const order = options.order ?? STANDARD_ORDER;
  let text = { ...BASE };
  let billing: { sessionStatus: string; creditsConsumed: number } = { sessionStatus: BILLING.sessionStatus, creditsConsumed: BILLING.creditsConsumed };
  let credits = options.credits ?? [{ credit: 1 }];
  let postedAt: Date | null = null;
  const posts: WiseFeedbackPostBody[] = [];
  const calls = { detail: 0, credits: 0, events: 0 };
  return {
    posts,
    getSessionDetail: vi.fn(async () => {
      calls.detail += 1;
      log.push(`wise:detail#${calls.detail}`);
      const override = options.detailOn?.(calls.detail);
      if (override instanceof Error) throw override;
      return { data: override ?? postedDetail({ text, order, submission: billing }) };
    }),
    postFeedback: vi.fn(async (_classId: string, _sessionId: string, body: WiseFeedbackPostBody): Promise<PostResult> => {
      log.push("wise:post");
      posts.push(body);
      if (options.postResult instanceof Error) throw options.postResult;
      if (options.applyPost ?? (options.postResult === undefined || options.postResult.kind === "sent")) {
        postedAt = time.now();
        const sent = Object.fromEntries(order.map((field, index) => [field, body.answers[index].answer])) as FeedbackFieldAnswers;
        text = options.storeAs?.(sent) ?? sent;
        billing = { sessionStatus: body.sessionStatus, creditsConsumed: body.creditsConsumed };
        credits = options.creditsAfterPost ?? credits;
      }
      return options.postResult ?? { kind: "sent", status: 200 };
    }),
    getSessionCreditEntries: vi.fn(async () => {
      calls.credits += 1;
      log.push(`wise:credits#${calls.credits}`);
      const failure = options.creditsOn?.(calls.credits);
      if (failure) throw failure;
      return credits;
    }),
    findFeedbackEvents: vi.fn(async (_classId: string, _sessionId: string, since: Date) => {
      calls.events += 1;
      log.push(`wise:events#${calls.events}`);
      const failure = options.eventsOn?.(calls.events);
      if (failure) throw failure;
      const after = postedAt ? (options.eventsAfterPost?.(postedAt) ?? [save(new Date(postedAt.getTime() + 500), API_ACTOR, "OWNER")]) : [];
      return [...(options.eventsBefore ?? [firstShotSave()]), ...after].filter((event) => event.at.getTime() >= since.getTime());
    }),
  };
}
