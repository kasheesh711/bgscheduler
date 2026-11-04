import { describe, expect, it } from "vitest";
import { NO_ANSWER, NOT_CONFIRMED, NO_SEEK_FILTER, aheadAfterMove, campaignName, campaignNames, isFromSeek, matchesSeekFilter, mergeSourceSummaries, seekCoverage, sendQueueRows, universityOptions, workRightsOptions } from "../seek-view";

const person = (patch = {}) => ({
  id: "a",
  name: "Sample A",
  email: "a@example.com",
  seekApplicationId: "1",
  sourceIds: [] as string[],
  subjects: ["Mathematics" as const],
  profileScore: 86 as number | null,
  workRightsAnswer: "I am a Thai citizen" as string | null,
  universityAssessment: { name: "Mahidol University" } as { name: string | null } | null,
  ...patch,
});
const NOW = new Date("2026-11-02T10:00:00Z");

describe("isFromSeek", () => {
  it("keeps a person with a SEEK id and drops a person only in the tracker", () => {
    expect(isFromSeek(person())).toBe(true);
    expect(isFromSeek(person({ seekApplicationId: null, sourceIds: ["9"] }))).toBe(true);
    expect(isFromSeek(person({ seekApplicationId: null }))).toBe(false);
  });
});

describe("matchesSeekFilter", () => {
  it("passes everyone with no filter", () => {
    expect(matchesSeekFilter(person(), NO_SEEK_FILTER, 80)).toBe(true);
  });
  it("matches any of the picked universities, and the words for an unconfirmed one", () => {
    const pick = (universities: string[]) => ({ ...NO_SEEK_FILTER, universities });
    expect(matchesSeekFilter(person(), pick(["Mahidol University", "Chulalongkorn University"]), 80)).toBe(true);
    expect(matchesSeekFilter(person(), pick(["Chulalongkorn University"]), 80)).toBe(false);
    expect(matchesSeekFilter(person({ universityAssessment: null }), pick([NOT_CONFIRMED]), 80)).toBe(true);
    expect(matchesSeekFilter(person({ universityAssessment: { name: null } }), pick([NOT_CONFIRMED]), 80)).toBe(true);
  });
  it("matches the exact work rights answer, and a missing answer by its own words", () => {
    const pick = (workRights: string) => ({ ...NO_SEEK_FILTER, workRights });
    expect(matchesSeekFilter(person(), pick("I am a Thai citizen"), 80)).toBe(true);
    expect(matchesSeekFilter(person(), pick("I need a visa"), 80)).toBe(false);
    expect(matchesSeekFilter(person({ workRightsAnswer: null }), pick(NO_ANSWER), 80)).toBe(true);
  });
  it("splits scores at the threshold, and keeps unscored people apart", () => {
    const pick = (score: "pass" | "below" | "none") => ({ ...NO_SEEK_FILTER, score });
    expect(matchesSeekFilter(person({ profileScore: 80 }), pick("pass"), 80)).toBe(true);
    expect(matchesSeekFilter(person({ profileScore: 79.9 }), pick("pass"), 80)).toBe(false);
    expect(matchesSeekFilter(person({ profileScore: 79.9 }), pick("below"), 80)).toBe(true);
    expect(matchesSeekFilter(person({ profileScore: null }), pick("below"), 80)).toBe(false);
    expect(matchesSeekFilter(person({ profileScore: null }), pick("none"), 80)).toBe(true);
  });
  it("filters by subject and searches name and email", () => {
    expect(matchesSeekFilter(person(), { ...NO_SEEK_FILTER, subject: "Physics" }, 80)).toBe(false);
    expect(matchesSeekFilter(person(), { ...NO_SEEK_FILTER, query: "SAMPLE" }, 80)).toBe(true);
    expect(matchesSeekFilter(person(), { ...NO_SEEK_FILTER, query: "a@ex" }, 80)).toBe(true);
    expect(matchesSeekFilter(person(), { ...NO_SEEK_FILTER, query: "zzz" }, 80)).toBe(false);
  });
});

describe("filter options", () => {
  it("lists each university once, by name, with the unconfirmed group last", () => {
    expect(
      universityOptions([
        person({ id: "b", universityAssessment: { name: "Zeta University" } }),
        person(),
        person({ id: "c" }),
        person({ id: "d", universityAssessment: null }),
      ]),
    ).toEqual([
      { name: "Mahidol University", count: 2 },
      { name: "Zeta University", count: 1 },
      { name: NOT_CONFIRMED, count: 1 },
    ]);
  });
  it("lists each exact answer once, with the missing group last", () => {
    expect(
      workRightsOptions([person(), person({ id: "b" }), person({ id: "c", workRightsAnswer: null }), person({ id: "d", workRightsAnswer: "A visa" })]),
    ).toEqual([
      { name: "A visa", count: 1 },
      { name: "I am a Thai citizen", count: 2 },
      { name: NO_ANSWER, count: 1 },
    ]);
  });
});

