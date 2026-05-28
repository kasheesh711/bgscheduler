import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
vi.mock("@/lib/wise-activity/data", () => ({
  getWiseActivitySummary: vi.fn(),
  listWiseActivityEvents: vi.fn(),
  wiseActivityBangkokRange: vi.fn(() => ({
    start: new Date("2026-05-20T17:00:00.000Z"),
    end: new Date("2026-05-28T16:59:59.999Z"),
  })),
}));
vi.mock("@/lib/wise-activity/sync", () => ({
  WiseActivitySyncAlreadyRunningError: class WiseActivitySyncAlreadyRunningError extends Error {},
  syncWiseActivityEvents: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { getWiseActivitySummary, listWiseActivityEvents } from "@/lib/wise-activity/data";
import { syncWiseActivityEvents } from "@/lib/wise-activity/sync";
import { GET as getEvents } from "../route";
import { GET as getSummary } from "../summary/route";
import { POST as postSync } from "../sync/route";

const authMock = auth as unknown as Mock;

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

describe("Wise activity API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.WISE_INSTITUTE_ID = "institute-1";
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-05-28T00:00:00.000Z" });
    vi.mocked(getDb).mockReturnValue({ db: true } as never);
    vi.mocked(createWiseClient).mockReturnValue({ client: true } as never);
    vi.mocked(listWiseActivityEvents).mockResolvedValue({ events: [], pagination: { total: 0 } } as never);
    vi.mocked(getWiseActivitySummary).mockResolvedValue({ cards: { totalEvents: 0 } } as never);
    vi.mocked(syncWiseActivityEvents).mockResolvedValue({ syncRunId: "run-1", status: "success" } as never);
  });

  it("requires auth before returning persisted events", async () => {
    authMock.mockResolvedValue(null);

    const res = await getEvents(request("http://test.local/api/wise-activity"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(listWiseActivityEvents).not.toHaveBeenCalled();
  });

  it("passes date, text, finance, and pagination filters to the event query", async () => {
    const res = await getEvents(request(
      "http://test.local/api/wise-activity?startDate=2026-05-21&endDate=2026-05-28&page=2&pageSize=75&type=SESSION&eventName=SessionUpdatedEvent&q=Kevin&sessionId=session-1&transactionId=tx-1&financeOnly=true",
    ));

    expect(res.status).toBe(200);
    expect(listWiseActivityEvents).toHaveBeenCalledWith({ db: true }, expect.objectContaining({
      start: new Date("2026-05-20T17:00:00.000Z"),
      end: new Date("2026-05-28T16:59:59.999Z"),
      page: 2,
      pageSize: 75,
      eventType: "SESSION",
      eventName: "SessionUpdatedEvent",
      query: "Kevin",
      sessionId: "session-1",
      transactionId: "tx-1",
      financeOnly: true,
    }));
  });

  it("validates activity date ranges", async () => {
    const res = await getEvents(request("http://test.local/api/wise-activity?startDate=2026-05-29&endDate=2026-05-28"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid date range" });
    expect(listWiseActivityEvents).not.toHaveBeenCalled();
  });

  it("requires auth and returns the summary aggregate", async () => {
    const res = await getSummary(request(
      "http://test.local/api/wise-activity/summary?startDate=2026-05-21&endDate=2026-05-28&type=BILLING&q=invoice&financeOnly=true",
    ));

    expect(res.status).toBe(200);
    expect(getWiseActivitySummary).toHaveBeenCalledWith({ db: true }, expect.objectContaining({
      startDate: "2026-05-21",
      endDate: "2026-05-28",
      eventType: "BILLING",
      query: "invoice",
      financeOnly: true,
    }));
    await expect(res.json()).resolves.toEqual({ cards: { totalEvents: 0 } });
  });

  it("runs a capped manual activity sync for signed-in admins", async () => {
    const res = await postSync(request("http://test.local/api/wise-activity/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lookbackDays: 45, maxPages: 700 }),
    }));

    expect(res.status).toBe(200);
    expect(syncWiseActivityEvents).toHaveBeenCalledWith(
      { db: true },
      { client: true },
      "institute-1",
      {
        triggerType: "manual",
        lookbackDays: 45,
        maxPages: 700,
      },
    );
  });
});
