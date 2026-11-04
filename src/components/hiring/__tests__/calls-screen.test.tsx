import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BAD_CALL_REASON, CallsScreen, callCommand, triesText } from "../calls-screen";
import type { HiringData } from "../dashboard";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const candidate = (patch = {}) => ({
  id: "a",
  name: "Sample A",
  revision: 3,
  subjects: ["Mathematics"],
  profileScore: 86,
  profileAssessment: { briefSummary: "Strong maths tutor." },
  callReview: null,
  ...patch,
});
const data = (patch = {}) =>
  ({
    candidates: [candidate(), candidate({ id: "b", name: "Sample B", profileScore: 92 }), candidate({ id: "c", name: "Not Listed" })],
    callOrder: ["b", "a"],
    config: { callThreshold: 80 },
    ...patch,
  }) as unknown as HiringData;
const screen = (d = data()) =>
  renderToStaticMarkup(<CallsScreen data={d} extras={new Map()} holds={new Map()} onOpenRecord={() => {}} command={async () => true} busy={false} />);

describe("CallsScreen", () => {
  it("lists only the call queue, in the server's order, with the three results", () => {
    const html = screen();
    expect(html.indexOf("Sample B")).toBeLessThan(html.indexOf("Sample A"));
    expect(html).not.toContain("Not Listed");
    for (const word of ["Good call", "No answer", "Bad call", "2 to call", "Strong maths tutor.", "Not called yet"]) expect(html).toContain(word);
  });
  it("says so when nobody is waiting, and when calls are off", () => {
    expect(screen(data({ callOrder: [] }))).toContain("Nobody is waiting for a call.");
    expect(screen(data({ callOrder: [], config: { callThreshold: null } }))).toContain("Calls are off.");
  });
});

describe("callCommand", () => {
  const c = { id: "a", revision: 3, subjects: ["Mathematics" as const] };
  it("records a good call or a no answer, and stops on a bad call", () => {
    expect(callCommand(c, "good")).toEqual({ action: "call_result", id: "a", result: "good" });
    expect(callCommand(c, "no_answer")).toEqual({ action: "call_result", id: "a", result: "no_answer" });
    expect(callCommand(c, "bad")).toEqual({ action: "stop", id: "a", revision: 3, subjects: ["Mathematics"], reason: BAD_CALL_REASON });
  });
});

describe("triesText", () => {
  it("counts the no answers and gives the last one in Bangkok time", () => {
    const tries = [
      { at: "2026-11-04T02:00:00.000Z", by: "hr" },
      { at: "2026-11-04T09:30:00.000Z", by: "hr" },
    ];
    expect(triesText({ good: null, tries })).toBe("2 no answers · last 4 Nov, 16:30");
    expect(triesText({ good: null, tries: tries.slice(0, 1) })).toBe("1 no answer · last 4 Nov, 09:00");
  });
});
