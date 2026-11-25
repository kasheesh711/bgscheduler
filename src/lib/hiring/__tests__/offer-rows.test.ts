import { describe, expect, it } from "vitest";
import { offerNext, type OfferRow } from "../offer-rows";

const now = new Date("2026-11-25T05:00:00Z");
const sent = "2026-11-24T07:00:00Z";
const visit = (day: number, hour = 7) => ({
  start: new Date(Date.UTC(2026, 10, day, hour)).toISOString(),
  end: new Date(Date.UTC(2026, 10, day, hour, 30)).toISOString(),
});
const offer: OfferRow = {
  candidateId: "tutor", decisionId: "decision", name: "Sample Tutor", subject: "Physics",
  emailStatus: "sent", sentAt: sent, offerType: "specialist", booking: null,
  uploadedAt: null, submittedAt: null, unknown: {},
};

describe("offerNext", () => {
  const cases = [
    ["today", { booking: visit(25) }, "Print contract", "print"],
    ["chase", { sentAt: "2026-11-22T15:59:00Z" }, "Chase booking", null],
    ["failed", { emailStatus: "failed", sentAt: null }, "Check failed email", null],
    ["visitEnded", { booking: visit(24), submittedAt: sent }, "Upload signed PDF", "upload"],
    ["booked", { booking: visit(26) }, "Print contract", "print"],
    ["awaitBooking", {}, "Await booking", null],
    ["queued", { emailStatus: "pending", sentAt: null }, "Await delivery", null],
    ["unknown", { unknown: { booking: true } }, "Check offer details", "refresh"],
    ["awaitForm", { uploadedAt: sent }, "Await form", null],
    ["done", { uploadedAt: sent, submittedAt: sent }, "Onboarding", "onboarding"],
  ] as const satisfies readonly (readonly [string, Partial<OfferRow>, string, string | null])[];

  it.each(cases)("returns the next step for %s", (state, fields, label, action) => {
    expect(offerNext({ ...offer, ...fields }, now)).toMatchObject({ state, label, action });
  });

  it("sorts tasks in the requested order, with completed offers last", () => {
    const ranked = [...cases].reverse()
      .map(([, fields]) => offerNext({ ...offer, ...fields }, now))
      .sort((a, b) => a.rank - b.rank);
    expect(ranked.map(({ state }) => state)).toEqual(cases.map(([state]) => state));
  });

  it("counts Bangkok dates at midnight and prioritizes a signing that ended today", () => {
    expect(offerNext({ ...offer, sentAt: "2026-11-22T17:00:00Z" }, now).state).toBe("awaitBooking");
    expect(offerNext({ ...offer, booking: visit(25, 3) }, now)).toMatchObject({ action: "upload", rank: 0 });
  });

  it("keeps the queued and uncertain states distinct and waits for missing evidence", () => {
    expect(offerNext({ ...offer, emailStatus: "processing" }, now).state).toBe("queued");
    expect(offerNext({ ...offer, emailStatus: "cancelled" }, now).state).toBe("failed");
    expect(offerNext({ ...offer, emailStatus: "uncertain" }, now).state).toBe("uncertain");
    expect(offerNext({ ...offer, booking: visit(24), unknown: { pdf: true } }, now).action).toBe("refresh");
    expect(offerNext({ ...offer, uploadedAt: sent, unknown: { form: true } }, now).action).toBe("refresh");
  });

  it("distinguishes a missing email from a failed outbox read", () => {
    const missing = { ...offer, emailStatus: null, sentAt: null };
    expect(offerNext(missing, now)).toMatchObject({ state: "notQueued", label: "Ask Kevin" });
    expect(offerNext({ ...missing, unknown: { email: true } }, now)).toMatchObject({ state: "unknown", action: "refresh" });
  });
});
