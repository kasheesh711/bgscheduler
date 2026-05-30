import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseActivityEvent, WiseSession, WiseTeacher } from "@/lib/wise/types";
import { runPayrollSync } from "../sync";

const now = new Date("2026-05-31T00:00:00.000Z");

type Table = Parameters<Database["insert"]>[0];

function teacher(): WiseTeacher {
  return {
    _id: "teacher-1",
    userId: { _id: "user-1", name: "Tutor One" },
    tags: ["Tier 1"],
  };
}

function session(id: string): WiseSession {
  return {
    _id: id,
    userId: { _id: "user-1", name: "Tutor One" },
    scheduledStartTime: "2026-05-10T03:00:00.000Z",
    scheduledEndTime: "2026-05-10T04:00:00.000Z",
    meetingStatus: "ENDED",
    type: "ONLINE",
    classId: {
      _id: "class-1",
      name: "Student One",
      subject: "Math",
      classType: "ONLINE",
    },
    studentCount: 1,
  };
}

function payoutEvent(eventId: string, transactionId: string, sessionId: string): WiseActivityEvent {
  return {
    user: { _id: "admin-1" },
    event: {
      eventId,
      eventName: "TutorPayoutInvoiceCreatedEvent",
      eventTimestamp: "2026-05-10T05:00:00.000Z",
      type: "BILLING",
      payload: {
        transaction: {
          id: transactionId,
          senderId: "user-1",
          status: "CREATED",
          note: "Session conducted",
          amount: { value: 70000, currency: "THB" },
          metadata: {
            classId: "class-1",
            sessionId,
            sessionStartTime: "2026-05-10T03:00:00.000Z",
            sessionCredits: 1,
          },
        },
      },
    },
  };
}

function makeClient(input: {
  events: WiseActivityEvent[];
  sessions?: WiseSession[];
}): WiseClient {
  return {
    get: async (path: string, params?: Record<string, string>) => {
      if (path.endsWith("/teachers")) {
        return { data: { teachers: [teacher()] } };
      }
      if (path.endsWith("/sessions")) {
        return {
          data: {
            sessions: input.sessions ?? [session("session-1")],
            page_count: 1,
          },
        };
      }
      if (path.endsWith("/events")) {
        return {
          data: {
            events: params?.page_number === "1" ? input.events : [],
          },
        };
      }
      throw new Error(`Unexpected Wise path: ${path}`);
    },
  } as WiseClient;
}

class FakePayrollDb {
  rows = new Map<Table, Record<string, unknown>[]>();
  failInvoiceInsert = false;
  invoiceInsertError = new Error("invoice insert failed");

  constructor() {
    for (const table of [
      schema.payrollSyncRuns,
      schema.payrollTeacherTiers,
      schema.payrollSessionObservations,
      schema.payrollPayoutInvoices,
      schema.payrollReviews,
    ]) {
      this.rows.set(table, []);
    }
  }

  tableRows(table: Table): Record<string, unknown>[] {
    const rows = this.rows.get(table);
    if (!rows) throw new Error("Unexpected table");
    return rows;
  }

  insert(table: Table) {
    return {
      values: (input: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === schema.payrollPayoutInvoices && this.failInvoiceInsert) {
          throw this.invoiceInsertError;
        }
        const values = Array.isArray(input) ? input : [input];
        const inserted = values.map((row, index) => ({
          id: row.id ?? (table === schema.payrollSyncRuns ? `run-${this.tableRows(table).length + index + 1}` : `${this.tableRows(table).length + index + 1}`),
          ...row,
        }));
        this.tableRows(table).push(...inserted);
        return {
          returning: async () => inserted.map((row) => ({ id: row.id })),
          onConflictDoUpdate: async () => inserted,
        };
      },
    };
  }

  update(table: Table) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          for (const row of this.tableRows(table)) {
            Object.assign(row, patch);
          }
        },
      }),
    };
  }

  delete(table: Table) {
    return {
      where: async () => {
        this.rows.set(table, []);
      },
    };
  }

  select() {
    return {
      from: () => ({
        innerJoin: () => ({
          innerJoin: async () => [{
            wiseTeacherId: "teacher-1",
            wiseUserId: "user-1",
            canonicalKey: "TutorOne",
            displayName: "Tutor One",
          }],
        }),
      }),
    };
  }

  async transaction<T>(callback: (tx: FakePayrollDb) => Promise<T>): Promise<T> {
    const tx = new FakePayrollDb();
    tx.failInvoiceInsert = this.failInvoiceInsert;
    tx.invoiceInsertError = this.invoiceInsertError;
    tx.rows = new Map([...this.rows.entries()].map(([table, rows]) => [
      table,
      rows.map((row) => ({ ...row })),
    ]));
    const result = await callback(tx);
    this.rows = tx.rows;
    return result;
  }
}

