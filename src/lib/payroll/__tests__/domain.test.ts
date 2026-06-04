import { describe, expect, it } from "vitest";
import {
  isKevinCanonicalKey,
  isZeroCreditOrAmount,
  normalizePayrollPayoutEvent,
  normalizeTierLabel,
  payrollDurationMinutes,
} from "../domain";

describe("payroll domain helpers", () => {
  it("normalizes Wise tier tags into payroll labels", () => {
    expect(normalizeTierLabel("Tier 0-1")).toBe("BG0");
    expect(normalizeTierLabel("Tier 1")).toBe("BG1");
    expect(normalizeTierLabel("Tier 2")).toBe("BG2");
    expect(normalizeTierLabel("Tier 3")).toBe("BG3");
    expect(normalizeTierLabel("")).toBe("Unassigned");
  });

  it("normalizes tutor payout invoice events", () => {
    const event = normalizePayrollPayoutEvent({
      user: { _id: "admin-1" },
      event: {
        eventId: "event-1",
        eventName: "TutorPayoutInvoiceCreatedEvent",
        eventTimestamp: "2026-05-30T04:01:21.474Z",
        type: "BILLING",
        payload: {
          transaction: {
            id: "tx-1",
            senderId: "teacher-user-1",
            status: "CREATED",
            amount: { value: 60000, currency: "THB" },
            metadata: {
              classId: "class-1",
              sessionId: "session-1",
              sessionStartTime: "2026-05-30T03:00:00.000Z",
              sessionCredits: 1,
            },
          },
        },
      },
    });

    expect(event).toMatchObject({
      eventId: "event-1",
      transactionId: "tx-1",
      wiseTeacherUserId: "teacher-user-1",
      wiseClassId: "class-1",
      wiseSessionId: "session-1",
      sessionCredits: 1,
      amount: 600,
      currency: "THB",
      transactionStatus: "CREATED",
    });
  });

  it("uses scheduled start/end before duration milliseconds", () => {
    expect(payrollDurationMinutes({
      scheduledStartTime: "2026-05-30T03:00:00.000Z",
      scheduledEndTime: "2026-05-30T04:30:00.000Z",
      duration: 60_000,
    })).toBe(90);
    expect(payrollDurationMinutes({ duration: 3_600_000 })).toBe(60);
  });

  it("identifies Kevin and zero-credit payout rows", () => {
    expect(isKevinCanonicalKey("Kevin")).toBe(true);
    expect(isKevinCanonicalKey("kevin")).toBe(true);
    expect(isKevinCanonicalKey("Kevin Online")).toBe(false);
    expect(isZeroCreditOrAmount({ sessionCredits: 0, amount: 500 })).toBe(true);
    expect(isZeroCreditOrAmount({ sessionCredits: 1, amount: 0 })).toBe(true);
    expect(isZeroCreditOrAmount({ sessionCredits: 1, amount: 500 })).toBe(false);
  });
});
