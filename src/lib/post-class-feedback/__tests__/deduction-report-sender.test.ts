import { afterEach, describe, expect, it, vi } from "vitest";
const outbound = vi.hoisted(() => vi.fn(() => ({ sendEmail: vi.fn() })));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: outbound }));
import { createDeductionReportSender } from "../deduction-report-sender";
afterEach(() => { vi.unstubAllEnvs(); outbound.mockClear(); });
describe("deduction report sender", () => {
  it.each([undefined, "resend", "apps_script"])("always sends as staff mail, whatever the transport (%s)", transport => {
    vi.stubEnv("OUTBOUND_EMAIL_TRANSPORT", transport);
    createDeductionReportSender();
    expect(outbound).toHaveBeenCalledWith("primary", { strictOutcome: true, audience: "staff" });
  });
});
