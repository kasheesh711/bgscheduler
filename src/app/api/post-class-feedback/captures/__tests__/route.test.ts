import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ require: vi.fn(), list: vi.fn(), queue: vi.fn(), save: vi.fn(), blob: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/post-class-feedback/access", () => ({ requirePostClassCapability: mocks.require }));
vi.mock("@/lib/post-class-feedback/api", () => ({ postClassFeedbackErrorResponse: (_route: string, error: { status?: number; message: string }) => NextResponse.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock("@/lib/post-class-feedback/captures", () => ({ listCaptures: mocks.list, dueCaptureQueue: mocks.queue, saveCapture: mocks.save }));
vi.mock("@vercel/blob", () => ({ get: mocks.blob }));
import { GET, POST } from "../route";
import { GET as imageGET } from "../[id]/route";
beforeEach(() => { vi.clearAllMocks(); mocks.require.mockResolvedValue({ email: "reviewer@example.com" }); mocks.queue.mockResolvedValue({ classes: [], complete: false }); });
describe("capture route access", () => {
  it("requires viewer access before reading a queue", async () => {
    const response = await GET(new NextRequest("https://bgscheduler.vercel.app/api/post-class-feedback/captures?date=2026-10-12"));
    expect(response.status).toBe(200);
    expect(mocks.require).toHaveBeenCalledWith("viewer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ complete: false });
  });
  it("rejects an upload before processing the image when reviewer access fails", async () => {
    mocks.require.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    const response = await POST(new NextRequest("https://bgscheduler.vercel.app/api/post-class-feedback/captures", { method: "POST", headers: { origin: "https://bgscheduler.vercel.app" } }));
    expect(response.status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.require).toHaveBeenCalledWith("reviewer");
  });
  it("rejects cross-origin uploads", async () => {
    const response = await POST(new NextRequest("https://bgscheduler.vercel.app/api/post-class-feedback/captures", { method: "POST", headers: { origin: "https://other.example" } }));
    expect(response.status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not read a private image for a user without viewer access", async () => {
    mocks.require.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    const response = await imageGET(new Request("https://bgscheduler.vercel.app"), { params: Promise.resolve({ id: "9832c0a4-f60e-4257-88c7-d4ee7f1bb27e" }) });
    expect(response.status).toBe(403); expect(mocks.blob).not.toHaveBeenCalled();
  });
});
