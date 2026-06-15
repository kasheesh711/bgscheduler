import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/competitor-intelligence/data", () => ({
  disableOwnBrandSource: vi.fn(),
  listOwnBrandSources: vi.fn(),
  upsertOwnBrandSource: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  disableOwnBrandSource,
  listOwnBrandSources,
  upsertOwnBrandSource,
} from "@/lib/competitor-intelligence/data";
import { PATCH } from "../[sourceId]/route";
import { GET, POST } from "../route";

const authMock = auth as unknown as Mock;

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/competitor-intelligence/own-sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("competitor intelligence own-brand source routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({
      user: {
        email: "marketing@example.com",
        name: "Marketing",
        role: "admin",
        allowedPages: null,
      },
    });
    vi.mocked(listOwnBrandSources).mockResolvedValue([{
      id: "source-1",
      entityId: "begifted",
      sourceType: "instagram",
      label: "BeGifted Instagram",
      url: "https://www.instagram.com/begifted/",
      handle: "begifted",
      provider: "apify",
      priority: 100,
      status: "active",
      lastSuccessAt: null,
      lastError: null,
    }] as never);
    vi.mocked(upsertOwnBrandSource).mockResolvedValue({ id: "source-1" } as never);
    vi.mocked(disableOwnBrandSource).mockResolvedValue({ id: "source-1", status: "disabled" } as never);
  });

  it("requires competitor intelligence access", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(listOwnBrandSources).not.toHaveBeenCalled();
  });

  it("lists own-brand sources", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sources: [expect.objectContaining({ label: "BeGifted Instagram" })],
    });
  });

  it("creates a BeGifted source for the signed-in user", async () => {
    const res = await POST(request({
      sourceType: "instagram",
      label: "BeGifted Instagram",
      url: "https://www.instagram.com/begifted/",
      handle: "begifted",
    }));

    expect(res.status).toBe(201);
    expect(upsertOwnBrandSource).toHaveBeenCalledWith(
      {
        sourceType: "instagram",
        label: "BeGifted Instagram",
        url: "https://www.instagram.com/begifted/",
        handle: "begifted",
      },
      "marketing@example.com",
    );
  });

  it("disables a BeGifted source through PATCH", async () => {
    const res = await PATCH(request({
      sourceType: "instagram",
      label: "BeGifted Instagram",
      url: "https://www.instagram.com/begifted/",
      status: "disabled",
    }), { params: Promise.resolve({ sourceId: "source-1" }) });

    expect(res.status).toBe(200);
    expect(disableOwnBrandSource).toHaveBeenCalledWith("source-1", "marketing@example.com");
  });
});
