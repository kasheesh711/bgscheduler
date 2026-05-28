import { describe, expect, it } from "vitest";
import {
  formatBangkokDateTime,
  formatWiseAmount,
  isWiseFinanceEvent,
  isWiseSessionMutation,
  wiseActivityEventLabel,
  wiseActivityTypeLabel,
} from "../format";

describe("Wise activity format helpers", () => {
  it("labels known and camel-case Wise activity names", () => {
    expect(wiseActivityEventLabel("SessionUpdatedEvent")).toBe("Session updated");
    expect(wiseActivityEventLabel("CustomFinanceAdjustedEvent")).toBe("Custom Finance Adjusted");
    expect(wiseActivityTypeLabel("BILLING")).toBe("Billing");
  });

  it("categorizes finance and session mutation events", () => {
    expect(isWiseFinanceEvent({ eventType: "BILLING" })).toBe(true);
    expect(isWiseFinanceEvent({ eventName: "TutorPayoutInvoiceCreatedEvent" })).toBe(true);
    expect(isWiseFinanceEvent({ transactionId: "transaction-1" })).toBe(true);
    expect(isWiseFinanceEvent({ eventType: "SESSION", eventName: "SessionUpdatedEvent" })).toBe(false);

    expect(isWiseSessionMutation("SessionCreatedEvent")).toBe(true);
    expect(isWiseSessionMutation("SessionFeedbackSubmittedEvent")).toBe(false);
  });

  it("formats Bangkok timestamps and Wise money values", () => {
    expect(formatBangkokDateTime("2026-05-28T05:30:00.000Z")).toContain("12:30");
    expect(formatBangkokDateTime("not-a-date")).toBe("-");
    expect(formatWiseAmount(1250, "THB")).toBe("THB\u00a01,250.00");
    expect(formatWiseAmount(null, "THB")).toBe("-");
  });
});
