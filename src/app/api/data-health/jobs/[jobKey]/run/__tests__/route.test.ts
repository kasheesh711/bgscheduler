vi.mock("server-only", () => ({}));
// Existing behavior suites delegate current-account validation to the owner access suite.
vi.mock("@/lib/admin-users/access", () => ({ requireSuperAdmin: async () => {
  const { auth } = await import("@/lib/auth");
  const { AdminUsersAccessError } = await import("@/lib/admin-users/types");
  const session = await auth();
  if (!session?.user?.email) throw new AdminUsersAccessError("Unauthorized", 401);
  return { email: session.user.email, accessVersion: 0 };
} }));
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data-health/run-job", () => ({ runDataHealthJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/access", () => ({
  getPostClassCapabilities: vi.fn(),
}));
vi.mock("@/lib/unearned-revenue/access", () => ({
  getUnearnedRevenueCapabilities: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { getPostClassCapabilities } from "@/lib/post-class-feedback/access";
import { getUnearnedRevenueCapabilities } from "@/lib/unearned-revenue/access";
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
    authMock.mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } });
    vi.mocked(runDataHealthJob).mockResolvedValue(NextResponse.json({ ok: true }) as never);
    vi.mocked(getPostClassCapabilities).mockResolvedValue(["access_manager"]);
    vi.mocked(getUnearnedRevenueCapabilities).mockResolvedValue([]);
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
    expect(runDataHealthJob).toHaveBeenCalledWith("wise_snapshot", "kevhsh7@gmail.com");
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
    expect(runDataHealthJob).toHaveBeenCalledWith("classroom_morning", "kevhsh7@gmail.com");
  });

  it("rejects unknown jobs", async () => {
    const res = await POST(request(), context("missing"));

    expect(res.status).toBe(404);
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("requires access-manager capability for post-class feedback recovery jobs", async () => {
    vi.mocked(getPostClassCapabilities).mockResolvedValue(["viewer"]);

    const res = await POST(request(), context("post_class_feedback_day_after"));

    expect(res.status).toBe(403);
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("allows an access manager to run post-class feedback recovery jobs", async () => {
    const res = await POST(
      request({ confirmed: true }),
      context("post_class_feedback_deadline"),
    );

    expect(res.status).toBe(200);
    expect(runDataHealthJob).toHaveBeenCalledWith(
      "post_class_feedback_deadline",
      "kevhsh7@gmail.com",
    );
  });

  it("refuses a job excluded from manual runs before asking for confirmation", async () => {
    const res = await POST(request(), context("student_promotions_july_1"));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Student promotions write to Wise once a year; review and apply them from the Student Promotions page.",
    });
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("requires the Unearned Revenue access-manager grant to run its import", async () => {
    vi.mocked(getUnearnedRevenueCapabilities).mockResolvedValue(["viewer"]);

    const res = await POST(request(), context("unearned_revenue"));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Access manager capability required" });
    expect(getUnearnedRevenueCapabilities).toHaveBeenCalledWith("kevhsh7@gmail.com");
    expect(runDataHealthJob).not.toHaveBeenCalled();
  });

  it("allows an Unearned Revenue access manager to run its import", async () => {
    vi.mocked(getUnearnedRevenueCapabilities).mockResolvedValue(["viewer", "access_manager"]);

    const res = await POST(request(), context("unearned_revenue"));

    expect(res.status).toBe(200);
    expect(runDataHealthJob).toHaveBeenCalledWith("unearned_revenue", "kevhsh7@gmail.com");
  });
});
