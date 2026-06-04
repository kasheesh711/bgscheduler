import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import {
  runTeacherHeadsUpNotifications,
  type TeacherHeadsUpEnrollment,
} from "@/lib/progress-tests/teacher-heads-up";
import type { ProgressTestAiSummary } from "@/lib/progress-tests/types";

// ── Fake db ───────────────────────────────────────────────────────────────
//
// teacher-heads-up.ts goes through the Drizzle fluent builder directly (it does
// not route every write through a mockable db.ts helper), so the tests stand up
// a small chainable fake that:
//  - resolves a select on tutor_contacts from `contactRows`,
//  - returns a stable id from the email-run insert,
//  - records every insert into progress_test_notifications, and
//  - records every update to progress_test_cycle_state (the notified stamp).

interface FakeDbState {
  contactRows: Array<{ onsiteEmail: string | null; onlineEmail: string | null; active: boolean }>;
  notificationInserts: Array<Record<string, unknown>>;
  emailRunInserts: Array<Record<string, unknown>>;
  cycleStateUpdates: Array<Record<string, unknown>>;
  emailRunId: string;
}

function makeFakeDb(state: FakeDbState): Database {
  const db = {
    select() {
      return {
        from(table: unknown) {
          const result = table === schema.tutorContacts ? state.contactRows : [];
          const chain = {
            where() {
              return chain;
            },
            limit() {
              return Promise.resolve(result);
            },
            then(resolve: (value: unknown[]) => unknown) {
              return Promise.resolve(result).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === schema.progressTestEmailRuns) {
            state.emailRunInserts.push(values);
            return {
              onConflictDoUpdate() {
                return {
                  returning() {
                    return Promise.resolve([{ id: state.emailRunId }]);
                  },
                };
              },
            };
          }
          if (table === schema.progressTestNotifications) {
            state.notificationInserts.push(values);
            return {
              onConflictDoUpdate() {
                return Promise.resolve(undefined);
              },
            };
          }
          return { onConflictDoUpdate: () => Promise.resolve(undefined) };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          if (table === schema.progressTestCycleState) {
            state.cycleStateUpdates.push(values);
          }
          return {
            where() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
  return db as unknown as Database;
}

function freshState(overrides: Partial<FakeDbState> = {}): FakeDbState {
  return {
    contactRows: [{ onsiteEmail: "onsite@example.com", onlineEmail: "online@example.com", active: true }],
    notificationInserts: [],
    emailRunInserts: [],
    cycleStateUpdates: [],
    emailRunId: "email-run-1",
    ...overrides,
  };
}

function makeSender(impl?: ScheduleEmailSender["sendEmail"]): ScheduleEmailSender {
  return {
    sendEmail: vi.fn(impl ?? (async () => ({ id: "provider-msg-1" }))),
  };
}

const SUMMARY: ProgressTestAiSummary = {
  headline: "Strong on fundamentals, building exam stamina.",
  strengths: ["Mental math", "Asks good questions"],
  focusAreas: ["Timed practice"],
  recommendation: "Run a short timed set before the test.",
};

function makeEnrollment(
  overrides: Partial<TeacherHeadsUpEnrollment> = {},
): TeacherHeadsUpEnrollment {
  return {
    enrollmentKey: "class-1|student-1",
    cycleIndex: 0,
    studentName: "Ada Lovelace",
    subject: "Math",
    currentCount: 6,
    mostFrequentTutorCanonicalKey: "alice",
    mostFrequentTutorDisplayName: "Alice",
    aiSummary: SUMMARY,
    ...overrides,
  };
}

describe("runTeacherHeadsUpNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends one heads-up email and stamps the notified marker on success", async () => {
    const state = freshState();
    const sender = makeSender();

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment()],
      sender,
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.unresolved).toBe(0);
    expect(sender.sendEmail).toHaveBeenCalledTimes(1);

    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Subject + per-cycle idempotency key contract.
    expect(sent.subject).toBe("[BeGifted] Progress test coming up for Ada Lovelace (Math)");
    expect(sent.idempotencyKey).toBe("progress-test:teacher:class-1|student-1:0");
    // Onsite email is preferred over the online fallback.
    expect(sent.to).toBe("onsite@example.com");

    // A successful send stamps teacherNotifiedAt + teacherNotifiedForCycle.
    expect(state.cycleStateUpdates).toHaveLength(1);
    expect(state.cycleStateUpdates[0].teacherNotifiedForCycle).toBe(0);
    expect(state.cycleStateUpdates[0].teacherNotifiedAt).toBeInstanceOf(Date);

    // The notification row records the resolved recipient + sent status.
    expect(state.notificationInserts).toHaveLength(1);
    expect(state.notificationInserts[0].status).toBe("sent");
    expect(state.notificationInserts[0].recipientEmail).toBe("onsite@example.com");
  });

  it("falls back to the online email when no onsite email is configured", async () => {
    const state = freshState({
      contactRows: [{ onsiteEmail: null, onlineEmail: "online@example.com", active: true }],
    });
    const sender = makeSender();

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment()],
      sender,
    });

    expect(result.sent).toBe(1);
    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.to).toBe("online@example.com");
  });

  it("records an unresolved notification (no send, no stamp) when no email resolves", async () => {
    const state = freshState({ contactRows: [] });
    const sender = makeSender();

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment()],
      sender,
    });

    expect(result.unresolved).toBe(1);
    expect(result.sent).toBe(0);
    expect(sender.sendEmail).not.toHaveBeenCalled();

    // Unresolved: a notification row is recorded but the notified marker is NOT stamped.
    expect(state.notificationInserts).toHaveLength(1);
    expect(state.notificationInserts[0].status).toBe("unresolved");
    expect(state.cycleStateUpdates).toHaveLength(0);
    // No email-run row is created for an unresolved enrollment.
    expect(state.emailRunInserts).toHaveLength(0);
  });

  it("records an unresolved notification when there is no most-frequent tutor", async () => {
    const state = freshState();
    const sender = makeSender();

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment({ mostFrequentTutorCanonicalKey: null })],
      sender,
    });

    expect(result.unresolved).toBe(1);
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("records a failed (not sent) notification and does NOT stamp when the send throws", async () => {
    const state = freshState();
    const sender = makeSender(async () => {
      throw new Error("Apps Script email send failed");
    });

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment()],
      sender,
    });

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    // A failed send still records the email-run + notification (so a later run can retry)...
    expect(state.emailRunInserts).toHaveLength(1);
    expect(state.notificationInserts).toHaveLength(1);
    expect(state.notificationInserts[0].status).toBe("failed");
    expect(state.notificationInserts[0].error).toBe("Apps Script email send failed");
    // ...but the notified marker is NOT stamped, so the next run will retry.
    expect(state.cycleStateUpdates).toHaveLength(0);
  });

  it("is fire-and-forget safe: a failing send for one enrollment never aborts the rest", async () => {
    const state = freshState();
    // The first enrollment's send fails; the second must still be attempted + sent.
    const sender = makeSender(async (input) => {
      if (input.subject.includes("Ada")) throw new Error("boom");
      return { id: "provider-msg-2" };
    });

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [
        makeEnrollment({ enrollmentKey: "class-1|student-1", studentName: "Ada Lovelace" }),
        makeEnrollment({ enrollmentKey: "class-2|student-2", studentName: "Bo Carter", subject: "English" }),
      ],
      sender,
    });

    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("uses a stable per-cycle idempotency key across the email run, notification, and send", async () => {
    const state = freshState();
    const sender = makeSender();

    await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment({ enrollmentKey: "class-9|student-9", cycleIndex: 2 })],
      sender,
    });

    const expectedKey = "progress-test:teacher:class-9|student-9:2";
    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The same key drives the provider dedup and both DB rows, so a re-run upserts
    // (rather than duplicates) and the provider treats the resend as the same email.
    expect(sent.idempotencyKey).toBe(expectedKey);
    expect(state.emailRunInserts[0].idempotencyKey).toBe(expectedKey);
    expect(state.notificationInserts[0].idempotencyKey).toBe(expectedKey);
  });

  it("uses the graceful fallback body when no AI summary is present", async () => {
    const state = freshState();
    const sender = makeSender();

    await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment({ aiSummary: null })],
      sender,
    });

    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.text).toContain("please review recent classes");
    expect(sent.html).toContain("review the student");
    // No fabricated summary fields when the summary is absent.
    expect(sent.text).not.toContain("Strengths:");
  });

  it("includes the AI summary block when a summary is present", async () => {
    const state = freshState();
    const sender = makeSender();

    await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [makeEnrollment({ aiSummary: SUMMARY })],
      sender,
    });

    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.text).toContain(SUMMARY.headline);
    expect(sent.text).toContain("Mental math");
    expect(sent.html).toContain(SUMMARY.headline);
  });

  it("returns zero counts and never sends for an empty enrollment list", async () => {
    const state = freshState();
    const sender = makeSender();

    const result = await runTeacherHeadsUpNotifications(makeFakeDb(state), {
      syncRunId: "run-1",
      enrollments: [],
      sender,
    });

    expect(result.attempted).toBe(0);
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });
});
