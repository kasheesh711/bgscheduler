import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESUME_TYPES } from "@/lib/hiring/model";
import { CallsScreen } from "../calls-screen";
import type { HiringCandidate, HiringData } from "../dashboard";
import { nextCards, rejectCommand, RESUME_REJECT_REASON, ResumeDeck, swipeChoice, type DeckChoice } from "../resume-deck";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const candidate = (patch = {}) =>
  ({
    id: "a",
    name: "Sample A",
    revision: 3,
    subjects: ["Mathematics"],
    profileScore: 86.4,
    profileAssessment: { briefSummary: "Strong maths tutor.", subjects: [{ subject: "Mathematics", relevant: true }] },
    universityAssessment: { name: "Chulalongkorn University" },
    resumeState: "available",
    resumeType: RESUME_TYPES.pdf,
    seekApplicationId: "app-1",
    sourceIds: [],
    seekJobId: "95633167",
    callReview: null,
    ...patch,
  }) as unknown as HiringCandidate;
const data = (candidates: HiringCandidate[]) =>
  ({
    candidates,
    callOrder: candidates.map((c) => c.id),
    calls: [],
    inviteOutbox: [],
    config: {
      callThreshold: 70,
      resumeRetentionMonths: 12,
      subjectPriority: [{ subject: "Mathematics", hiring: true }],
      seekJobs: [{ jobId: "95633167" }],
    },
  }) as unknown as HiringData;
const deck = (rows: HiringCandidate[]) =>
  renderToStaticMarkup(<ResumeDeck data={data(rows)} rows={rows} command={async () => true} busy={false} onClose={() => {}} />);

describe("résumé deck rules", () => {
  it("rejects with the existing Stop, the candidate's revision and the résumé reason", () => {
    expect(rejectCommand(candidate())).toEqual({ action: "stop", id: "a", revision: 3, subjects: ["Mathematics"], reason: RESUME_REJECT_REASON });
  });
  it("needs a long drag: left rejects, right keeps, a short drag does nothing", () => {
    expect(swipeChoice(-140, 900)).toBe("reject");
    expect(swipeChoice(140, 900)).toBe("keep");
    expect(swipeChoice(-139, 900)).toBeNull();
    expect(swipeChoice(60, 900)).toBeNull();
    // A narrow phone card needs a quarter of its width.
    expect(swipeChoice(-80, 320)).toBe("reject");
    expect(swipeChoice(79, 320)).toBeNull();
  });
  it("a fast flick needs a short drag, and only in its own direction", () => {
    expect(swipeChoice(50, 900, 0.9)).toBe("keep");
    expect(swipeChoice(-50, 900, -0.9)).toBe("reject");
    expect(swipeChoice(30, 900, 0.9)).toBeNull();
    // The finger went right, then came back fast: no choice.
    expect(swipeChoice(50, 900, -0.9)).toBeNull();
  });
  it("shows the first candidate with no choice, in the Calls order, and the next one below", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(nextCards(rows, new Map())).toEqual([{ id: "a" }, { id: "b" }]);
    expect(nextCards(rows, new Map<string, DeckChoice>([["a", "keep"], ["b", "reject"]]))).toEqual([{ id: "c" }]);
    expect(nextCards(rows, new Map<string, DeckChoice>([["a", "keep"], ["b", "reject"], ["c", "keep"]]))).toEqual([]);
  });
});

describe("ResumeDeck", () => {
  it("shows one card with the name, subject, score and both actions, and writes nothing yet", () => {
    const html = deck([candidate(), candidate({ id: "b", name: "Sample B" })]);
    expect(html).toContain("Sample A");
    // The next card waits below the top one. Nobody can click or tab into it.
    expect(html).toMatch(/data-pos="next"[^>]*inert[^>]*>[\s\S]*Sample B/);
    expect(html.match(/data-pos="top"/g)).toHaveLength(1);
    expect(html).toContain("Mathematics");
    expect(html).toContain("Chulalongkorn University");
    expect(html).toContain(">86<");
    expect(html).toContain("← Reject");
    expect(html).toContain("Keep →");
    expect(html).toContain("2 left · 0 kept · 0 to reject");
    expect(html).not.toContain("Confirm");
  });
  it("opens the original file for a PDF and does not load the text", () => {
    const html = deck([candidate()]);
    expect(html).toContain("Opening the file");
    expect(html).not.toContain("Loading source text");
  });
  it("shows the application text for a Word file, with Download", () => {
    const html = deck([candidate({ resumeType: RESUME_TYPES.docx })]);
    expect(html).toContain("Loading source text");
  });
  it("shows the application text when no file is stored", () => {
    const html = deck([candidate({ resumeState: "none", resumeType: null })]);
    expect(html).toContain("Original résumé unavailable.");
    expect(html).toContain("Loading source text");
  });
  it("says so when nobody waits for a call", () => {
    expect(deck([])).toContain("Nobody is waiting for a call.");
  });
});

describe("CallsScreen", () => {
  const screen = (rows: HiringCandidate[]) =>
    renderToStaticMarkup(
      <CallsScreen data={data(rows)} extras={new Map()} holds={new Map()} onOpenRecord={() => {}} command={async () => true} busy={false} />,
    );
  it("offers the cards only when somebody is on the list", () => {
    expect(screen([candidate()])).toContain("Review résumés as cards");
    expect(screen([])).not.toContain("Review résumés as cards");
  });
});
