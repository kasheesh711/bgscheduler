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
const createResendSender = vi.hoisted(() => vi.fn(() => ({ sendEmail: resendSend })));
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

describe("createOutboundEmailSender", () => {
  it("keeps today's relay behaviour, sender key and strictness when the flag is off", async () => {
    const sender = createOutboundEmailSender("backup", { strictOutcome: true }, {});
    expect(relay).toHaveBeenCalledWith("backup", { strictOutcome: true });
    expect(await sender.sendEmail(input)).toEqual({ id: "relay-1" });
    expect(createGmailSender).not.toHaveBeenCalled();
  });

  it("sends primary mail through Workspace Gmail with the configured reply-to and a single-line subject", async () => {
    const sender = createOutboundEmailSender("primary", {}, { ...GMAIL, SCHEDULE_EMAIL_REPLY_TO: "kevhsh7@gmail.com" });
    expect(await sender.sendEmail({ ...input, subject: "Incident:\nstyle reviewer down " })).toEqual({ id: "gmail-1" });
    expect(gmailSend).toHaveBeenCalledWith({ ...input, subject: "Incident: style reviewer down" });
    expect(createGmailSender).toHaveBeenCalledWith(expect.any(Function), undefined,
      { senderName: "BeGifted", replyTo: "kevhsh7@gmail.com" });
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("falls back to the primary relay when Gmail rejects before acceptance", async () => {
    gmailSend.mockRejectedValueOnce(new Rejection("Reconnect the dedicated Gmail sender"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sender = createOutboundEmailSender("primary", { strictOutcome: true }, GMAIL);
      expect(await sender.sendEmail(input)).toEqual({ id: "relay-1" });
      expect(relay).toHaveBeenCalledWith("primary", { strictOutcome: true });
      expect(relaySend).toHaveBeenCalledWith(input);
    } finally { error.mockRestore(); }
  });

  it("uses the relay without calling Gmail where Gmail is unavailable (preview, unconfigured, untrusted)", async () => {
    gmailConfig.value = { configured: true, trusted: true, available: false };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await createOutboundEmailSender("primary", {}, GMAIL).sendEmail(input)).toEqual({ id: "relay-1" });
      expect(gmailSend).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it("never resends through the relay after an uncertain Gmail outcome", async () => {
    gmailSend.mockRejectedValueOnce(new Error("Gmail acceptance is uncertain (HTTP 500)."));
    await expect(createOutboundEmailSender("primary", {}, GMAIL).sendEmail(input)).rejects.toThrow("uncertain");
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("routes the backup key straight to the primary relay", async () => {
    const sender = createOutboundEmailSender("backup", { strictOutcome: true }, GMAIL);
    expect(relay).toHaveBeenCalledWith("primary", { strictOutcome: true });
    expect(await sender.sendEmail(input)).toEqual({ id: "relay-1" });
    expect(gmailSend).not.toHaveBeenCalled();
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

  it("sends staff mail through Resend in wave one", async () => {
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "resend-1" });
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("keeps teacher mail (and untagged callers) on Workspace Gmail until RESEND_AUDIENCE=all", async () => {
    expect(await createOutboundEmailSender("primary", {}, RESEND).sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(await createOutboundEmailSender("primary", { audience: "teacher" }, RESEND).sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("sends teacher mail through Resend once RESEND_AUDIENCE=all", async () => {
    const sender = createOutboundEmailSender("primary", { audience: "teacher" }, { ...RESEND, RESEND_AUDIENCE: "all" });
    expect(await sender.sendEmail(input)).toEqual({ id: "resend-1" });
  });

  it("rejection falls back to Gmail with the same input", async () => {
    resendSend.mockRejectedValueOnce(new Rejection("403"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
      expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
      expect(gmailSend).toHaveBeenCalledWith(input);
    } finally { error.mockRestore(); }
  });

  it("uncertain Resend outcome is not retried on Gmail", async () => {
    resendSend.mockRejectedValueOnce(new Error("Resend acceptance is uncertain (HTTP 500)."));
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    await expect(sender.sendEmail(input)).rejects.toThrow(/uncertain/);
    expect(gmailSend).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("skips Resend entirely when it is not configured", async () => {
    resendConfigured.mockReturnValue(false);
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("backup is the Gmail chain, never Resend", async () => {
    const sender = createOutboundEmailSender("backup", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("leaves apps_script and gmail behaviour untouched", async () => {
    await createOutboundEmailSender("primary", { audience: "staff" }, {}).sendEmail(input);
    expect(relaySend).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
  });
});
