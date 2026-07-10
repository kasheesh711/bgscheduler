import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

const { events } = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@/lib/admissions/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/notifications")>()),
  deliverAdmissionsOutboxBestEffort: vi.fn(async () => {
    events.push("deliver");
    return { attempted: 1, sent: 0, skipped: 0, failed: 1, errors: ["provider down"] };
  }),
}));

import {
  admissionsAuditLog,
  admissionsNotificationOutbox,
} from "@/lib/db/schema";
import { sendCaseDirectMessage } from "@/lib/admissions/communications";
import { deliverAdmissionsOutboxBestEffort } from "@/lib/admissions/notifications";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const OUTBOX_ID = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function fakeDb(
  queue: Row[][],
  options: { outboxConflict?: boolean } = {},
) {
  let selectIndex = 0;
  const inserts: Array<{ table: unknown; values: Row }> = [];

  function selectBuilder(rows: Row[]) {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
      builder[method] = () => builder;
    }
    builder.then = (
      resolve: (value: Row[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return builder;
  }

  const tx = {
    select: () => selectBuilder(queue[selectIndex++] ?? []),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const shouldConflict = table === admissionsNotificationOutbox && options.outboxConflict;
        if (!shouldConflict) {
          inserts.push({ table, values });
          events.push(table === admissionsNotificationOutbox ? "outbox" : "audit");
        }
        const returning = async () => shouldConflict ? [] : [{ id: OUTBOX_ID }];
        return {
          onConflictDoNothing: () => ({ returning }),
          returning,
          then: (
            resolve: (value: undefined) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  };

  const db = {
    ...tx,
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      events.push("commit");
      return result;
    },
  };
  return { db: db as never, inserts };
}

function recipient(overrides: Row = {}): Row {
  return {
    id: MEMBER_ID,
    email: "student@example.com",
    role: "student",
    familyPortalOpen: true,
    caseStatus: "active",
    ...overrides,
  };
}

const access = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor" as const,
  isAdmin: false,
};

afterEach(() => {
  events.length = 0;
  vi.clearAllMocks();
});

describe("sendCaseDirectMessage", () => {
  it("commits the outbox and audit before attempting provider delivery", async () => {
    const { db, inserts } = fakeDb([
      [recipient()],
      [{ status: "failed", providerMessageId: null }],
      [],
    ]);

    const result = await sendCaseDirectMessage({
      access,
      recipientMemberId: MEMBER_ID,
      senderName: "Kai Counselor",
      subject: "Application update",
      body: "Your checklist is ready.",
      idempotencyKey: IDEMPOTENCY_KEY,
    }, db);

    expect(events).toEqual(["outbox", "audit", "commit", "deliver"]);
    expect(inserts.find((row) => row.table === admissionsNotificationOutbox)?.values)
      .toMatchObject({
        category: "direct_message",
        dedupeKey: `direct-message:${CASE_ID}:${IDEMPOTENCY_KEY}`,
      });
    expect(inserts.find((row) => row.table === admissionsAuditLog)?.values)
      .toMatchObject({
        action: "queue",
        entityId: OUTBOX_ID,
        actorEmail: "counselor@example.com",
      });
    expect(result).toEqual({
      outboxId: OUTBOX_ID,
      deliveryStatus: "queued",
      providerMessageId: null,
      idempotentReplay: false,
    });
  });

  it("reuses an identical client key without writing a second audit entry", async () => {
    const dedupeKey = `direct-message:${CASE_ID}:${IDEMPOTENCY_KEY}`;
    const { db, inserts } = fakeDb([
      [recipient()],
      [{
        id: OUTBOX_ID,
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        recipientEmail: "student@example.com",
        category: "direct_message",
        payload: {
          senderName: "Kai Counselor",
          subject: "Application update",
          body: "Your checklist is ready.",
        },
      }],
      [{ status: "sent", providerMessageId: "email_123" }],
      [{ providerMessageId: "email_123" }],
    ], { outboxConflict: true });

    const result = await sendCaseDirectMessage({
      access,
      recipientMemberId: MEMBER_ID,
      senderName: "Kai Counselor",
      subject: "Application update",
      body: "Your checklist is ready.",
      idempotencyKey: IDEMPOTENCY_KEY,
    }, db);

    expect(inserts.some((row) => row.table === admissionsAuditLog)).toBe(false);
    expect(result).toMatchObject({
      deliveryStatus: "sent",
      providerMessageId: "email_123",
      idempotentReplay: true,
    });
    expect(deliverAdmissionsOutboxBestEffort).toHaveBeenCalledWith([OUTBOX_ID], db);
    expect(dedupeKey).toContain(IDEMPOTENCY_KEY);
  });

  it("refuses a family recipient while the family portal is closed", async () => {
    const { db, inserts } = fakeDb([[recipient({ familyPortalOpen: false })]]);

    await expect(sendCaseDirectMessage({
      access,
      recipientMemberId: MEMBER_ID,
      senderName: "Kai Counselor",
      subject: "Application update",
      body: "Your checklist is ready.",
      idempotencyKey: IDEMPOTENCY_KEY,
    }, db)).rejects.toThrow("Conflict");

    expect(inserts).toHaveLength(0);
    expect(deliverAdmissionsOutboxBestEffort).not.toHaveBeenCalled();
  });
});
