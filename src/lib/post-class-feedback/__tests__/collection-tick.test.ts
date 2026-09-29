import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/post-class-feedback/sync", () => ({ runPostClassFeedbackSync: vi.fn() }));
vi.mock("@/lib/post-class-feedback/ai", () => ({ processPostClassAiReviews: vi.fn() }));
vi.mock("@/lib/post-class-feedback/notifications", () => ({ processDuePostClassNotificationRetries: vi.fn() }));
vi.mock("@/lib/post-class-feedback/auto-approval", () => ({ runPostClassDeductionHygiene: vi.fn() }));
vi.mock("@/lib/post-class-feedback/repository", () => ({
  PostClassFeedbackSyncAlreadyRunningError: class PostClassFeedbackSyncAlreadyRunningError extends Error {},
}));

import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import { runPostClassDeductionHygiene } from "@/lib/post-class-feedback/auto-approval";
import {
  runPostClassCollectionTick,
  runPostClassCollectionTickRequest,
} from "@/lib/post-class-feedback/collection-tick";
import { processDuePostClassNotificationRetries } from "@/lib/post-class-feedback/notifications";
import { PostClassFeedbackSyncAlreadyRunningError } from "@/lib/post-class-feedback/repository";
import { runPostClassFeedbackSync } from "@/lib/post-class-feedback/sync";

// Distinct values per pass, so a swapped response key fails the equality checks.
const SYNC = { runId: "pc-run-1", status: "success" };
const AI = { processed: 1, failed: 0, skipped: 2 };
const RETRIES = { considered: 3, sent: 3, failed: 0, cancelled: 0, deferred: 0 };
const HYGIENE = { reopened: 0, reopenFailed: 0, waived: 1, waiveFailed: 0 };
const BODY = { ok: true, result: SYNC, ai: AI, retries: RETRIES, hygiene: HYGIENE };
const PASSES = [processPostClassAiReviews, processDuePostClassNotificationRetries, runPostClassDeductionHygiene];
const LOG_TAG = "[post-class-collection-tick]";

