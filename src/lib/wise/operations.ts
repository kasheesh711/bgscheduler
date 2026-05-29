import type { Database } from "@/lib/db";
import {
  createLineWiseActionLog,
  getLineSchedulerReview,
  patchLineSchedulerOperationalState,
  type LineReviewActor,
  type LineWiseActionLogDto,
} from "@/lib/line/data";

export function wiseSessionOperationsVerified(): boolean {
  return process.env.WISE_SESSION_OPERATIONS_VERIFIED === "true";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export async function confirmLineWiseAction(input: {
  db: Database;
  reviewId: string;
  actionId: string;
  selectedSessionIds?: string[];
  actor: LineReviewActor;
}): Promise<{ log: LineWiseActionLogDto; endpointVerified: boolean }> {
  const review = await getLineSchedulerReview(input.db, input.reviewId);
  if (!review) throw new Error("LINE review not found");
  if (review.status !== "pending_review") throw new Error("Only pending reviews can confirm Wise actions");

  const action = review.proposedWiseActions
    .map(asRecord)
    .find((candidate) => candidate.id === input.actionId);
  if (!action) throw new Error("Wise action not found");

  const selectedSessionIds = input.selectedSessionIds?.length
    ? input.selectedSessionIds
    : asStringArray(action.wiseSessionIds);
  if (selectedSessionIds.length === 0) {
    throw new Error("Select at least one Wise session before confirming");
  }

  if (!wiseSessionOperationsVerified()) {
    const log = await createLineWiseActionLog(input.db, {
      lineReviewId: review.id,
      actionType: String(action.type ?? "unknown"),
      status: "manual_required",
      dryRun: true,
      wiseSessionIds: selectedSessionIds,
      requestPayload: {
        action,
        selectedSessionIds,
        endpointVerified: false,
      },
      errorMessage: "Wise cancel/reschedule endpoint contract is not verified in this environment.",
      actor: input.actor,
    });
    await patchLineSchedulerOperationalState(input.db, review.id, {
      adminSelectedSessionIds: selectedSessionIds,
      writebackStatus: "manual_required",
    });
    return { log, endpointVerified: false };
  }

  // Endpoint contract intentionally remains dry-run until the Wise cancel/move
  // request shape is verified against production-safe Wise documentation.
  const log = await createLineWiseActionLog(input.db, {
    lineReviewId: review.id,
    actionType: String(action.type ?? "unknown"),
    status: "dry_run",
    dryRun: true,
    wiseSessionIds: selectedSessionIds,
    requestPayload: {
      action,
      selectedSessionIds,
      endpointVerified: true,
      dryRunOnly: true,
    },
    responsePayload: {
      message: "Dry run recorded; no Wise mutation was sent.",
    },
    actor: input.actor,
  });
  await patchLineSchedulerOperationalState(input.db, review.id, {
    adminSelectedSessionIds: selectedSessionIds,
    writebackStatus: "dry_run",
  });
  return { log, endpointVerified: true };
}
