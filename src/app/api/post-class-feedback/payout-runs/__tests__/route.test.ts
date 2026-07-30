import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/post-class-feedback/access", () => ({
  requirePostClassCapability: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/api", () => ({
  postClassFeedbackErrorResponse: vi.fn((_scope, error: unknown, fallback: string) =>
    NextResponse.json(
      { error: error instanceof Error ? error.message : fallback },
      { status: 400 },
    )),
}));
vi.mock("@/lib/post-class-feedback/payout-config", () => ({
  payoutEnvironmentTarget: vi.fn(),
  payoutWritesEnabled: vi.fn(),
  requirePayoutGoogleTarget: vi.fn(),
}));
vi.mock("@/lib/post-class-feedback/payout-run", () => ({
  previewPayoutRun: vi.fn(),
  publishPayoutRun: vi.fn(),
  resolvePayoutException: vi.fn(),
  retryPayoutRunCsv: vi.fn(),
}));

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import {
  payoutEnvironmentTarget,
  payoutWritesEnabled,
  requirePayoutGoogleTarget,
} from "@/lib/post-class-feedback/payout-config";
import {
  previewPayoutRun,
  publishPayoutRun,
  resolvePayoutException,
  retryPayoutRunCsv,
} from "@/lib/post-class-feedback/payout-run";
import { POST } from "../route";

const actor = { email: "finance@example.com", capabilities: ["finance", "viewer"] };
const view = {
  run: null,
  window: {
    anchorMonth: "2026-07",
    windowStart: "2026-06-26",
    windowEnd: "2026-07-25",
  },
  previewToken: "preview-token-123456",
  coverage: {},
  lines: [],
  adjustments: [],
  exceptions: [],
  csvError: null,
  stoppedEarly: false,
};

function request(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/post-class-feedback/payout-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/post-class-feedback/payout-runs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePostClassCapability).mockResolvedValue(actor as never);
    vi.mocked(payoutEnvironmentTarget).mockReturnValue("scratch");
    vi.mocked(payoutWritesEnabled).mockReturnValue(true);
    vi.mocked(requirePayoutGoogleTarget).mockReturnValue({ target: true } as never);
    vi.mocked(previewPayoutRun).mockResolvedValue(view as never);
    vi.mocked(publishPayoutRun).mockResolvedValue(view as never);
    vi.mocked(retryPayoutRunCsv).mockResolvedValue(view as never);
    vi.mocked(resolvePayoutException).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: "resolved",
    } as never);
  });

  it("previews an exact tutor canary and exposes write readiness", async () => {
    const response = await POST(request({
      action: "preview",
      anchorMonth: "2026-07",
      tutorFilter: "tutor-kevin",
    }));

    expect(response.status).toBe(200);
    expect(requirePostClassCapability).toHaveBeenCalledWith("finance");
    expect(previewPayoutRun).toHaveBeenCalledWith(actor, {
      anchorMonth: "2026-07",
      tutorFilter: "tutor-kevin",
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      previewToken: "preview-token-123456",
      writeCapability: { enabled: true, target: "scratch", reason: null },
    });
  });

  it("requires an explicit confirmation and meaningful reason before publish", async () => {
    const response = await POST(request({
      action: "publish",
      anchorMonth: "2026-07",
      expectedVersion: 0,
      previewToken: "preview-token-123456",
      acknowledgements: {
        confirmed: false,
        reason: "short",
        pendingReviewDeductions: 0,
        nonReadySessions: 0,
      },
    }));

    expect(response.status).toBe(400);
    expect(publishPayoutRun).not.toHaveBeenCalled();
  });

  it("passes the exact preview, canary, counts, and audit reason to publish", async () => {
    const response = await POST(request({
      action: "publish",
      anchorMonth: "2026-07",
      expectedVersion: 4,
      previewToken: "preview-token-123456",
      tutorFilter: "tutor-kevin",
      acknowledgements: {
        confirmed: true,
        reason: "Finance checked this exact canary preview.",
        pendingReviewDeductions: 2,
        nonReadySessions: 3,
      },
    }));

    expect(response.status).toBe(200);
    expect(publishPayoutRun).toHaveBeenCalledWith(actor, {
      anchorMonth: "2026-07",
      expectedVersion: 4,
      previewToken: "preview-token-123456",
      tutorFilter: "tutor-kevin",
      acknowledgements: {
        confirmed: true,
        pendingReviewDeductions: 2,
        nonReadySessions: 3,
        reason: "Finance checked this exact canary preview.",
      },
    });
  });

  it("retries only the CSV using the run version", async () => {
    const response = await POST(request({
      action: "retry_csv",
      anchorMonth: "2026-07",
      expectedVersion: 5,
    }));

    expect(response.status).toBe(200);
    expect(retryPayoutRunCsv).toHaveBeenCalledWith(actor, {
      anchorMonth: "2026-07",
      expectedVersion: 5,
    });
    expect(publishPayoutRun).not.toHaveBeenCalled();
  });

  it("resolves a reviewed exception with a note and external reference", async () => {
    const response = await POST(request({
      action: "resolve_exception",
      exceptionId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 5,
      note: "Reviewed against the finance approval ticket.",
      externalReference: "FIN-2026-071",
    }));

    expect(response.status).toBe(200);
    expect(resolvePayoutException).toHaveBeenCalledWith(actor, {
      exceptionId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 5,
      resolutionNote: "Reviewed against the finance approval ticket.",
      resolutionReference: "FIN-2026-071",
    });
  });

  it("exposes a disabled write capability without blocking read-only preview", async () => {
    vi.mocked(payoutWritesEnabled).mockReturnValue(false);

    const response = await POST(request({
      action: "preview",
      anchorMonth: "2026-07",
    }));

    expect(response.status).toBe(200);
    expect(previewPayoutRun).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      writeCapability: {
        enabled: false,
        target: "scratch",
        reason: expect.stringMatching(/disabled/i),
      },
    });
  });
});
