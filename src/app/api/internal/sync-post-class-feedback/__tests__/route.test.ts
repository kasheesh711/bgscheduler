import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn(
    async (_input: unknown, operation: () => Promise<Response>) => operation(),
  ),
}));
vi.mock("@/lib/internal/cron-auth", () => ({
  rejectInvalidCronSecret: vi.fn(() => null),
}));
vi.mock("@/lib/post-class-feedback/collection-tick", () => ({
  runPostClassCollectionTickRequest: vi.fn(),
}));

import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";
import { runPostClassCollectionTickRequest } from "@/lib/post-class-feedback/collection-tick";
import { GET } from "../route";

function request(): NextRequest {
  return new NextRequest("http://test.local/api/internal/sync-post-class-feedback", { method: "GET" });
}

describe("GET /api/internal/sync-post-class-feedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("runs the shared collection tick as the audited cron trigger and returns its response verbatim", async () => {
    const upstream = NextResponse.json({ ok: true, from: "shared tick" });
    vi.mocked(runPostClassCollectionTickRequest).mockResolvedValueOnce(upstream as never);

    const response = await GET(request());

    expect(withCronInvocationAudit).toHaveBeenCalledTimes(1);
    expect(withCronInvocationAudit).toHaveBeenCalledWith(
      { jobKey: "post_class_feedback", triggerSource: "cron", requestMethod: "GET" },
      expect.any(Function),
    );
    expect(runPostClassCollectionTickRequest).toHaveBeenCalledTimes(1);
    expect(runPostClassCollectionTickRequest).toHaveBeenCalledWith({ triggerType: "cron" });
    expect(response).toBe(upstream);
  });

  it("returns a rejected cron secret before auditing or running the tick", async () => {
    const rejection = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    vi.mocked(rejectInvalidCronSecret).mockReturnValueOnce(rejection);

    const response = await GET(request());

    expect(response).toBe(rejection);
    expect(withCronInvocationAudit).not.toHaveBeenCalled();
    expect(runPostClassCollectionTickRequest).not.toHaveBeenCalled();
  });
});
