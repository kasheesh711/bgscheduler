import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SeekCoverage, SeekScreen } from "../seek-screen";
import type { HiringData } from "../dashboard";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const NOW = new Date("2026-11-02T10:00:00Z");
const candidate = (patch = {}) => ({
  id: "a",
  name: "Sample A",
  email: "a@example.com",
  seekApplicationId: "1",
  sourceIds: [],
  subjects: ["Mathematics"],
  profileScore: 86,
  workRightsAnswer: "I am a Thai citizen",
  workRightsAccepted: true,
  universityAssessment: { name: "Mahidol University", fraction: 0.5, reason: "Listed", sources: [] },
  ...patch,
});
const data = (patch = {}) =>
  ({
    candidates: [
      candidate(),
      candidate({ id: "b", name: "Sample B", profileScore: 90, seekApplicationId: "2", workRightsAnswer: "I need a visa", workRightsAccepted: false }),
      candidate({ id: "t", name: "Tracker Only", seekApplicationId: null }),
    ],
    config: { profileThreshold: 80, seekJobId: "9", profileWeights: { prestige: 10 }, resumeRetentionMonths: 12 },
    preScreenOrder: ["a"],
    workerSummary: null,
    workerAt: null,
    ...patch,
  }) as unknown as HiringData;
const screen = (d = data()) =>
  renderToStaticMarkup(<SeekScreen data={d} extras={new Map()} holds={new Map([["a", { short: "Next to send", long: ["Next"] }]])} onOpenRecord={() => {}} command={async () => true} busy={false} now={NOW} />);

describe("SeekScreen", () => {
  it("shows people from SEEK with the required columns, and leaves out a person only in the tracker", () => {
    const html = screen();
    expect(html).toContain("Sample A");
    expect(html).toContain("Sample B");
    expect(html).not.toContain("Tracker Only");
    for (const word of ["University", "Work rights", "Score", "Pre-screen", "Send queue", "2 shown of 2"]) expect(html).toContain(word);
    expect(html).toContain("Mahidol University");
    expect(html).toContain("I need a visa");
    expect(html).toContain("Next to send");
  });
  it("lists the highest score first in the all-candidates order, with the queue place on the row", () => {
    const html = screen();
    expect(html.indexOf("Sample B")).toBeLessThan(html.indexOf("Sample A"));
    expect(html).toMatch(/>1<\/td>/);
  });
  it("offers each university name and exact work rights answer as a filter", () => {
    const html = screen();
    expect(html).toContain("University: all");
    expect(html).toContain("I am a Thai citizen (1)");
  });
});

describe("SeekCoverage", () => {
  const summary = { scanned: 1, imported: 0, remaining: 8, folders: [{ status: "Inbox", count: 120, imported: 112 }] } as HiringData["workerSummary"];
  it("shows SEEK against imported, what is waiting, and the last read", () => {
    const html = renderToStaticMarkup(<SeekCoverage summary={summary} workerAt={new Date("2026-11-02T09:50:00Z")} now={NOW} />);
    expect(html).toContain("112 / 120");
    expect(html).toContain("8 waiting");
    expect(html).toContain("2 Nov, 16:50");
    expect(html).not.toContain("Over 1 hour old");
  });
  it("warns when the read is old, and says so when SEEK was never read", () => {
    expect(renderToStaticMarkup(<SeekCoverage summary={summary} workerAt={new Date("2026-11-01T09:50:00Z")} now={NOW} />)).toContain("Over 1 hour old");
    expect(renderToStaticMarkup(<SeekCoverage summary={null} workerAt={null} now={NOW} />)).toContain("has not read SEEK yet");
  });
});
