import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { DEFAULT_WEIGHTS, type HiringConfig } from "../model";
import type { Assessment } from "../scoring";
import { callEntries, callQueue, preScreenEntries, preScreenQueue, type FormCandidate } from "../queue";
import { dashboard, NOT_BLANK_PATTERN } from "../service";

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
  createdAt: new Date(createdAt),
  email: `${id}@example.com`,
  previouslyContacted: false,
  workRightsAnswer: "I have permanent work rights with no restrictions",
  profileAssessment: a,
  universityAssessment: null,
  queueManual: null,
  callReview: null,
  callInvited: false,
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
    expect(log.find((q) => q.includes('from "hiring_audit" where') && q.includes('"action" in'))).toMatch(/"created_at" >= \$\d+/);
    // Wave 1 holds every read; visitClashes may add one more. Before the change it was about 17.
    expect(waves()).toBeLessThanOrEqual(2);
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
