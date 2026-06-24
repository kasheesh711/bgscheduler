import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createLineWiseActionLog,
  getLineSchedulerReview,
  patchLineSchedulerOperationalState,
} from "@/lib/line/data";
import { confirmLineWiseAction, wiseSessionOperationsVerified } from "../operations";

vi.mock("@/lib/line/data", () => ({
  createLineWiseActionLog: vi.fn(),
  getLineSchedulerReview: vi.fn(),
  patchLineSchedulerOperationalState: vi.fn(),
}));

const getReviewMock = getLineSchedulerReview as unknown as Mock;
const createLogMock = createLineWiseActionLog as unknown as Mock;
const patchStateMock = patchLineSchedulerOperationalState as unknown as Mock;

const REVIEW = {
  id: "review-1",
  status: "pending_review",
  proposedWiseActions: [
    {
      id: "action-1",
      type: "cancel_one_off",
      wiseSessionIds: ["session-1", "session-2"],
    },
  ],
};

function input(overrides: Partial<Parameters<typeof confirmLineWiseAction>[0]> = {}) {
  return {
    db: {} as never,
    reviewId: "review-1",
    actionId: "action-1",
    actor: { email: "admin@example.com", name: "Admin" },
    ...overrides,
  };
}

describe("confirmLineWiseAction", () => {
  const originalFlag = process.env.WISE_SESSION_OPERATIONS_VERIFIED;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.WISE_SESSION_OPERATIONS_VERIFIED;
    getReviewMock.mockResolvedValue(REVIEW);
    createLogMock.mockImplementation(async (_db, values) => ({ id: "log-1", ...values }));
    patchStateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.WISE_SESSION_OPERATIONS_VERIFIED;
    else process.env.WISE_SESSION_OPERATIONS_VERIFIED = originalFlag;
  });

  it("records manual_required and never marks the action verified when the flag is off", async () => {
    const result = await confirmLineWiseAction(input());

    expect(wiseSessionOperationsVerified()).toBe(false);
    expect(result.endpointVerified).toBe(false);
    expect(createLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineReviewId: "review-1",
      actionType: "cancel_one_off",
      status: "manual_required",
      dryRun: true,
      wiseSessionIds: ["session-1", "session-2"],
      requestPayload: expect.objectContaining({ endpointVerified: false }),
      errorMessage: expect.stringContaining("not verified"),
    }));
    expect(patchStateMock).toHaveBeenCalledWith(expect.anything(), "review-1", {
      adminSelectedSessionIds: ["session-1", "session-2"],
      writebackStatus: "manual_required",
    });
  });

  it("still records only a dry run when the Wise session-operation flag is on", async () => {
    process.env.WISE_SESSION_OPERATIONS_VERIFIED = "true";

    const result = await confirmLineWiseAction(input({ selectedSessionIds: ["session-2"] }));

    expect(wiseSessionOperationsVerified()).toBe(true);
    expect(result.endpointVerified).toBe(true);
    expect(createLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineReviewId: "review-1",
      actionType: "cancel_one_off",
      status: "dry_run",
      dryRun: true,
      wiseSessionIds: ["session-2"],
      requestPayload: expect.objectContaining({
        endpointVerified: true,
        dryRunOnly: true,
      }),
      responsePayload: {
        message: "Dry run recorded; no Wise mutation was sent.",
      },
    }));
    expect(patchStateMock).toHaveBeenCalledWith(expect.anything(), "review-1", {
      adminSelectedSessionIds: ["session-2"],
      writebackStatus: "dry_run",
    });
  });

  it("refuses to confirm without any selected or proposed Wise sessions", async () => {
    getReviewMock.mockResolvedValue({
      ...REVIEW,
      proposedWiseActions: [{ id: "action-1", type: "cancel_one_off", wiseSessionIds: [] }],
    });

    await expect(confirmLineWiseAction(input())).rejects.toThrow("Select at least one Wise session");

    expect(createLogMock).not.toHaveBeenCalled();
    expect(patchStateMock).not.toHaveBeenCalled();
  });
});
