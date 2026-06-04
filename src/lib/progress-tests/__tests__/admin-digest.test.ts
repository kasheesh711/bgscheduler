import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import { sendProgressTestAdminDigest } from "@/lib/progress-tests/admin-digest";

// ── Fake db ───────────────────────────────────────────────────────────────
//
// admin-digest.ts uses the Drizzle fluent builder directly, so the tests stand
// up a small chainable fake. Reads are routed by table reference; writes are
// recorded so we can assert the run + per-recipient outcomes.

interface FakeDbState {
  adminEmails: string[];
  cycleRows: Array<{
    studentName: string;
    subject: string;
    currentCount: number;
    status: string;
    bookedTestWiseSessionId: string | null;
    tutorDisplayName: string | null;
  }>;
  unresolvedNotificationRows: Array<{ recipientEmail: string }>;
  terminalDigestRows: Array<{ id: string }>;
  digestRunId: string;
  digestRunInsertConflict: boolean;
  digestRunUpdates: Array<Record<string, unknown>>;
  recipientInserts: Array<Record<string, unknown>>;
}

function makeFakeDb(state: FakeDbState): Database {
  function selectResultFor(table: unknown): unknown[] {
    if (table === schema.adminUsers) return state.adminEmails.map((email) => ({ email }));
    if (table === schema.progressTestCycleState) return state.cycleRows;
    if (table === schema.progressTestNotifications) return state.unresolvedNotificationRows;
    if (table === schema.progressTestAdminDigestRuns) return state.terminalDigestRows;
    return [];
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          const result = selectResultFor(table);
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
          if (table === schema.progressTestAdminDigestRuns) {
            if (state.digestRunInsertConflict) {
              const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
              return { returning: () => Promise.reject(conflict) };
            }
            return {
              returning: () =>
                Promise.resolve([{ id: state.digestRunId, ...values }]),
            };
          }
          if (table === schema.progressTestAdminDigestRecipients) {
            state.recipientInserts.push(values);
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          if (table === schema.progressTestAdminDigestRuns) {
            state.digestRunUpdates.push(values);
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
    adminEmails: ["a@x.com", "b@x.com"],
    cycleRows: [],
    unresolvedNotificationRows: [],
    terminalDigestRows: [],
    digestRunId: "digest-run-1",
    digestRunInsertConflict: false,
    digestRunUpdates: [],
    recipientInserts: [],
    ...overrides,
  };
}

function makeSender(impl?: ScheduleEmailSender["sendEmail"]): ScheduleEmailSender {
  return { sendEmail: vi.fn(impl ?? (async () => ({ id: "provider-msg-1" }))) };
}

const NOW = new Date("2026-06-04T01:00:00.000Z"); // 08:00 Bangkok → digestDate 2026-06-04

describe("sendProgressTestAdminDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips the send (no email) and records a terminal skipped run when there is nothing to report", async () => {
    const state = freshState(); // no approaching, no due, no unresolved
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("skipped");
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect(state.recipientInserts).toHaveLength(0);
    // A terminal skipped run row is still recorded for the date.
    expect(state.digestRunUpdates).toHaveLength(1);
    expect(state.digestRunUpdates[0].status).toBe("skipped");
  });

  it("short-circuits without inserting a run when a terminal digest already exists for the date", async () => {
    const state = freshState({
      terminalDigestRows: [{ id: "already" }],
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 6,
          status: "approaching",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Alice",
        },
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("skipped");
    expect(result.digestRunId).toBeNull();
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("sends to ALL admins exactly once each when there is content to report", async () => {
    const state = freshState({
      adminEmails: ["b@x.com", "a@x.com", "A@x.com"], // deduped + lowercased + sorted by the loader
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 6,
          status: "approaching",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Alice",
        },
        {
          studentName: "Bo",
          subject: "English",
          currentCount: 8,
          status: "due",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Bob",
        },
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("sent");
    expect(result.approachingCount).toBe(1);
    expect(result.dueCount).toBe(1);
    // Two unique admin recipients (a@x.com, b@x.com); the duplicate A@x.com folds in.
    expect(sender.sendEmail).toHaveBeenCalledTimes(2);
    const recipients = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].to);
    expect(recipients).toEqual(["a@x.com", "b@x.com"]);
    // Per-recipient Apps Script idempotency key is date + email scoped.
    const firstKey = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0].idempotencyKey;
    expect(firstKey).toBe("progress-test-digest:2026-06-04:a@x.com");
    expect(state.recipientInserts).toHaveLength(2);
    expect(state.recipientInserts.every((row) => row.status === "sent")).toBe(true);
  });

  it("excludes due students that already have a booked test", async () => {
    const state = freshState({
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 8,
          status: "due",
          bookedTestWiseSessionId: "wise-session-1", // already booked → excluded
          tutorDisplayName: "Alice",
        },
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    // The only candidate was a booked due student → nothing reportable → skipped.
    expect(result.status).toBe("skipped");
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("reports unresolved teacher emails in the action-needed section", async () => {
    const state = freshState({
      unresolvedNotificationRows: [
        { recipientEmail: "unresolved:carol" },
        { recipientEmail: "unresolved:carol" }, // deduped
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("sent");
    expect(result.unresolvedCount).toBe(1);
    const sent = (sender.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.text).toContain("Action needed");
    expect(sent.text).toContain("unresolved:carol");
    expect(sent.html).toContain("Action needed");
  });

  it("records a partial run when some recipients fail", async () => {
    const state = freshState({
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 6,
          status: "approaching",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Alice",
        },
      ],
    });
    const sender = makeSender(async (input) => {
      if (input.to === "a@x.com") throw new Error("send failed");
      return { id: "provider-msg-2" };
    });

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("partial");
    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(state.recipientInserts.find((row) => row.recipientEmail === "a@x.com")?.status).toBe("failed");
    expect(state.recipientInserts.find((row) => row.recipientEmail === "b@x.com")?.status).toBe("sent");
  });

  it("fails the run when no admin recipients are configured", async () => {
    const state = freshState({
      adminEmails: [],
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 6,
          status: "approaching",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Alice",
        },
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("failed");
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it("treats a unique-key conflict on the run insert as already-created (skipped)", async () => {
    const state = freshState({
      digestRunInsertConflict: true,
      cycleRows: [
        {
          studentName: "Ada",
          subject: "Math",
          currentCount: 6,
          status: "approaching",
          bookedTestWiseSessionId: null,
          tutorDisplayName: "Alice",
        },
      ],
    });
    const sender = makeSender();

    const result = await sendProgressTestAdminDigest(makeFakeDb(state), NOW, { sender });

    expect(result.status).toBe("skipped");
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });
});
