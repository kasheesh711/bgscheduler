import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/link-validation", () => ({
  patchLineLinkValidationTaskStatus: vi.fn(async () => ({ id: "link-1", status: "verified" })),
}));

import { auth } from "@/lib/auth";
import { patchLineLinkValidationTaskStatus } from "@/lib/line/link-validation";
import { PATCH } from "@/app/api/line/contacts/link-validation/[linkId]/route";

const authMock = auth as unknown as Mock;
const ctx = { params: Promise.resolve({ linkId: "00000000-0000-4000-8000-000000000001" }) };

function request(body: unknown) {
  return new NextRequest("http://test.local/api/line/contacts/link-validation/00000000-0000-4000-8000-000000000001", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LINE link validation patch route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(patchLineLinkValidationTaskStatus).mockResolvedValue({ id: "link-1", status: "verified" } as never);
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await PATCH(request({ status: "verified" }), ctx);

    expect(response.status).toBe(401);
    expect(patchLineLinkValidationTaskStatus).not.toHaveBeenCalled();
  });

  it("verifies a suggested mapping and records reviewer metadata", async () => {
    const response = await PATCH(request({ status: "verified" }), ctx);

    expect(response.status).toBe(200);
    expect(patchLineLinkValidationTaskStatus).toHaveBeenCalledWith({ db: true }, {
      linkId: "00000000-0000-4000-8000-000000000001",
      status: "verified",
      note: undefined,
      actor: { email: "admin@example.com", name: "Admin" },
    });
  });

  it("rejects a suggested mapping with an optional note", async () => {
    const response = await PATCH(request({ status: "rejected", note: "Wrong parent account" }), ctx);

    expect(response.status).toBe(200);
    expect(patchLineLinkValidationTaskStatus).toHaveBeenCalledWith({ db: true }, {
      linkId: "00000000-0000-4000-8000-000000000001",
      status: "rejected",
      note: "Wrong parent account",
      actor: { email: "admin@example.com", name: "Admin" },
    });
  });
});
