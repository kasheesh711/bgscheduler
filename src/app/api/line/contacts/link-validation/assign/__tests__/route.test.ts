import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/link-validation", () => ({
  LineLinkValidationError: class LineLinkValidationError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
  assignLineLinkValidationTasks: vi.fn(async () => ({ assigned: 2, tasks: [], reviewers: [] })),
}));

import { auth } from "@/lib/auth";
import { assignLineLinkValidationTasks } from "@/lib/line/link-validation";
import { POST } from "@/app/api/line/contacts/link-validation/assign/route";

const authMock = auth as unknown as Mock;

function request(body: unknown) {
  return new NextRequest("http://test.local/api/line/contacts/link-validation/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LINE link validation assignment route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "owner@example.com", name: "Owner" } });
    vi.mocked(assignLineLinkValidationTasks).mockResolvedValue({ assigned: 2, tasks: [], reviewers: [] });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(assignLineLinkValidationTasks).not.toHaveBeenCalled();
  });

  it("assigns suggested links from a resolver run to selected reviewers", async () => {
    const response = await POST(request({
      runId: "00000000-0000-4000-8000-000000000001",
      reviewerEmails: ["admin-a@example.com", "admin-b@example.com"],
    }));

    expect(response.status).toBe(200);
    expect(assignLineLinkValidationTasks).toHaveBeenCalledWith({ db: true }, {
      runId: "00000000-0000-4000-8000-000000000001",
      reviewerEmails: ["admin-a@example.com", "admin-b@example.com"],
    });
  });

  it("supports reassigning a specific validation task", async () => {
    const response = await POST(request({
      runId: "00000000-0000-4000-8000-000000000001",
      reviewerEmails: ["admin-a@example.com"],
      linkIds: ["00000000-0000-4000-8000-000000000002"],
    }));

    expect(response.status).toBe(200);
    expect(assignLineLinkValidationTasks).toHaveBeenCalledWith({ db: true }, {
      runId: "00000000-0000-4000-8000-000000000001",
      reviewerEmails: ["admin-a@example.com"],
      linkIds: ["00000000-0000-4000-8000-000000000002"],
    });
  });
});
