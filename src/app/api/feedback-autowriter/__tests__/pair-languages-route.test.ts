import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/operations-access", () => ({ requireClassroomOperationsOwner: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/pair-languages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feedback-autowriter/pair-languages")>()),
  loadPairLanguages: vi.fn(),
  setPairLanguageOverride: vi.fn(),
  clearPairLanguageOverride: vi.fn(),
}));

import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { auth } from "@/lib/auth";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import {
  clearPairLanguageOverride,
  loadPairLanguages,
  setPairLanguageOverride,
  type PairLanguages,
} from "@/lib/feedback-autowriter/pair-languages";
import { DELETE, GET, PUT } from "../pair-languages/route";

const authMock = vi.mocked(auth as unknown as () => Promise<unknown>);
const ownerMock = vi.mocked(requireClassroomOperationsOwner);
const loadMock = vi.mocked(loadPairLanguages);
const setMock = vi.mocked(setPairLanguageOverride);
const clearMock = vi.mocked(clearPairLanguageOverride);

const CLASS = "6a0000000000000000000001";
const PAYLOAD: PairLanguages = { overridesAvailable: true, lookbackDays: 90, englishMaxThaiShare: 0.03, thaiMinMedianShare: 0.3, pairs: [] };
const missingTable = () => Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
const request = (method: "PUT" | "DELETE", body: unknown) => new NextRequest("http://localhost/api/feedback-autowriter/pair-languages", {
  method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { email: "admin@example.com", role: "admin" } });
  ownerMock.mockResolvedValue({ email: "owner@example.com", accessVersion: 1 } as never);
  loadMock.mockResolvedValue(PAYLOAD);
  setMock.mockResolvedValue(undefined);
  clearMock.mockResolvedValue(true);
});

describe("GET /api/feedback-autowriter/pair-languages", () => {
  it("needs an admin session", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    authMock.mockResolvedValue({ user: { email: "parent@example.com", role: "parent" } });
    expect((await GET()).status).toBe(403);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("returns the payload", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PAYLOAD);
  });
});

describe("PUT /api/feedback-autowriter/pair-languages", () => {
  const body = { wiseClassId: CLASS, tutorKey: "Kevin", language: "thai" };

  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    const response = await PUT(request("PUT", body));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/class languages/u);
    expect(setMock).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON and malformed bodies", async () => {
    expect((await PUT(request("PUT", "{nope"))).status).toBe(400);
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, language: "french" },
      { ...body, wiseClassId: "6A0000000000000000000001" },
      { ...body, wiseClassId: "abc" },
      { ...body, tutorKey: "   " },
    ]) {
      expect((await PUT(request("PUT", bad))).status).toBe(400);
    }
    expect(setMock).not.toHaveBeenCalled();
  });
  it("stores the override as the owner and returns the reloaded payload", async () => {
    const response = await PUT(request("PUT", body));
    expect(response.status).toBe(200);
    expect(setMock.mock.calls[0][0]).toEqual({ ...body, setBy: "owner@example.com" });
    expect(await response.json()).toEqual(PAYLOAD);
  });
  it("is a 409 before migration 0116", async () => {
    setMock.mockRejectedValue(missingTable());
    const response = await PUT(request("PUT", body));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/0116/u);
  });
});

describe("DELETE /api/feedback-autowriter/pair-languages", () => {
  const body = { wiseClassId: CLASS, tutorKey: "Kevin" };

  it("is owner-only", async () => {
    ownerMock.mockRejectedValue(new AdminUsersAccessError("nope", 403));
    expect((await DELETE(request("DELETE", body))).status).toBe(403);
    expect(clearMock).not.toHaveBeenCalled();
  });
  it("rejects a malformed body", async () => {
    expect((await DELETE(request("DELETE", { ...body, language: "thai" }))).status).toBe(400);
    expect((await DELETE(request("DELETE", "{nope"))).status).toBe(400);
    expect(clearMock).not.toHaveBeenCalled();
  });
  it("clears the override and returns the reloaded payload, also when nothing was deleted", async () => {
    let response = await DELETE(request("DELETE", body));
    expect(response.status).toBe(200);
    expect(clearMock.mock.calls[0][0]).toEqual(body);
    expect(await response.json()).toEqual(PAYLOAD);
    clearMock.mockResolvedValue(false);
    response = await DELETE(request("DELETE", body));
    expect(response.status).toBe(200);
  });
  it("is a 409 before migration 0116", async () => {
    clearMock.mockRejectedValue(missingTable());
    expect((await DELETE(request("DELETE", body))).status).toBe(409);
  });
});
