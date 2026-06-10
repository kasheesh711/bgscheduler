import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/sales-dashboard/data", () => ({
  getLiveSlimRows: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getLiveSlimRows } from "@/lib/sales-dashboard/data";
import { toSlimAdditionalTransaction, toSlimTransaction } from "@/lib/sales-dashboard/dimensions";
import type { ParsedAdditionalSaleRow, ParsedNormalSaleRow, SlimTransaction } from "@/lib/sales-dashboard/types";
import { GET as getTransactions } from "../transactions/route";

const authMock = auth as unknown as Mock;

function normalRow(overrides: Partial<ParsedNormalSaleRow>): ParsedNormalSaleRow {
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: 4,
    studentNickname: "Mint",
    program: "Math",
    packageHours: "20 Hours",
    numberOfStudents: 1,
    paymentAmount: 10_000,
    salesRepresentative: "Alice Wong",
    paymentDate: "2026-01-10",
    enrollmentType: "New Student",
    programWiseName: "Mathematics",
    packageHoursClean: "20 Hours",
    validUntil: "2026-02-28",
    churnStatus: "Active",
    raw: { phone: "081-000-0000", note: "sensitive-raw-cell" },
    ...overrides,
  };
}

function additionalRow(overrides: Partial<ParsedAdditionalSaleRow>): ParsedAdditionalSaleRow {
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: 9,
    studentNickname: "Mint",
    salesType: "Books",
    packageName: "Workbook",
    paymentAmount: 500,
    paymentDate: "2026-01-15",
    raw: { phone: "081-000-0000", note: "sensitive-raw-cell" },
    ...overrides,
  };
}

// Run-id scoping lives in loadLiveRowData: the route reads only from the
// getLiveSlimRows materialization, which is built from rows scoped to each
// active source's lastSuccessfulImportRunId.
const fixtureRows: SlimTransaction[] = [
  toSlimTransaction(normalRow({ paymentDate: "2026-03-10", studentNickname: "Tan", salesRepresentative: "Bob" })),
  toSlimTransaction(normalRow({ paymentDate: "2026-02-10" })),
  toSlimTransaction(normalRow({ paymentDate: "2026-01-10" })),
  toSlimAdditionalTransaction(additionalRow({ paymentDate: "2026-01-15" })),
];

function request(query: string): NextRequest {
  return new NextRequest(`http://test.local/api/sales-dashboard/transactions${query}`);
}

describe("GET /api/sales-dashboard/transactions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" }, expires: "2026-06-21T00:00:00.000Z" });
    vi.mocked(getLiveSlimRows).mockResolvedValue(fixtureRows);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const res = await getTransactions(request(""));

    expect(res.status).toBe(401);
    expect(getLiveSlimRows).not.toHaveBeenCalled();
  });

  it("rejects malformed dates with 400 and flattened details", async () => {
    const res = await getTransactions(request("?from=10-01-2026"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid query");
    expect(body.details.fieldErrors.from).toBeTruthy();
    expect(getLiveSlimRows).not.toHaveBeenCalled();
  });

  it("returns paginated rows with the total count", async () => {
    const res = await getTransactions(request("?limit=2"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.rows).toHaveLength(2);
  });

  it("clamps oversized limits to 1000 instead of rejecting them", async () => {
    const res = await getTransactions(request("?limit=5000"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(4);
    expect(body.total).toBe(4);
  });

  it("filters by rep through key normalization and serves from the run-scoped materialization", async () => {
    const res = await getTransactions(request("?rep=%20ALICE%20%20wong"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.rows.every((row: SlimTransaction) => row.rep === "Alice Wong")).toBe(true);
    expect(getLiveSlimRows).toHaveBeenCalledTimes(1);
  });

  it("filters by student across normal and additional rows with a date window", async () => {
    const res = await getTransactions(request("?student=mint&from=2026-01-01&to=2026-01-31"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.rows.map((row: SlimTransaction) => row.kind).sort()).toEqual(["additional", "normal"]);
  });

  it("never serializes the raw jsonb column", async () => {
    const res = await getTransactions(request(""));

    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('"raw"');
    expect(text).not.toContain("sensitive-raw-cell");
    expect(text).not.toContain("081-000-0000");
  });
});
