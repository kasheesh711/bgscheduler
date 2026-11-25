import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { type HiringConfig } from "../model";
import type { Assessment } from "../scoring";
import { callEntries, callQueue, preScreenEntries, preScreenQueue, type FormCandidate } from "../queue";
import { RUBRIC_ITEMS } from "../marking-sheet";
import { briefView, dashboard, NOT_BLANK_PATTERN } from "../service";
import { bookingToken } from "../tokens";
// The weights before the high-school part (24 Nov 2026). These tests pin scores made with them.
const DEFAULT_WEIGHTS = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20, school: 0 };

const assessment = (result: "met" | "partial"): Assessment => ({
  criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
    id,
    result: id === "english" ? result : "met",
    evidence: "quote",
    reason: "reason",
  })),
  subjects: [{ subject: "Physics", evidence: "quote", relevant: true }],
  universities: [],
  summary: "",
});
const row = (id: string, a: Assessment | null, createdAt: string): FormCandidate => ({
  id,
  stage: "new",
  broughtBackAt: null,
  createdAt: new Date(createdAt),
  email: `${id}@example.com`,
  previouslyContacted: false,
  workRightsAnswer: "I have permanent work rights with no restrictions",
  profileAssessment: a,
  universityAssessment: null,
  queueManual: null,
  callReview: null,
  callInvited: false,
  callBooked: false,
});
const config = {
  callThreshold: 80,
  profileThreshold: 60,
  profileWeights: DEFAULT_WEIGHTS,
  acceptedWorkRights: ["I have permanent work rights with no restrictions"],
  subjectPriority: [{ subject: "Physics", hiring: true }],
  interviewers: [{ canonicalKey: "Peat", email: "p@example.com", subjects: ["Physics"] }],
} as unknown as HiringConfig;
// Two at the call score (the earlier one first), one below it, one not scored.
const rows = [
  row("a", assessment("met"), "2026-11-02T00:00:00Z"),
  row("b", assessment("partial"), "2026-11-01T00:00:00Z"),
  row("c", assessment("met"), "2026-11-01T00:00:00Z"),
  row("d", null, "2026-11-01T00:00:00Z"),
];

/** A fake driver that answers the form-candidates read with `rows` (in driver form) and counts every query. */
function fakeDb(answer: unknown[][] = []) {
  const log: string[] = [];
  const params: unknown[] = [];
  let inFlight = 0;
  let waves = 0;
  const db = drizzle(
    async (sql, values) => {
      if (inFlight++ === 0) waves++;
      log.push(sql);
      params.push(...values);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { rows: sql.includes('"call_review"') ? answer : [] };
    },
    { schema },
  ) as unknown as Database;
  return { db, log, params, waves: () => waves };
}
const driverRows = rows.map((r) => [
  r.id,
  r.stage,
  r.broughtBackAt,
  r.createdAt.toISOString().replace("T", " ").replace("Z", "+00"),
  r.email,
  r.previouslyContacted,
  r.workRightsAnswer,
  r.profileAssessment,
  r.universityAssessment,
  r.queueManual,
  r.callReview,
  r.callInvited,
]);

describe("queue entries from rows already read", () => {
  it("gives the call queue in score order, then the earlier application", () => {
    expect(callEntries(rows, config).map((e) => e.id)).toEqual(["c", "a"]);
  });
  it("gives the form queue only the row below the call score", () => {
    expect(preScreenEntries(rows, config).map((e) => e.id)).toEqual(["b"]);
  });
  it("matches callQueue and preScreenQueue on the same rows", async () => {
    const { db } = fakeDb(driverRows);
    expect(await callQueue(db, config)).toEqual(callEntries(rows, config));
    expect(await preScreenQueue(db, config)).toEqual(preScreenEntries(rows, config));
  });
});

