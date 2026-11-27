import { afterEach, describe, expect, it, vi } from "vitest";

const Rejection = vi.hoisted(() => class Rejection extends Error {
  readonly definitelyNotAccepted = true;
});
const relaySend = vi.hoisted(() => vi.fn(async () => ({ id: "relay-1" })));
const relay = vi.hoisted(() => vi.fn((key: string, options?: { strictOutcome?: boolean }) => ({ relayKey: key, options, sendEmail: relaySend })));
const gmailSend = vi.hoisted(() => vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({ id: "gmail-1" })));
const createGmailSender = vi.hoisted(() => vi.fn<(...args: unknown[]) => { sendEmail: typeof gmailSend }>(() => ({ sendEmail: gmailSend })));
const accessToken = vi.hoisted(() => vi.fn(async () => "token"));
const resendSend = vi.hoisted(() => vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({ id: "resend-1" })));
const createResendSender = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ sendEmail: resendSend })));
const resendConfigured = vi.hoisted(() => vi.fn(() => true));
const gmailConfig = vi.hoisted(() => ({ value: { configured: true, trusted: true, available: true } }));

vi.mock("@/lib/classrooms/schedule-email", () => ({
  createAppsScriptScheduleEmailSender: relay,
  ScheduleEmailRejection: Rejection,
}));
vi.mock("@/lib/email/resend", () => ({ createResendSender, resendConfigured }));
vi.mock("@/lib/post-class-feedback/gmail", () => ({ createGmailSender }));
vi.mock("@/lib/post-class-feedback/gmail-credentials", () => ({ feedbackGmailAccessToken: accessToken }));
vi.mock("@/lib/post-class-feedback/gmail-connection", () => ({ feedbackEmailConfiguration: () => gmailConfig.value }));

import { createOutboundEmailSender, outboundEmailTransport, outboundRelayKey } from "../outbound";

const input = { to: "tutor@example.com", subject: "Schedule", text: "t", html: "<p>t</p>", idempotencyKey: "k-1" };
const GMAIL = { OUTBOUND_EMAIL_TRANSPORT: "gmail" };
afterEach(() => {
  vi.clearAllMocks();
  gmailConfig.value = { configured: true, trusted: true, available: true };
});

describe("outboundEmailTransport", () => {
  it("defaults to the Apps Script relay and only switches on an explicit gmail value", () => {
    expect(outboundEmailTransport({})).toBe("apps_script");
    expect(outboundEmailTransport({ OUTBOUND_EMAIL_TRANSPORT: "relay" })).toBe("apps_script");
    expect(outboundEmailTransport({ OUTBOUND_EMAIL_TRANSPORT: " Gmail " })).toBe("gmail");
  });

  it("maps both sender keys onto the primary relay under gmail", () => {
    expect(outboundRelayKey("backup", {})).toBe("backup");
    expect(outboundRelayKey("backup", GMAIL)).toBe("primary");
  });
});

const RESEND = { OUTBOUND_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", RESEND_FROM: "B <b@notify.example.com>" };

describe("resend transport", () => {
  afterEach(() => resendConfigured.mockReturnValue(true));

  it("parses resend case-insensitively", () => {
    expect(outboundEmailTransport({ OUTBOUND_EMAIL_TRANSPORT: " Resend " })).toBe("resend");
  });

  it("maps both keys to the primary relay under resend", () => {
    expect(outboundRelayKey("backup", RESEND)).toBe("primary");
  });

  it("sends teacher mail and untagged callers through Resend without rollout flags", async () => {
    expect(await createOutboundEmailSender("primary", {}, {}).sendEmail(input)).toEqual({ id: "resend-1" });
    expect(await createOutboundEmailSender("primary", { audience: "teacher" }, GMAIL).sendEmail(input)).toEqual({ id: "resend-1" });
    expect(gmailSend).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
  });

  it.each(["primary", "backup"] as const)("keeps tutor sender on Resend for %s, including rejection and missing config", async (key) => {
    const env = { ...RESEND, RESEND_AUDIENCE: "all", RESEND_FROM: "Wrong <wrong@example.com>" };
    const sender = createOutboundEmailSender(key, { audience: "teacher" }, env);
    expect(createResendSender).toHaveBeenCalledWith(env, {
      from: "BeGifted <no-reply@notify.begiftededucation.com>", replyTo: "admin@begiftededucation.com",
    });
    resendSend.mockRejectedValueOnce(new Rejection("403"));
    await expect(sender.sendEmail(input)).rejects.toThrow("403");
    resendConfigured.mockReturnValue(false);
    await createOutboundEmailSender(key, {}, { OUTBOUND_EMAIL_TRANSPORT: "resend", RESEND_AUDIENCE: "all" }).sendEmail(input);
    expect(gmailSend).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
  });
});

describe.each(["candidate", "staff"] as const)("%s audience", (audience) => {
  it.each([
    ["primary", {}], ["primary", GMAIL], ["primary", RESEND], ["backup", RESEND], ["backup", {}],
  ] as const)("sends as admin@ through Workspace Gmail only (%s, %o)", async (key, env) => {
    const sender = createOutboundEmailSender(key, { strictOutcome: true, audience }, env);
    expect(await sender.sendEmail({ ...input, subject: "Visit\ninvite " })).toEqual({ id: "gmail-1" });
    expect(createGmailSender).toHaveBeenCalledWith(expect.any(Function), undefined,
      { senderName: "BeGifted Education", replyTo: "admin@begiftededucation.com" });
    expect(gmailSend).toHaveBeenCalledWith({ ...input, subject: "Visit invite" });
    expect(relay).not.toHaveBeenCalled();
    expect(createResendSender).not.toHaveBeenCalled();
  });

  it("never falls back to the relay or Resend when Gmail rejects or is unavailable", async () => {
    gmailSend.mockRejectedValueOnce(new Rejection("Reconnect the dedicated Gmail sender"));
    await expect(createOutboundEmailSender("primary", { audience }, RESEND).sendEmail(input)).rejects.toBeInstanceOf(Rejection);
    gmailConfig.value = { configured: true, trusted: true, available: false };
    await expect(createOutboundEmailSender("primary", { audience }, RESEND).sendEmail(input)).rejects.toBeInstanceOf(Rejection);
    expect(relaySend).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });
});