/** An error whose class name and message differ, so a leaked message is easy to spot. */
function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runPostClassFeedbackSync).mockResolvedValue(SYNC as never);
  vi.mocked(processPostClassAiReviews).mockResolvedValue(AI);
  vi.mocked(processDuePostClassNotificationRetries).mockResolvedValue(RETRIES);
  vi.mocked(runPostClassDeductionHygiene).mockResolvedValue(HYGIENE);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("runPostClassCollectionTick", () => {
  it("passes the options to the sync unchanged and starts the three passes only after it resolves", async () => {
    let finishSync!: (result: unknown) => void;
    vi.mocked(runPostClassFeedbackSync).mockReturnValueOnce(
      new Promise<unknown>((resolve) => { finishSync = resolve; }) as never,
    );
    const options = {
      triggerType: "manual",
      actorEmail: "manager@example.com",
      detailCap: 25,
      startDate: "2026-09-01",
      endDate: "2026-09-04",
    } as const;

    const pending = runPostClassCollectionTick(options);
    // Give an eagerly started pass the chance to run while the sync is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const pass of PASSES) expect(pass).not.toHaveBeenCalled();

    finishSync(SYNC);

    expect(await pending).toEqual(BODY);
    expect(runPostClassFeedbackSync).toHaveBeenCalledTimes(1);
    expect(runPostClassFeedbackSync).toHaveBeenCalledWith(options);
    for (const pass of PASSES) {
      expect(pass).toHaveBeenCalledTimes(1);
      expect(pass).toHaveBeenCalledWith();
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ["ai", () => vi.mocked(processPostClassAiReviews).mockRejectedValueOnce(
      namedError("DriverError", "select topics from post_class_feedback_versions where id = $1"),
    )],
    ["retries", () => vi.mocked(processDuePostClassNotificationRetries).mockRejectedValueOnce(
      namedError("DriverError", "update post_class_notification_deliveries set recipient = 'tutor@example.com'"),
    )],
    ["hygiene", () => vi.mocked(runPostClassDeductionHygiene).mockRejectedValueOnce(
      namedError("DriverError", "update post_class_deductions set status = 'waived' params: [\"ded-1\"]"),
    )],
  ] as const)("reports a rejected %s pass as { failed: true } and logs only its name and error class", async (pass, reject) => {
    reject();

    const body = await runPostClassCollectionTick({ triggerType: "cron" });

    expect(body).toEqual({ ...BODY, [pass]: { failed: true } });
    // Exact arguments: nothing beyond the pass name and error class reaches the log.
    expect(consoleError.mock.calls).toEqual([[LOG_TAG, { pass, errorName: "DriverError" }]]);
  });

  it("logs every rejected pass, a non-Error rejection as UnknownError, and still answers ok with the sync result", async () => {
    vi.mocked(processPostClassAiReviews).mockRejectedValueOnce(namedError("AiError", "tutor feedback text"));
    vi.mocked(processDuePostClassNotificationRetries).mockRejectedValueOnce(namedError("RetryError", "tutor@example.com"));
    vi.mocked(runPostClassDeductionHygiene).mockRejectedValueOnce("hygiene rejected with a string");

    const body = await runPostClassCollectionTick({ triggerType: "cron" });

    expect(body).toEqual({
      ok: true,
      result: SYNC,
      ai: { failed: true },
      retries: { failed: true },
      hygiene: { failed: true },
    });
    expect(consoleError.mock.calls).toEqual([
      [LOG_TAG, { pass: "ai", errorName: "AiError" }],
      [LOG_TAG, { pass: "retries", errorName: "RetryError" }],
      [LOG_TAG, { pass: "hygiene", errorName: "UnknownError" }],
    ]);
  });

  it("lets a sync failure reach the caller without running or logging any pass", async () => {
    const failure = namedError("DrizzleQueryError", "insert into post_class_sync_runs params: manager@example.com");
    vi.mocked(runPostClassFeedbackSync).mockRejectedValueOnce(failure);

    await expect(
      runPostClassCollectionTick({ triggerType: "manual", actorEmail: "manager@example.com" }),
    ).rejects.toBe(failure);
    for (const pass of PASSES) expect(pass).not.toHaveBeenCalled();
    // The caller's mapper decides whether and how to log it.
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("runPostClassCollectionTickRequest", () => {
  it("answers 200 with the tick body, passing the trigger through to the sync", async () => {
    const response = await runPostClassCollectionTickRequest({ triggerType: "cron" });

    expect(runPostClassFeedbackSync).toHaveBeenCalledWith({ triggerType: "cron" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(BODY);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps a rejected pass inside the 200, logged, so the sync itself still counts as run", async () => {
    vi.mocked(runPostClassDeductionHygiene).mockRejectedValueOnce(namedError("HygieneError", "deduction ded-1"));

    const response = await runPostClassCollectionTickRequest({ triggerType: "manual", actorEmail: "manager@example.com" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...BODY, hygiene: { failed: true } });
    expect(consoleError.mock.calls).toEqual([[LOG_TAG, { pass: "hygiene", errorName: "HygieneError" }]]);
  });

  it.each([
    "Post-class feedback sync is already running.",
    "Post-class feedback sync is deferred while a payout operation holds a live lease.",
  ])("returns the typed already-running error as a 409 with its own message: %s", async (message) => {
    vi.mocked(runPostClassFeedbackSync).mockRejectedValueOnce(new PostClassFeedbackSyncAlreadyRunningError(message));

    const response = await runPostClassCollectionTickRequest({ triggerType: "cron" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: message });
    for (const pass of PASSES) expect(pass).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    // Thrown before the sync run row exists, so nothing else records it.
    ["an unset institute id", namedError("Error", "WISE_INSTITUTE_ID is not configured"), "Error"],
    ["a driver error", namedError("DrizzleQueryError", "Failed query: insert into post_class_sync_runs params: manager@example.com"), "DrizzleQueryError"],
    // Says "already running" but is not the typed error, so it must still be a 500.
    ["an untyped already-running message", namedError("Error", "advisory lock already running"), "Error"],
    ["a non-Error rejection", "sync rejected with a string", "UnknownError"],
  ] as const)("maps %s to the generic 500 and logs only the error class", async (_label, thrown, errorName) => {
    vi.mocked(runPostClassFeedbackSync).mockRejectedValueOnce(thrown);

    const response = await runPostClassCollectionTickRequest({ triggerType: "cron" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Post-class feedback sync failed" });
    expect(consoleError.mock.calls).toEqual([[LOG_TAG, { pass: "sync", errorName }]]);
    for (const pass of PASSES) expect(pass).not.toHaveBeenCalled();
  });
});