function seedExistingMonthRows(db: FakePayrollDb) {
  db.tableRows(schema.payrollTeacherTiers).push({
    id: "existing-tier",
    payrollMonth: "2026-05-01",
    syncRunId: "existing-run",
    wiseTeacherId: "existing-teacher",
  });
  db.tableRows(schema.payrollSessionObservations).push({
    id: "existing-session",
    payrollMonth: "2026-05-01",
    syncRunId: "existing-run",
    wiseSessionId: "existing-session",
  });
  db.tableRows(schema.payrollPayoutInvoices).push({
    id: "existing-invoice",
    payrollMonth: "2026-05-01",
    syncRunId: "existing-run",
    eventId: "existing-event",
    transactionId: "existing-transaction",
  });
}

describe("runPayrollSync", () => {
  it("preserves duplicate Wise transaction ids when event ids are distinct", async () => {
    const db = new FakePayrollDb();
    const client = makeClient({
      sessions: [session("session-1"), session("session-2")],
      events: [
        payoutEvent("event-1", "shared-transaction", "session-1"),
        payoutEvent("event-2", "shared-transaction", "session-2"),
      ],
    });

    const result = await runPayrollSync(db as unknown as Database, client, "institute-1", "2026-05", {
      now,
      maxEventPages: 2,
    });

    expect(result.invoiceCount).toBe(2);
    expect(db.tableRows(schema.payrollPayoutInvoices)).toEqual([
      expect.objectContaining({ eventId: "event-1", transactionId: "shared-transaction" }),
      expect.objectContaining({ eventId: "event-2", transactionId: "shared-transaction" }),
    ]);
    expect(db.tableRows(schema.payrollSyncRuns)[0]).toEqual(expect.objectContaining({
      status: "success",
      invoiceCount: 2,
      metadata: expect.objectContaining({
        eventPagesFetched: 1,
        invoiceRowsNormalized: 2,
        rawPayoutEventsMatched: 2,
      }),
    }));
  });

  it("rolls back month replacement rows and stores a short error summary on insert failure", async () => {
    const db = new FakePayrollDb();
    seedExistingMonthRows(db);
    db.failInvoiceInsert = true;
    db.invoiceInsertError = new Error("x".repeat(3_000));

    const client = makeClient({
      events: [payoutEvent("event-1", "transaction-1", "session-1")],
    });

    await expect(runPayrollSync(db as unknown as Database, client, "institute-1", "2026-05", {
      now,
      maxEventPages: 2,
    })).rejects.toThrow("x");

    expect(db.tableRows(schema.payrollTeacherTiers)).toEqual([
      expect.objectContaining({ id: "existing-tier" }),
    ]);
    expect(db.tableRows(schema.payrollSessionObservations)).toEqual([
      expect.objectContaining({ id: "existing-session" }),
    ]);
    expect(db.tableRows(schema.payrollPayoutInvoices)).toEqual([
      expect.objectContaining({ id: "existing-invoice" }),
    ]);
    expect(db.tableRows(schema.payrollSyncRuns)[0]).toEqual(expect.objectContaining({
      status: "failed",
      metadata: expect.objectContaining({ invoiceRowsNormalized: 1 }),
    }));
    expect(String(db.tableRows(schema.payrollSyncRuns)[0].errorSummary).length).toBeLessThan(2_100);
    expect(db.tableRows(schema.payrollSyncRuns)[0].errorSummary).toContain("truncated");
  });
});
