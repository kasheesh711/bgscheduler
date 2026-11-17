import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildFunnel, type FunnelInput } from "@/lib/hiring/funnel";
import { matchesFilter } from "../candidate-table";
import { NO_FILTER, type HiringCandidate } from "../dashboard";
import { daysText, FunnelView, groupOptions, pickGroup, PipelineBoard } from "../funnel-panel";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const NOW = new Date("2026-11-17T17:30:00Z");
const day = (d: string) => `2026-${d}T03:00:00Z`;
const data: FunnelInput = {
  candidates: [
    { id: "a", stage: "review", createdAt: day("10-31"), seekJobId: "95633167", preScreenRepliedAt: null, callReview: null },
    { id: "b", stage: "new", createdAt: day("11-16"), seekJobId: null, preScreenRepliedAt: null, callReview: null },
    { id: "c", stage: "stopped", createdAt: day("11-10"), seekJobId: "95633167", preScreenRepliedAt: null, callReview: null },
  ],
  bookings: [],
  calls: [],
  inviteOutbox: [{ key: "b:call-invite", status: "sent", sentAt: day("11-17") }],
  decisions: [],
  funnelEvents: [],
};
const report = buildFunnel(data, NOW);
const campaigns = [{ jobId: "95633167", label: "International Curriculum Tutors" }];

describe("funnel panel", () => {
  it("lists all, each campaign and each week", () => {
    expect(groupOptions(report, campaigns).map((o) => o.label)).toEqual([
      "All candidates",
      "Campaign: International Curriculum Tutors (SEEK 95633167)",
      "Campaign: Tracker only (no SEEK job)",
      "Applied in week 47 of 2026",
      "Applied in week 46 of 2026",
      "Applied in week 44 of 2026",
    ]);
  });

  it("names few cases and missing times", () => {
    expect(daysText(undefined)).toBe("No timed cases yet");
    expect(daysText({ n: 3, median: 0.8, p90: 1.5 })).toBe("0.8 d median · p90 1.5 d (3 cases, few)");
  });

  it("shows every count with a rate or a time, the stuck rule, and the owner", () => {
    const html = renderToStaticMarkup(<FunnelView report={report} campaigns={campaigns} onShowStuck={() => {}} />);
    expect(html).toContain("33.3%"); // 1 of 3 contacted
    expect(html).toContain("1 (33%)"); // review count with its share
    expect(html).toContain("1 stuck (100%)");
    expect(html).toContain("after 7 days");
    expect(html).toContain("Read the record. Invite, move on or stop.");
    expect(html).toContain("Not counted"); // stopped is never stuck
    expect(html).toContain("their days are a lower bound");
    // Visible table names, so the Kevin job aid can point at them.
    expect(html).toMatch(/<caption[^>]*>Funnel steps<\/caption>/);
    expect(html).toMatch(/<caption[^>]*>Candidates by current stage<\/caption>/);
  });

  it("sends the stuck ids and the stage to the table filter", () => {
    const calls: [string, string[]][] = [];
    const tree = PipelineBoard({ g: report.groups.all, onShowStuck: (stage, ids) => calls.push([stage, ids]) });
    type El = { type?: unknown; props?: { children?: unknown; onClick?: () => void; "aria-label"?: string } };
    const find = (node: unknown): El | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
      const el = node as El;
      if (el.type === "button" && el.props?.["aria-label"]?.startsWith("Show the 1 stuck")) return el;
      return find(el.props?.children);
    };
    find(tree)?.props?.onClick?.();
    expect(calls).toEqual([["review", ["a"]]]);
  });

  it("falls back to all when the chosen group is gone after a reload", () => {
    expect(pickGroup(report, "campaign:95633167")).toBe("campaign:95633167");
    expect(pickGroup(report, "campaign:gone")).toBe("all");
  });

  it("says the counts can be low only when the candidate list is full", () => {
    const html = (r: typeof report) => renderToStaticMarkup(<FunnelView report={r} campaigns={campaigns} onShowStuck={() => {}} />);
    expect(report.capped).toBe(false);
    expect(html(report)).not.toContain("can be");
    const full = buildFunnel({ ...data, candidates: Array.from({ length: 2000 }, (_, i) => ({ ...data.candidates[0], id: `x${i}` })) }, NOW);
    expect(full.capped).toBe(true);
    expect(html(full)).toContain("Needs review: the page reads only the 2000 most recently updated candidates");
  });

  it("filters the candidate table to the stuck ids only", () => {
    const person = { id: "x", stage: "review" } as unknown as HiringCandidate;
    expect(matchesFilter(person, { ...NO_FILTER, ids: ["y"] }, new Set(), new Map())).toBe(false);
    expect(matchesFilter(person, { ...NO_FILTER, ids: ["x"] }, new Set(), new Map())).toBe(true);
  });
});
