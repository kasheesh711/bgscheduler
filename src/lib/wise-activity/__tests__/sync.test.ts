import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import type { WiseActivityEvent } from "@/lib/wise/types";

vi.mock("@/lib/wise/fetchers", () => ({
  fetchWiseActivityEvents: vi.fn(),
}));

import { fetchWiseActivityEvents } from "@/lib/wise/fetchers";
import { normalizeWiseActivityEvent, syncWiseActivityEvents } from "../sync";

function makeWiseEvent(id: string, timestamp: string, overrides: Partial<WiseActivityEvent> = {}): WiseActivityEvent {
  return {
    user: {
      _id: "actor-1",
      name: "Kevin Admin",
      role: "admin",
    },
    classroom: {
      _id: "class-1",
      name: "Math Y5",
      subject: "Math",
    },
    event: {
      eventId: id,
      eventName: "SessionUpdatedEvent",
      eventTimestamp: timestamp,
      type: "SESSION",
      payload: {
        session: {
          id: "session-1",
          scheduledStartTime: "2026-05-28T08:00:00.000Z",
          scheduledEndTime: "2026-05-28T09:30:00.000Z",
        },
        transaction: {
          id: "transaction-1",
          transactionType: "credit",
          status: "paid",
          amount: { value: 1500, currency: "THB" },
        },
      },
    },
    ...overrides,
  };
}

function makeDb(existingEventIds: string[] = []) {
  const knownEventIds = new Set(existingEventIds);
  const state = {
    eventInsertBatches: [] as Array<Array<{ eventId: string }>>,
    runUpdates: [] as Array<Record<string, unknown>>,
  };

  const db = {
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (table === schema.wiseActivitySyncRuns) state.runUpdates.push(values);
          return [];
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const returning = vi.fn(async () => {
          if (table === schema.wiseActivitySyncRuns) return [{ id: "run-1" }];
          return [];
        });
        const onConflictDoNothing = vi.fn(() => ({
          returning: vi.fn(async () => {
            const rows = Array.isArray(values) ? values as Array<{ eventId: string }> : [];
            state.eventInsertBatches.push(rows);
            const inserted = rows
              .filter((row) => {
                if (knownEventIds.has(row.eventId)) return false;
                knownEventIds.add(row.eventId);
                return true;
              })
              .map((row) => ({ id: `db-${row.eventId}` }));
            return inserted;
          }),
        }));
        return { returning, onConflictDoNothing };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => {
          if (table !== schema.wiseActivityEvents) return [];
          return [...knownEventIds].map((eventId) => ({ eventId }));
        }),
      })),
    })),
  };

  return { db, state };
}

describe("Wise activity sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("normalizes Wise activity payloads into persisted audit fields", () => {
    const normalized = normalizeWiseActivityEvent(
      makeWiseEvent("event-1", "2026-05-28T05:00:00.000Z"),
    );

    expect(normalized).toMatchObject({
      eventId: "event-1",
      eventType: "SESSION",
      eventName: "SessionUpdatedEvent",
      actorWiseUserId: "actor-1",
      actorName: "Kevin Admin",
      classroomId: "class-1",
      classroomName: "Math Y5",
      classroomSubject: "Math",
      sessionId: "session-1",
      transactionId: "transaction-1",
      transactionType: "credit",
      transactionStatus: "paid",
      transactionAmount: 1500,
      transactionCurrency: "THB",
    });
    expect(normalized?.eventTimestamp).toEqual(new Date("2026-05-28T05:00:00.000Z"));
    expect(normalized?.sessionStartTime).toEqual(new Date("2026-05-28T08:00:00.000Z"));
  });

  it("dedupes known event IDs while persisting a successful sync run", async () => {
    vi.mocked(fetchWiseActivityEvents).mockResolvedValue([
      makeWiseEvent("known-event", "2026-05-28T06:00:00.000Z"),
      makeWiseEvent("new-event", "2026-05-28T05:00:00.000Z"),
    ]);
    const { db, state } = makeDb(["known-event"]);

    const result = await syncWiseActivityEvents(
      db as never,
      {} as never,
      "institute-1",
      {
        triggerType: "cron",
        now: new Date("2026-05-28T07:00:00.000Z"),
        lookbackDays: 3,
        maxPages: 5,
      },
    );

    expect(fetchWiseActivityEvents).toHaveBeenCalledWith({} as never, "institute-1", {
      pageNumber: 1,
      pageSize: 50,
    });
    expect(result).toMatchObject({
      syncRunId: "run-1",
      pagesFetched: 1,
      eventsFetched: 2,
      insertedCount: 1,
      stoppedReason: "short_page",
    });
    expect(state.eventInsertBatches[0].map((row) => row.eventId)).toEqual(["known-event", "new-event"]);
    expect(state.runUpdates.at(-1)).toMatchObject({
      status: "success",
      pagesFetched: 1,
      eventsFetched: 2,
      insertedCount: 1,
    });
  });

  it("stops a full page sync when every event is already known", async () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      makeWiseEvent(`event-${index}`, `2026-05-28T05:${String(index).padStart(2, "0")}:00.000Z`),
    );
    vi.mocked(fetchWiseActivityEvents).mockResolvedValue(events);
    const { db } = makeDb(events.map((event) => event.event?.eventId ?? ""));

    const result = await syncWiseActivityEvents(
      db as never,
      {} as never,
      "institute-1",
      {
        triggerType: "cron",
        now: new Date("2026-05-28T07:00:00.000Z"),
        lookbackDays: 3,
        maxPages: 20,
      },
    );

    expect(result.insertedCount).toBe(0);
    expect(result.pagesFetched).toBe(1);
    expect(result.stoppedReason).toBe("known_events");
  });
});
