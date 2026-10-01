import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailSender } from "../gmail";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";

const input = { to: "tutor@example.com", subject: "Feedback – ภาษาไทย", text: "Please finish your feedback.",
  html: "<p>Please finish your feedback.</p>", idempotencyKey: "night:2026-10-01:tutor-1" };
afterEach(() => vi.unstubAllGlobals());

describe("Gmail reminder transport", () => {
  it("sends multipart mail from the approved mailbox and records Google's receipt", async () => {
    let request: RequestInit | undefined;
    let url: unknown;
    vi.stubGlobal("fetch", vi.fn(async (u, init) => { url = u; request = init; return Response.json({ id: "google-123" }); }));
    expect(await createGmailSender(async () => "access").sendEmail(input)).toEqual({ id: "google-123" });
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer access");
    const raw = Buffer.from(JSON.parse(String(request?.body)).raw, "base64url").toString();
    expect(raw).toContain("From: BeGifted <admin@begiftededucation.com>\r\n");
    expect(raw).toContain("To: tutor@example.com\r\n");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain(Buffer.from(input.text).toString("base64"));
    expect(raw).toContain(Buffer.from(input.html).toString("base64"));
    expect(raw).toMatch(/Message-ID: <[a-f0-9]+@begiftededucation.com>/);
  });

  it("rejects header injection before calling Google", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (...args: unknown[]) => { calls.push(args); return Response.json({ id: "wrong" }); });
    await expect(createGmailSender(async () => "access").sendEmail({ ...input, to: "tutor@example.com\r\nBcc: other@example.com" }))
      .rejects.toBeInstanceOf(ScheduleEmailRejection);
    expect(calls).toEqual([]);
  });

  it("refreshes credentials once after an explicit unauthorized rejection", async () => {
    const refresh: boolean[] = [];
    const auth: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const header = new Headers(init.headers).get("authorization")!; auth.push(header);
      return header === "Bearer stale" ? Response.json({ error: { code: 401 } }, { status: 401 }) : Response.json({ id: "renewed" });
    });
    expect(await createGmailSender(async (force = false) => { refresh.push(force); return force ? "fresh" : "stale"; }).sendEmail(input))
      .toEqual({ id: "renewed" });
    expect(refresh).toEqual([false, true]);
    expect(auth).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("passes a rate limit retry time to the durable queue without an immediate resend", async () => {
    let sends = 0;
    vi.stubGlobal("fetch", async () => { sends++; return Response.json({ error: { code: 429 } }, {
      status: 429, headers: { "Retry-After": "Thu, 01 Oct 2026 18:00:00 GMT" },
    }); });
    await expect(createGmailSender(async () => "access").sendEmail(input)).rejects.toMatchObject({
      definitelyNotAccepted: true, retryAt: new Date("2026-10-01T18:00:00Z"), permanent: false,
    });
    expect(sends).toBe(1);
  });

  it.each([500, 502, 503])("leaves HTTP %s acceptance uncertain", async (status) => {
    vi.stubGlobal("fetch", async () => Response.json({ error: {} }, { status }));
    await expect(createGmailSender(async () => "access").sendEmail(input)).rejects.not.toBeInstanceOf(ScheduleEmailRejection);
  });
  it("leaves network loss and missing receipt uncertain", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("connection lost"); });
    await expect(createGmailSender(async () => "access").sendEmail(input)).rejects.not.toBeInstanceOf(ScheduleEmailRejection);
    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(createGmailSender(async () => "access").sendEmail(input)).rejects.not.toBeInstanceOf(ScheduleEmailRejection);
  });
  it("treats a token failure before sending as definitely unsent", async () => {
    await expect(createGmailSender(async () => { throw new Error("invalid_grant"); }).sendEmail(input))
      .rejects.toMatchObject({ definitelyNotAccepted: true, permanent: true });
  });
});
