import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/link-validation", () => ({
  listLineLinkValidationTasks: vi.fn(async () => ({
    tasks: [],
    reviewers: [],
    pagination: { page: 1, pageSize: 100, total: 0, pageCount: 0 },
  })),
}));

import { auth } from "@/lib/auth";
import { listLineLinkValidationTasks } from "@/lib/line/link-validation";
import { GET } from "@/app/api/line/contacts/link-validation/route";

const authMock = auth as unknown as Mock;

function request(url = "http://test.local/api/line/contacts/link-validation?scope=my") {
  return new NextRequest(url);
}

describe("LINE link validation list route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(listLineLinkValidationTasks).mockResolvedValue({
      tasks: [],
      reviewers: [],
      pagination: { page: 1, pageSize: 100, total: 0, pageCount: 0 },
    });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(listLineLinkValidationTasks).not.toHaveBeenCalled();
  });

  it("lists my assigned resolver link validation tasks for a run", async () => {
    const response = await GET(request(
      "http://test.local/api/line/contacts/link-validation?scope=my&runId=00000000-0000-4000-8000-000000000001",
    ));

    expect(response.status).toBe(200);
    expect(listLineLinkValidationTasks).toHaveBeenCalledWith({ db: true }, {
      scope: "my",
      runId: "00000000-0000-4000-8000-000000000001",
      actor: { email: "admin@example.com", name: "Admin" },
      page: 1,
      pageSize: 100,
    });
  });

  it("passes pagination params through to the validation service", async () => {
    const response = await GET(request(
      "http://test.local/api/line/contacts/link-validation?scope=all&page=3&pageSize=50",
    ));

    expect(response.status).toBe(200);
    expect(listLineLinkValidationTasks).toHaveBeenCalledWith({ db: true }, {
      scope: "all",
      runId: undefined,
      actor: { email: "admin@example.com", name: "Admin" },
      page: 3,
      pageSize: 50,
    });
  });

  it("rejects invalid filters", async () => {
    const response = await GET(request("http://test.local/api/line/contacts/link-validation?scope=mine"));

    expect(response.status).toBe(400);
    expect(listLineLinkValidationTasks).not.toHaveBeenCalled();
  });

  it("rejects invalid pagination params", async () => {
    const badPage = await GET(request("http://test.local/api/line/contacts/link-validation?scope=my&page=0"));
    const badPageSize = await GET(request("http://test.local/api/line/contacts/link-validation?scope=my&pageSize=101"));

    expect(badPage.status).toBe(400);
    expect(badPageSize.status).toBe(400);
    expect(listLineLinkValidationTasks).not.toHaveBeenCalled();
  });
});
