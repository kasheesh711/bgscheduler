import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookingShell, CallBooking } from "../booking";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const LINE = "https://lin.ee/OjMHF41";
// Thursday 5 November 2026, 09:00 and 09:15 in Bangkok, and Friday 09:00.
const slots = [
  { date: "2026-11-05", start: "2026-11-05T02:00:00.000Z", end: "2026-11-05T02:15:00.000Z" },
  { date: "2026-11-05", start: "2026-11-05T02:15:00.000Z", end: "2026-11-05T02:30:00.000Z" },
  { date: "2026-11-06", start: "2026-11-06T02:00:00.000Z", end: "2026-11-06T02:15:00.000Z" },
];
const view = (patch = {}) => ({
  kind: "call" as const,
  minutes: 15,
  enabled: true,
  slots,
  call: null as { start: string; end: string } | null,
  canMove: false,
  notice: null as string | null,
  ...patch,
});
const page = (patch = {}) => renderToStaticMarkup(<CallBooking token="t" view={view(patch)} reload={async () => {}} />);

describe("CallBooking", () => {
  it("offers the days, the times of the first day, and a required phone field; the button waits for both", () => {
    const html = page();
    expect(html).toContain("15 minutes with our HR team");
    expect(html).toContain("2 times");
    expect(html).toContain("1 time");
    expect(html).toContain(">09:00<");
    expect(html).toContain(">09:15<");
    expect(html).toMatch(/<input[^>]*type="tel"[^>]*required/);
    expect(html).toContain("Your phone number");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm call<\/button>/);
    expect(html).toContain("contact BeGifted on LINE");
  });

  it("shows a booked call with one move, and no form until the candidate asks to move", () => {
    const booked = page({ call: { start: slots[0].start, end: slots[0].end }, canMove: true, slots: slots.slice(1) });
    expect(booked).toContain("Your booked call");
    expect(booked).toContain("09:00–09:15");
    expect(booked).toContain("Move this call");
    expect(booked).not.toContain('type="tel"');
    const fixed = page({ call: { start: slots[0].start, end: slots[0].end }, canMove: false, slots: [], notice: `This call has already moved once. Contact BeGifted on LINE: ${LINE}` });
    expect(fixed).not.toContain("Move this call");
    expect(fixed).toContain("already moved once");
  });

  it("shows the server's notice in place of the times when the calendar cannot be read", () => {
    const closed = page({ slots: [], notice: `Call times cannot be shown at the moment. Please try again later. Contact BeGifted on LINE: ${LINE}` });
    expect(closed).toContain("Call times cannot be shown at the moment.");
    expect(closed).toContain(`href="${LINE}"`);
    expect(closed).not.toContain('type="tel"');
    expect(closed).not.toContain("Confirm call");
    // An empty list with no notice still says something.
    expect(page({ slots: [] })).toContain("There are no open call times at the moment.");
  });

  it("names the page for a call", () => {
    expect(renderToStaticMarkup(<BookingShell kind="call">x</BookingShell>)).toContain("call with BeGifted");
  });
});
