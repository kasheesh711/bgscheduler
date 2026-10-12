import { afterEach, describe, expect, it, vi } from "vitest";
const outbound = vi.hoisted(() => vi.fn(() => ({ sendEmail: vi.fn() })));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: outbound }));
import { createDeductionReportSender } from "../deduction-report-sender";
afterEach(() => { vi.unstubAllEnvs(); outbound.mockClear(); });
describe("deduction report sender", () => {
  it("uses the existing Workspace sender when the report has no transport setting", () => {
    vi.stubEnv("OUTBOUND_EMAIL_TRANSPORT", undefined);
    createDeductionReportSender();
    expect(outbound).toHaveBeenCalledWith("primary", { strictOutcome: true, audience: "staff" }, expect.objectContaining({ OUTBOUND_EMAIL_TRANSPORT: "gmail" }));
  });
  it.each(["resend", "apps_script"])("retains an explicit %s transport", transport => {
    vi.stubEnv("OUTBOUND_EMAIL_TRANSPORT", transport);
    createDeductionReportSender();
    expect(outbound).toHaveBeenCalledWith("primary", { strictOutcome: true, audience: "staff" }, expect.objectContaining({ OUTBOUND_EMAIL_TRANSPORT: transport }));
  });
});
