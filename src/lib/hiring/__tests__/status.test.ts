import { describe, expect, it } from "vitest";
import { parseFormTimestamp, preScreenNote, preScreenStatus } from "../status";

const id = "c1";
const sent = new Date("2026-10-29T03:00:00Z");
const reminded = new Date("2026-11-01T03:00:00Z");
const job = (key: string, status = "sent", sentAt: Date | null = sent) => ({
  key,
  status,
  sentAt,
  workflowStage: "pre_screen" as string | null,
});
const candidate = (extra: Record<string, unknown> = {}) => ({
  id,
  stage: "pre_screen" as string,
  previouslyContacted: false,
  preScreen: null as { submittedAt: string } | null,
  ...extra,
});

describe("preScreenStatus", () => {
  it("is Not sent with no outbox row and no response", () => {
    expect(preScreenStatus(candidate({ stage: "new" }), [], false)).toEqual({
      status: "Not sent",
      sentAt: null,
      remindedAt: null,
      repliedAt: null,
    });
  });
  it("is Sent after the outbox receipt", () => {
    const result = preScreenStatus(candidate(), [job(`${id}:pre-screen`)], false);
    expect(result.status).toBe("Sent");
    expect(result.sentAt).toEqual(sent);
  });
  it("reads a sent time that came through JSON as text", () => {
    const result = preScreenStatus(candidate(), [job(`${id}:pre-screen`, "sent", sent.toISOString() as unknown as Date)], false);
    expect(result.sentAt).toEqual(sent);
  });
  it("is Reminded after a sent reminder", () => {
    const result = preScreenStatus(
      candidate(),
      [job(`${id}:pre-screen`), job(`${id}:pre-screen-reminder`, "sent", reminded)],
      false,
    );
    expect(result.status).toBe("Reminded");
    expect(result.sentAt).toEqual(sent);
    expect(result.remindedAt).toEqual(reminded);
  });
  it("ignores a reminder that is not sent", () => {
    const result = preScreenStatus(
      candidate(),
      [job(`${id}:pre-screen`), job(`${id}:pre-screen-reminder`, "pending", null)],
      false,
    );
    expect(result.status).toBe("Sent");
    expect(result.remindedAt).toBeNull();
  });
  it("is Replied whenever a response exists", () => {
    const result = preScreenStatus(
      candidate({ stage: "paper_invited", preScreen: { submittedAt: "31/10/2026, 5:00:00" } }),
      [job(`${id}:pre-screen`)],
      false,
    );
    expect(result.status).toBe("Replied");
    expect(result.repliedAt).toBe("31/10/2026, 5:00:00");
  });
  it("is Earlier contact with no app send and previouslyContacted", () => {
    expect(preScreenStatus(candidate({ stage: "new", previouslyContacted: true }), [], false).status).toBe("Earlier contact");
  });
  it("is Sent, not Earlier contact, when the app did send", () => {
    expect(preScreenStatus(candidate({ previouslyContacted: true }), [job(`${id}:pre-screen`)], false).status).toBe("Sent");
  });
  it("is No reply at stage no_reply and keeps the send time", () => {
    const result = preScreenStatus(candidate({ stage: "no_reply" }), [job(`${id}:pre-screen`)], false);
    expect(result.status).toBe("No reply");
    expect(result.sentAt).toEqual(sent);
  });
  it("is Queued when ready and not sent", () => {
    expect(preScreenStatus(candidate({ stage: "new" }), [], true).status).toBe("Queued");
  });
  it("is Queued while the pre-screen email waits in the outbox", () => {
    expect(preScreenStatus(candidate(), [job(`${id}:pre-screen`, "pending", null)], false).status).toBe("Queued");
  });
  it.each(["failed", "uncertain"])("stays Queued after a %s email, which may still reach the candidate", (status) => {
    expect(preScreenStatus(candidate(), [job(`${id}:pre-screen`, status, null)], false).status).toBe("Queued");
  });
  it("is not Queued from an outbox row whose workflow stage no longer matches the candidate", () => {
    const stale = { ...job(`${id}:pre-screen`, "pending", null), workflowStage: "pre_screen" };
    expect(preScreenStatus(candidate({ stage: "stopped" }), [stale], false).status).toBe("Not sent");
    expect(preScreenStatus(candidate({ stage: "stopped" }), [{ ...stale, status: "cancelled" }], false).status).toBe("Not sent");
    // Ready alone still gives Queued.
    expect(preScreenStatus(candidate({ stage: "new" }), [], true).status).toBe("Queued");
  });
});

describe("form timestamps", () => {
  it("reads d/m/yyyy, H:mm:ss as GMT and shows Bangkok time", () => {
    expect(parseFormTimestamp("31/10/2026, 18:30:05")?.toISOString()).toBe("2026-10-31T18:30:05.000Z");
    const note = preScreenNote(
      { status: "Replied", sentAt: sent, remindedAt: null, repliedAt: "31/10/2026, 18:30:05" },
      true,
    );
    expect(note).toBe("Sent 29 Oct, 10:00 · replied 1 Nov, 01:30");
  });
  it("starts the note with a capital when there is no send time", () => {
    expect(preScreenNote({ status: "Replied", sentAt: null, remindedAt: null, repliedAt: "31/10/2026, 18:30:05" })).toBe("Replied 1 Nov");
  });
  it("returns null for text it cannot read", () => {
    expect(parseFormTimestamp("last week")).toBeNull();
    expect(preScreenNote({ status: "Replied", sentAt: null, remindedAt: null, repliedAt: "last week" })).toBe("Replied");
  });
});
