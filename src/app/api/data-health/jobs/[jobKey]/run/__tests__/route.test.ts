import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data-health/run-job", () => ({ runDataHealthJob: vi.fn() }));

import { auth } from "@/lib/auth";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { POST } from "../route";

const authMock = auth as unknown as Mock;

function request(body: unknown = {}) {
  return new NextRequest("http://test.local/api/data-health/jobs/wise_snapshot/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function context(jobKey: string) {
  return { params: Promise.resolve({ jobKey }) };
}

describe("POST /api/data-health/jobs/[jobKey]/run", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue({ user: { email: "admin@example.com" } });
    vi.mocked(runDataHealthJob).mockResolvedValue(NextResponse.json({ ok: true }) as never);
  });

  it("requires an admin session", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(request(), context("wise_snapshot"));

    expect(res.status).toBe(401);
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("runs a known non-dangerous job", async () => {
    const res = await POST(request(), context("wise_snapshot"));

    expect(res.status).toBe(200);
    expect(runDataHealthJob).toHaveBeenCalledWith("wise_snapshot", "admin@example.com");
  });

  it("requires confirmation for dangerous jobs", async () => {
    const res = await POST(request(), context("classroom_morning"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "Confirmation required" });
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("allows confirmed dangerous jobs", async () => {
    const res = await POST(request({ confirmed: true }), context("classroom_morning"));

    expect(res.status).toBe(200);
    expect(runDataHealthJob).toHaveBeenCalledWith("classroom_morning", "admin@example.com");
  });

  it("rejects unknown jobs", async () => {
    const res = await POST(request(), context("missing"));

    expect(res.status).toBe(404);
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });
});
