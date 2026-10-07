import { describe, expect, it, vi } from "vitest";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import { createResendSender, resendConfigured, resendIdempotencyKey } from "../resend";

const ENV = { RESEND_API_KEY: "re_test", RESEND_FROM: "BeGifted <no-reply@notify.example.com>", SCHEDULE_EMAIL_REPLY_TO: "ops@example.com" };
const input = { to: "tutor@example.com", subject: "Schedule", html: "<p>h</p>", text: "h", idempotencyKey: "k-1" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("createResendSender", () => {
  it("posts one message with from, reply_to, idempotency header and returns the Resend id", async () => {
    const fetchImpl = reply(200, { id: "re-msg-1" });
    const result = await createResendSender(ENV, { fetchImpl }).sendEmail(input);
    expect(result).toEqual({ id: "re-msg-1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({
      from: ENV.RESEND_FROM, to: ["tutor@example.com"], subject: "Schedule",
      html: "<p>h</p>", text: "h", reply_to: "ops@example.com",
    });
  });

  it.each(["", "  \n "])("omits the text key when the plain-text part is blank (%j)", async (text) => {
    const fetchImpl = reply(200, { id: "x" });
    await createResendSender(ENV, { fetchImpl }).sendEmail({ ...input, text });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect("text" in body).toBe(false);
    expect(body.html).toBe("<p>h</p>");
  });

  it("prefers RESEND_REPLY_TO and per-call overrides", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await createResendSender({ ...ENV, RESEND_REPLY_TO: "r@example.com" }, { fetchImpl, from: "A <a@notify.example.com>" }).sendEmail(input);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBe("r@example.com");
    expect(body.from).toBe("A <a@notify.example.com>");
  });

  it("subject is single-line", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await createResendSender(ENV, { fetchImpl }).sendEmail({ ...input, subject: "Incident:\r\n style  down " });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).subject).toBe("Incident: style down");
  });

  it("missing from rejects before any network call", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await expect(createResendSender({ RESEND_API_KEY: "re_test" }, { fetchImpl }).sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("missing api key rejects before any network call", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await expect(createResendSender({ RESEND_FROM: ENV.RESEND_FROM }, { fetchImpl }).sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422, 429])("%i rejects (definitely not accepted)", async (status) => {
    const sender = createResendSender(ENV, { fetchImpl: reply(status, { name: "validation_error", message: "nope" }) });
    await expect(sender.sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
  });

  it.each([409, 500, 502, 503])("%i is uncertain (plain Error, never a rejection)", async (status) => {
    const sender = createResendSender(ENV, { fetchImpl: reply(status, { message: "x" }) });
    const error = await sender.sendEmail(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("5xx is uncertain even with a provider message", async () => {
    const sender = createResendSender(ENV, { fetchImpl: reply(500, { message: "internal" }) });
    await expect(sender.sendEmail(input)).rejects.toThrow(/uncertain/i);
  });

  it("network failure is uncertain", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const error = await createResendSender(ENV, { fetchImpl }).sendEmail(input).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("2xx without an id is uncertain", async () => {
    const error = await createResendSender(ENV, { fetchImpl: reply(200, {}) }).sendEmail(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("never puts the api key or recipient in an error message", async () => {
    const error = await createResendSender(ENV, { fetchImpl: reply(422, { message: "tutor@example.com is invalid" }) }).sendEmail(input).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("tutor@example.com");
    expect(String((error as Error).message)).not.toContain("re_test");
  });
});

describe("resendIdempotencyKey", () => {
  it("passes short keys through", () => expect(resendIdempotencyKey("auth-code:1")).toBe("auth-code:1"));
  it("long idempotency keys are hashed to a stable 64-char hex", () => {
    const long = "x".repeat(300);
    expect(resendIdempotencyKey(long)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resendIdempotencyKey(long)).toBe(resendIdempotencyKey(long));
  });
});

describe("resendConfigured", () => {
  it("needs both key and from", () => {
    expect(resendConfigured(ENV)).toBe(true);
    expect(resendConfigured({ RESEND_API_KEY: "x" })).toBe(false);
    expect(resendConfigured({ RESEND_FROM: "x" })).toBe(false);
  });
});
