import { createOutboundEmailSender } from "@/lib/email/outbound";

/** Staff mail: always admin@ through Workspace Gmail. */
export function createDeductionReportSender() {
  return createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" });
}
