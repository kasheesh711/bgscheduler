import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PostClassFeedbackPayload } from "@/types/post-class-feedback";
import {
  PayoutsTab,
  payoutCsvRetryAvailable,
  buildPayoutPublishBody,
  payoutLineRowNumber,
  payoutNonReadySessionCount,
  payoutRunHasLiveOperationLease,
  type PayoutRunView,
} from "../payouts-tab";

function view(overrides: Partial<PayoutRunView> = {}): PayoutRunView {
  return {
    run: {
      id: "run-1",
      anchorMonth: "2026-07",
      status: "draft",
      version: 4,
      csvUrl: null,
    },
    window: {
      anchorMonth: "2026-07",
      windowStart: "2026-06-26",
      windowEnd: "2026-07-25",
      closed: true,
    },
    coverage: {
      eligibleSessions: 100,
      readySessions: 96,
      nonReadySessions: 4,
      pendingReviewDeductions: 2,
      approvedDeductions: 3,
      unmappedTutorKeys: [],
      nullTutorKeyLines: 0,
      blockingGlobalSourceIssues: 0,
    },
    lines: [],
    exceptions: [],
    previewToken: "preview-token-1",
    csvError: null,
    stoppedEarly: false,
    writeCapability: { enabled: true, target: "scratch", reason: null },
    ...overrides,
  };
}

function payload(finance: boolean): PostClassFeedbackPayload {
  return {
    capabilities: {
      viewer: true,
      reviewer: finance,
      finance,
      accessManager: false,
    },
    payoutGoogle: finance
      ? { connectedEmail: "finance@example.com", sheetsWriteReady: true, driveReady: true }
      : null,
  } as PostClassFeedbackPayload;
}

describe("PayoutsTab", () => {
  it("builds an explicit audited canary publish request from the exact preview", () => {
    expect(buildPayoutPublishBody({
      view: view(),
      anchorMonth: "2026-07",
      tutorFilter: "tutor-kevin",
      reason: "Reviewed against the dedicated deductions tab.",
    })).toEqual({
      action: "publish",
      anchorMonth: "2026-07",
      expectedVersion: 4,
      previewToken: "preview-token-1",
      tutorFilter: "tutor-kevin",
      acknowledgements: {
        confirmed: true,
        reason: "Reviewed against the dedicated deductions tab.",
        pendingReviewDeductions: 2,
        nonReadySessions: 4,
      },
    });
  });

  it("refuses to construct a publish request without a fresh token and meaningful reason", () => {
    expect(() => buildPayoutPublishBody({
      view: view({ previewToken: null }),
      anchorMonth: "2026-07",
      tutorFilter: null,
      reason: "This reason is long enough.",
    })).toThrow(/reload the preview/i);
    expect(() => buildPayoutPublishBody({
      view: view({ run: null }),
      anchorMonth: "2026-07",
      tutorFilter: null,
      reason: "This reason is long enough.",
    })).toThrow(/reload the preview/i);
    expect(() => buildPayoutPublishBody({
      view: view(),
      anchorMonth: "2026-07",
      tutorFilter: null,
      reason: "short",
    })).toThrow(/at least 10 characters/i);
  });

  it("counts every non-ready source state when a unified count is unavailable", () => {
    expect(payoutNonReadySessionCount({
      ...view().coverage,
      nonReadySessions: undefined,
      unavailableSessions: 2,
      formDriftSessions: 3,
      identityReviewSessions: 4,
    })).toBe(9);
  });

  it("offers CSV-only recovery for failed or expired-pending artifacts, never uploaded ones", () => {
    const now = Date.parse("2026-07-29T04:00:00.000Z");
    expect(payoutCsvRetryAvailable(view({
      run: {
        ...view().run!,
        status: "published",
        csvStatus: "failed",
        leaseExpiresAt: null,
      },
    }), now)).toBe(true);
    expect(payoutCsvRetryAvailable(view({
      run: {
        ...view().run!,
        status: "published",
        csvStatus: "pending",
        leaseExpiresAt: "2026-07-29T03:59:00.000Z",
      },
    }), now)).toBe(true);
    expect(payoutCsvRetryAvailable(view({
      run: {
        ...view().run!,
        status: "published",
        csvStatus: "uploaded",
        leaseExpiresAt: null,
      },
    }), now)).toBe(false);
  });

  it("blocks an active publisher but lets an expired durable publish be reclaimed", () => {
    const now = Date.parse("2026-07-29T04:00:00.000Z");
    const publishing = (leaseExpiresAt: string | null) => view({
      run: {
        ...view().run!,
        status: "publishing",
        leaseExpiresAt,
      },
    });
    expect(payoutRunHasLiveOperationLease(
      publishing("2026-07-29T04:01:00.000Z"),
      now,
    )).toBe(true);
    expect(payoutRunHasLiveOperationLease(
      publishing("2026-07-29T03:59:00.000Z"),
      now,
    )).toBe(false);
    expect(payoutRunHasLiveOperationLease(publishing(null), now)).toBe(true);
    expect(payoutRunHasLiveOperationLease(view({
      run: {
        ...view().run!,
        status: "partial",
        csvStatus: "pending",
        leaseExpiresAt: "2026-07-29T04:01:00.000Z",
      },
    }), now)).toBe(true);
  });

  it("renders whichever durable dedicated-tab row field the backend returns", () => {
    expect(payoutLineRowNumber({ masterRowNumber: 42 })).toBe(42);
    expect(payoutLineRowNumber({ insertedRowNumber: 43 })).toBe(43);
    expect(payoutLineRowNumber({ sheetRowNumber: 44 })).toBe(44);
    expect(payoutLineRowNumber({
      masterRowNumber: 42,
      insertedRowNumber: 43,
      sheetRowNumber: 44,
    })).toBe(42);
  });

  it("omits the money path without finance capability", () => {
    const markup = renderToStaticMarkup(<PayoutsTab payload={payload(false)} />);

    expect(markup).toContain("Finance access required");
    expect(markup).not.toContain("Load preview");
  });

  it("starts finance users on a read-only preview with an explicit canary scope", () => {
    const markup = renderToStaticMarkup(<PayoutsTab payload={payload(true)} />);

    expect(markup).toContain("Load preview");
    expect(markup).toContain("Canary tutor");
    expect(markup).toContain("Publishing always requires a fresh token");
    expect(markup).not.toContain("payout sheets");
  });
});
