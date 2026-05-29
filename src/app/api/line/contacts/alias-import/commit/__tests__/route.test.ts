import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/contact-aliases", () => ({
  commitLineAliasImport: vi.fn(async () => ({ applied: [] })),
}));

import { auth } from "@/lib/auth";
import { commitLineAliasImport } from "@/lib/line/contact-aliases";
import { POST } from "@/app/api/line/contacts/alias-import/commit/route";

const authMock = auth as unknown as Mock;

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/line/contacts/alias-import/commit", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/line/contacts/alias-import/commit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin" } });
    vi.mocked(commitLineAliasImport).mockResolvedValue({ applied: [] });
  });

  it("requires auth", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(request({ rows: [] }));

    expect(response.status).toBe(401);
    expect(commitLineAliasImport).not.toHaveBeenCalled();
  });

  it("commits selected aliases through the service", async () => {
    const response = await POST(request({
      rows: [{
        contactId: "00000000-0000-4000-8000-000000000001",
        aliasLabel: "𝓟☑️Kin/Parin.Pu",
      }],
    }));

    expect(response.status).toBe(200);
    expect(commitLineAliasImport).toHaveBeenCalledWith({
      db: { db: true },
      rows: [{
        contactId: "00000000-0000-4000-8000-000000000001",
        aliasLabel: "𝓟☑️Kin/Parin.Pu",
      }],
    });
  });
});
