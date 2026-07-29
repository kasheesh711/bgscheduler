import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
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

// Google row writes are paced under a ten-minute application budget and a
// durable lease. Keep platform headroom above that budget.
export const maxDuration = 800;

const AnchorMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "Expected YYYY-MM");
const TutorFilter = z.string().trim().min(1).max(200);
const ExpectedVersion = z.number().int().min(1);
const AuditReason = z.string().trim().min(10).max(1_000);
const ExternalReference = z.string().trim().min(1).max(500);

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("preview"),
    anchorMonth: AnchorMonth,
    tutorFilter: TutorFilter.optional(),
  }).strict(),
  z.object({
    action: z.literal("publish"),
    anchorMonth: AnchorMonth,
    expectedVersion: ExpectedVersion,
    previewToken: z.string().trim().min(16).max(500),
    tutorFilter: TutorFilter.optional(),
    acknowledgements: z.object({
      confirmed: z.literal(true),
      reason: AuditReason,
      // Counts echo the exact preview. They are never accepted as booleans,
      // so a stale tab cannot acknowledge a set that has grown.
      pendingReviewDeductions: z.number().int().min(0),
      nonReadySessions: z.number().int().min(0),
    }).strict(),
  }).strict(),
  z.object({
    action: z.literal("retry_csv"),
    anchorMonth: AnchorMonth,
    expectedVersion: ExpectedVersion,
  }).strict(),
  z.object({
    action: z.literal("resolve_exception"),
    exceptionId: z.string().uuid(),
    expectedVersion: ExpectedVersion,
    note: AuditReason,
    externalReference: ExternalReference,
  }).strict(),
]);

interface PayoutWriteCapability {
  enabled: boolean;
  target: "scratch" | "production" | null;
  reason: string | null;
}

/**
 * Read-only capability projection for the finance UI.
 *
 * Publish/retry independently resolve the target again with `forWrite:true`;
 * this projection never substitutes for the service's operation-boundary
 * validation.
 */
function payoutWriteCapability(): PayoutWriteCapability {
  const target = payoutEnvironmentTarget();
  try {
    requirePayoutGoogleTarget({ forWrite: false });
  } catch (error) {
    return {
      enabled: false,
      target,
      reason: error instanceof Error ? error.message : "The payout target is incomplete.",
    };
  }
  if (!payoutWritesEnabled()) {
    return {
      enabled: false,
      target,
      reason: "Payout writes are disabled. The approved write window has not been opened.",
    };
  }
  return { enabled: true, target, reason: null };
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("finance");
    const body = BodySchema.parse(await request.json());
    const writeCapability = payoutWriteCapability();

    if (body.action === "preview") {
      const view = await previewPayoutRun(actor, {
        anchorMonth: body.anchorMonth,
        tutorFilter: body.tutorFilter,
      });
      return NextResponse.json({ ok: true, ...view, writeCapability });
    }

    if (body.action === "publish") {
      const view = await publishPayoutRun(actor, {
        anchorMonth: body.anchorMonth,
        expectedVersion: body.expectedVersion,
        previewToken: body.previewToken,
        tutorFilter: body.tutorFilter,
        acknowledgements: {
          confirmed: body.acknowledgements.confirmed,
          pendingReviewDeductions: body.acknowledgements.pendingReviewDeductions,
          nonReadySessions: body.acknowledgements.nonReadySessions,
          reason: body.acknowledgements.reason,
        },
      });
      return NextResponse.json({ ok: true, ...view, writeCapability: payoutWriteCapability() });
    }

    if (body.action === "retry_csv") {
      const view = await retryPayoutRunCsv(actor, {
        anchorMonth: body.anchorMonth,
        expectedVersion: body.expectedVersion,
      });
      return NextResponse.json({ ok: true, ...view, writeCapability: payoutWriteCapability() });
    }

    const exception = await resolvePayoutException(actor, {
      exceptionId: body.exceptionId,
      expectedVersion: body.expectedVersion,
      resolutionNote: body.note,
      resolutionReference: body.externalReference,
    });
    return NextResponse.json({ ok: true, exception, writeCapability });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/payout-runs",
      error,
      "Could not update the payout run.",
    );
  }
}