describe("sendQueueRows", () => {
  it("numbers the queue from the server order, then lists sent people, newest first", () => {
    const rows = sendQueueRows(
      [person({ id: "x" }), person({ id: "y" }), person({ id: "s1" }), person({ id: "s2" }), person({ id: "n" })],
      ["y", "x"],
      new Map([
        ["s1", new Date("2026-11-01T00:00:00Z")],
        ["s2", new Date("2026-11-02T00:00:00Z")],
      ]),
    );
    expect(rows.map((r) => [r.candidate.id, r.place, r.sentAt?.toISOString() ?? null])).toEqual([
      ["y", 1, null],
      ["x", 2, null],
      ["s2", null, "2026-11-02T00:00:00.000Z"],
      ["s1", null, "2026-11-01T00:00:00.000Z"],
    ]);
  });
  it("keeps the true place when a filter hides people above", () => {
    const rows = sendQueueRows([person({ id: "x" })], ["y", "x"], new Map());
    expect(rows.map((r) => r.place)).toEqual([2]);
  });
});

describe("aheadAfterMove", () => {
  const order = ["a", "b", "c", "d"];
  it("takes the target's place when moving up or down", () => {
    expect(aheadAfterMove(order, "d", "b")).toEqual(["a"]);
    expect(aheadAfterMove(order, "a", "c")).toEqual(["b", "c"]);
    expect(aheadAfterMove(order, "c", "a")).toEqual([]);
    expect(aheadAfterMove(order, "a", "d")).toEqual(["b", "c", "d"]);
  });
  it("does nothing for itself or someone not in the queue", () => {
    expect(aheadAfterMove(order, "a", "a")).toBeNull();
    expect(aheadAfterMove(order, "x", "a")).toBeNull();
    expect(aheadAfterMove(order, "a", "x")).toBeNull();
  });
});

describe("campaigns", () => {
  const jobs = [
    { jobId: "95633167", label: "Nov ad", active: true },
    { jobId: "94844236", label: "Old ad", active: false },
  ];
  it("filters by the job a person was read from", () => {
    const pick = { ...NO_SEEK_FILTER, campaign: "95633167" };
    expect(matchesSeekFilter(person({ seekJobId: "95633167" }), pick, 80)).toBe(true);
    expect(matchesSeekFilter(person({ seekJobId: "94844236" }), pick, 80)).toBe(false);
    expect(matchesSeekFilter(person({ seekJobId: null }), pick, 80)).toBe(false);
    expect(matchesSeekFilter(person({ seekJobId: null }), NO_SEEK_FILTER, 80)).toBe(true);
  });
  it("names active campaigns for the header, and a row's campaign even when the job left the list", () => {
    expect(campaignNames(jobs)).toBe("Nov ad (95633167)");
    expect(campaignNames(jobs.map((j) => ({ ...j, active: false })))).toBe("no active campaign");
    expect(campaignName(jobs, "94844236")).toBe("Old ad");
    expect(campaignName(jobs, "11111111")).toBe("SEEK job 11111111");
    expect(campaignName(jobs, null)).toBe("No SEEK job");
  });
  it("sums each job's read into one summary and keeps each job's own numbers", () => {
    const one = { jobId: "95633167", scanned: 10, imported: 3, remaining: 0, resumeUploadsFailed: 1, folders: [{ status: "Inbox" as const, count: 8, imported: 7 }] };
    const two = { jobId: "94844236", scanned: 30, imported: 0, remaining: 2, folders: [{ status: "Inbox" as const, count: 20, imported: 18 }, { status: "Shortlist" as const, count: 4, imported: 4 }] };
    const merged = mergeSourceSummaries([one, two]);
    expect(merged).toMatchObject({ scanned: 40, imported: 3, remaining: 2, resumeUploadsFailed: 1, campaigns: [one, two] });
    expect(merged.folders).toEqual([{ status: "Inbox", count: 28, imported: 25 }, { status: "Shortlist", count: 4, imported: 4 }]);
    // The input folders are not changed by the sum.
    expect(one.folders[0].count).toBe(8);
  });
});

describe("seekCoverage", () => {
  const summary = {
    scanned: 40,
    imported: 2,
    remaining: 8,
    folders: [
      { status: "Inbox" as const, count: 120, imported: 112 },
      { status: "Shortlist" as const, count: 9, imported: 9 },
      { status: "Prescreen" as const, count: 34, imported: 34 },
      { status: "Not Suitable" as const, count: 500, imported: 0 },
    ],
  };
  it("shows only the imported folders, in worker order, with what is waiting", () => {
    const coverage = seekCoverage(summary, new Date("2026-11-02T09:50:00Z"), NOW)!;
    expect(coverage.rows).toEqual([
      { status: "Inbox", count: 120, imported: 112, waiting: 8 },
      { status: "Prescreen", count: 34, imported: 34, waiting: 0 },
      { status: "Shortlist", count: 9, imported: 9, waiting: 0 },
    ]);
    expect(coverage.stale).toBe(false);
  });
  it("says it does not know for a summary saved before the worker counted folders", () => {
    const old = { ...summary, folders: [{ status: "Inbox" as const, count: 120 }] };
    expect(seekCoverage(old, NOW, NOW)!.rows[0]).toEqual({ status: "Inbox", count: 120, imported: null, waiting: null });
  });
  it("marks a read older than an hour as stale, and has nothing to show before the first read", () => {
    expect(seekCoverage(summary, new Date("2026-11-02T08:59:00Z"), NOW)!.stale).toBe(true);
    expect(seekCoverage(summary, null, NOW)!.stale).toBe(true);
    expect(seekCoverage(null, null, NOW)).toBeNull();
  });
});