describe("dashboard reads", () => {
  it("reads the form candidates once, never the profile text, and waits in few waves", async () => {
    const { db, log, params, waves } = fakeDb();
    await dashboard(db);
    expect(log.filter((q) => q.includes('"call_review"') && q.includes("':pre-screen'"))).toHaveLength(1);
    const candidates = log.find((q) => q.startsWith('select "id", "source"') || (q.includes('from "hiring_candidates" order by')));
    expect(candidates).toBeDefined();
    expect(candidates).not.toMatch(/"profile_text",|"profile_text" from/);
    expect(candidates).toMatch(/"profile_text" ~ \$\d+/);
    expect(params).toContain(NOT_BLANK_PATTERN);
    expect(log.some((q) => q.includes('from "hiring_assessment_files"') && q.includes('"status"'))).toBe(true);
    // The onsite read is lean too, and starts in wave 1 with the others.
    const onsite = log.find((q) => q.includes('"pre_screen_override"') && q.includes("'onsite_invited'"));
    expect(onsite).toBeDefined();
    expect(onsite).not.toMatch(/"profile_text"|"profile_assessment"/);
    // Only people first seen in the funnel window count, so older audit rows are not read.
    // (The paper-check read also filters by action, with a row limit instead of a window.)
    expect(log.some((q) => q.includes('from "hiring_audit" where') && q.includes('"action" in') && /"created_at" >= \$\d+/.test(q))).toBe(true);
    // Gift's list needs only who has a final review packet, never the packet.
    const packets = log.find((q) => q.startsWith('select "candidate_id" from "hiring_audit"'));
    expect(packets).toBeDefined();
    expect(packets).not.toMatch(/"detail"/);
    // Wave 1 holds every read; visitClashes may add one more. Before the change it was about 17.
    expect(waves()).toBeLessThanOrEqual(2);
  });
});

describe("brief score status", () => {
  it.each([
    ["uploaded", false, "checking"],
    ["marking", false, "checking"],
    ["needs_check", false, "admin"],
    ["failed", false, "admin"],
    ["done", false, "admin"],
    ["done", true, null],
  ] as const)("reports %s with complete checks %s as %s", async (status, complete, recommendationBlock) => {
    const id = "00000000-0000-4000-8000-000000000001";
    const start = "2026-11-22T05:00:00Z";
    const end = "2026-11-22T06:00:00Z";
    const booking = { id, candidateId: id, subjects: ["Mathematics"], startTime: start, endTime: end };
    const rubric = { items: Object.fromEntries(RUBRIC_ITEMS.map((key) => [key, 8])), checksDone: complete ? true : null };
    const result = { id, bookingId: id, source: "ai", status, rubric };
    const driverRow = (table: typeof schema.hiringBookings | typeof schema.hiringMockResults, values: Record<string, unknown>) =>
      Object.keys(getTableColumns(table)).map((key) => values[key] ?? null);
    const db = drizzle(async (sql, params) => {
      if (sql.includes('from "hiring_bookings"')) return { rows: [[...driverRow(schema.hiringBookings, booking), "mock_booked"]] };
      if (sql.includes('from "hiring_candidates"')) return { rows: [["Sample Tutor", null, null, null]] };
      if (sql.includes('from "hiring_mock_results"')) return {
        rows: params.includes("done") ? (status === "done" ? [[id, rubric]] : []) : [driverRow(schema.hiringMockResults, result)],
      };
      return { rows: [] };
    }, { schema }) as unknown as Database;

    vi.stubEnv("AUTH_SECRET", "brief-unit-test");
    try {
      const token = bookingToken(id, "brief", new Date("2026-11-23T06:00:00Z"));
      expect(await briefView(token, db, new Date(end))).toMatchObject({
        form: "closed", recommendationReady: complete, recommendationBlock, rubric: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("NOT_BLANK_PATTERN", () => {
  it("agrees with JS trim() on every BMP character", () => {
    // Postgres ARE and JS read the same escapes in a bracket, so one string serves both.
    const notBlank = new RegExp(NOT_BLANK_PATTERN);
    const differ: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      if (notBlank.test(ch) !== (ch.trim().length > 0)) differ.push(cp.toString(16));
    }
    expect(differ).toEqual([]);
    expect(notBlank.test("\u00a0\ufeff\u3000 \t\n")).toBe(false);
    expect(notBlank.test(" \u00a0x ")).toBe(true);
  });
});
