import { beforeEach, describe, expect, it, vi } from "vitest";
import { openAtomReadClient } from "../atom/browser";

vi.mock("server-only", () => ({}));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), existsSync: () => true }));

const mock = vi.hoisted(() => ({
  activeCourses: undefined as number | undefined,
  status: 404,
  failedFeed: "islands",
  response: undefined as ((response: unknown) => void) | undefined,
  get: vi.fn(),
}));
vi.mock("playwright-core", () => ({ chromium: { launch: async () => ({
  close: async () => undefined,
  newContext: async () => ({
    close: async () => undefined,
    route: async () => undefined,
    cookies: async () => [{ name: "atom-auth" }],
    request: { get: mock.get },
    newPage: async () => ({
      setDefaultTimeout: () => undefined,
      on: (_: string, handler: typeof mock.response) => { mock.response = handler; },
      goto: async (url: string) => {
        if (url.endsWith("/tutor/students")) mock.response?.({
          url: () => "https://api.atomlearning.com/ms_accounts/users/1", status: () => 200,
          json: async () => ({ id_full_student: "_1", studentName: "Student", activeCourses: mock.activeCourses }),
        });
      },
      getByPlaceholder: () => ({ fill: async () => undefined }),
      getByRole: () => ({ click: async () => undefined }),
      waitForURL: async () => undefined,
      waitForFunction: async () => ({ jsonValue: async () => "1" }),
    }),
  }),
}) } }));

beforeEach(() => {
  vi.clearAllMocks();
  mock.activeCourses = 0;
  mock.status = 404;
  mock.failedFeed = "islands";
  mock.get.mockImplementation(async (url: string) => ({
    status: () => url.includes(mock.failedFeed) ? mock.status : 200,
    ok: () => !url.includes(mock.failedFeed) || mock.status === 200,
    text: async () => "[]",
  }));
});

describe("Atom course access", () => {
  it("keeps reading tests and practices when an inactive course has no learning plan", async () => {
    const client = await openAtomReadClient({ username: "test", password: "test", deadlineMs: Date.now() + 120_000 });
    try {
      await expect(client.collect("_1", ["2026-10-13"])).resolves.toEqual({ activities: [], skipped: [] });
      expect(mock.get.mock.calls.filter(([url]) => url.includes("mock_tests"))).toHaveLength(4);
      expect(mock.get.mock.calls.filter(([url]) => url.includes("custom_practices"))).toHaveLength(1);
    } finally { await client.close(); }
  });
  it("retains a mock test also listed in the learning plan, and rejects conflicting entries", async () => {
    const started = "2026-10-13T09:00:00.000Z", finished = "2026-10-13T10:00:00.000Z";
    let conflict = false;
    mock.get.mockImplementation(async (url: string) => {
      const body = url.includes("transcripts") ? { id_question_session: "_2", id_student: "_1", name: "Test", questionSessionType: "mock_test", totalQuestions: 1,
        isScoredUsingMarks: false, includesAiMarkedQuestions: false, score: 102, questions: [{ id_course_question: 1, responses: [{ id_student: "_1", id_course_question: 1,
          id_course_subject: 237, answeredAt: started, correct: true, noAttempt: false, autoResponse: false, tutorMode: false, secondsTaken: 10, id_homework: null }] }] }
        : !url.includes("id_course_subjects=237") ? [] : url.includes("mock_tests") ? [{ id_mock_test: "_2", id_student: "_1", name: "Test", completed: true,
          started, finished, id_course_subject: 237, score: 102, totalQuestions: 1, questionsCorrect: 1, questionsAnswered: 1 }]
        : [{ title: "Test", id_course_subject: conflict ? 235 : 237, status: "completed", sessions: [{ id_question_session: "_2", started, completed: finished }] }];
      return { status: () => 200, ok: () => true, text: async () => JSON.stringify(body) };
    });
    const client = await openAtomReadClient({ username: "test", password: "test", deadlineMs: Date.now() + 120_000 });
    try {
      expect((await client.collect("_1", ["2026-10-13"])).activities).toMatchObject([{ kind: "test", sas: 102, answers: [{ correct: true }] }]);
      conflict = true;
      await expect(client.collect("_1", ["2026-10-13"])).rejects.toMatchObject({ code: "source_contradiction", stage: "index_activity_conflict" });
    } finally { await client.close(); }
  });
  it.each([
    { activeCourses: 1, status: 404, feed: "islands", code: "collection_failed" },
    { activeCourses: undefined, status: 404, feed: "islands", code: "collection_failed" },
    { activeCourses: 0, status: 401, feed: "islands", code: "authentication_failed" },
    { activeCourses: 0, status: 500, feed: "islands", code: "collection_failed" },
    { activeCourses: 0, status: 404, feed: "custom_practices", code: "collection_failed" },
  ])("does not hide unavailable or failed reads: $activeCourses/$status/$feed", async ({ activeCourses, status, feed, code }) => {
    Object.assign(mock, { activeCourses, status, failedFeed: feed });
    const client = await openAtomReadClient({ username: "test", password: "test", deadlineMs: Date.now() + 120_000 });
    try { await expect(client.collect("_1", ["2026-10-13"])).rejects.toMatchObject({ code }); }
    finally { await client.close(); }
  });
});
