import { createOutboundEmailSender } from "@/lib/email/outbound";

/** Use the existing Workspace sender for this new report when no transport is set. */
export function createDeductionReportSender() {
  return createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" }, {
    ...process.env,
    OUTBOUND_EMAIL_TRANSPORT: process.env.OUTBOUND_EMAIL_TRANSPORT || "gmail",
  });
}
