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
