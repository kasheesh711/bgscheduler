import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { like, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { approveAtomLink, loadAtomLessonEvidence, retainIsebEvidence, storedIsebEvidenceMatches } from "../atom/data";
import { evidenceHash } from "../atom/evidence";
import { parseAutowriterSessionDetail } from "../session";
import { sessionDetail, STUDENT_ID } from "./fixtures";
import { approveScheduledAtomProof, atomRolloutApproved, readIsebRollout } from "../iseb-rollout";
vi.mock("server-only", () => ({}));
let h: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const now = new Date();
const start = new Date(now.getTime() - 3600000).toISOString();
const end = now.toISOString();
const detail = parseAutowriterSessionDetail({ data: sessionDetail({ classSubject: "11+/13+", title: "Online Maths", scheduledStartTime: start, scheduledEndTime: end }) });
const approval = { wiseStudentId: STUDENT_ID, atomStudentId: "_123", wiseName: "Same Name", atomName: "Same Name", expectedRevision: 0, actor: "owner", note: "Checked both profiles", active: true };
beforeAll(async () => { h = await startTestDb(); db = h.db as unknown as Database; });
afterAll(async () => { vi.unstubAllEnvs(); await stopTestDb(h); });
beforeEach(async () => {
  vi.stubEnv("FEEDBACK_ATOM_ENRICHMENT_ENABLED", "true");
  await db.execute(sql`TRUNCATE feedback_atom_links, feedback_atom_sync_runs, feedback_iseb_evidence, feedback_iseb_rollouts CASCADE`);
});
async function snapshot() {
  await approveAtomLink(db, approval);
  const [run] = await db.insert(s.feedbackAtomSyncRuns).values({ triggerSource: "cron", status: "succeeded", startedAt: new Date(now.getTime() - 10000), finishedAt: new Date(now.getTime() - 5000), counts: { studentResults: { _123: "succeeded" } } }).returning();
  const activities: never[] = [];
  await db.insert(s.feedbackAtomSnapshots).values({ runId: run.id, atomStudentId: "_123", sourceHash: evidenceHash(activities), activities, collectedAt: new Date(now.getTime() - 6000) });
}
describe("Atom durable evidence", () => {
  it("does not change lesson evidence when switches are set without rollout approval", async () => {
    vi.stubEnv("FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED", "true");
    expect(await loadAtomLessonEvidence(db, { detail, studentId: STUDENT_ID, lessonRecord: "Fractions", now })).toBeNull();
    vi.stubEnv("FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED", "false");
  });
  it("does not auto-link duplicate names and serializes stable ID approvals", async () => {
    const first = await approveAtomLink(db, approval);
    expect(first.revision).toBe(1);
    await expect(approveAtomLink(db, approval)).rejects.toThrow("changed");
    await expect(approveAtomLink(db, { ...approval, wiseStudentId: "6a0000000000000000000009" })).rejects.toThrow("already linked");
    const [active] = await db.select().from(s.feedbackAtomLinks);
    expect(active.active).toBe(true);
  });
  it("new authentication failures invalidate old successful snapshots", async () => {
    await snapshot();
    await db.insert(s.feedbackAtomSyncRuns).values({ triggerSource: "cron", status: "failed", errorCode: "authentication_failed", startedAt: now, finishedAt: now });
    const atom = await loadAtomLessonEvidence(db, { detail, studentId: STUDENT_ID, lessonRecord: "Fractions", now, preview: true });
    expect(atom?.omissions[0].reason).toBe("authentication_failed");
  });
  it("student-specific source contradictions hold, even with an earlier valid snapshot", async () => {
    await snapshot();
    await db.insert(s.feedbackAtomSyncRuns).values({ triggerSource: "cron", status: "failed", errorCode: "source_contradiction", startedAt: now, finishedAt: now, counts: { studentResults: { _123: "source_contradiction" } } });
    const atom = await loadAtomLessonEvidence(db, { detail, studentId: STUDENT_ID, lessonRecord: "Fractions", now, preview: true });
    expect(atom?.status).toBe("contradiction");
  });
  it("retains immutable evidence and refuses stale mappings on a stored draft", async () => {
    const atom = await loadAtomLessonEvidence(db, { detail, studentId: STUDENT_ID, lessonRecord: "Fractions", now, preview: true });
    const [proof] = await db.insert(s.feedbackAtomSyncRuns).values({ triggerSource: "cron", status: "succeeded" }).returning();
    await db.insert(s.feedbackIsebRollouts).values({ id: "iseb-format-1-mimi-2", approvedBy: "owner", approvedAt: now, comparisonHash: "hash", cloudProofRunId: proof.id, unattendedConfirmedBy: "owner" });
    const hash = await retainIsebEvidence(db, { wiseSessionId: detail._id, atom, lessonRecord: "Fractions", evidenceKind: "summary" });
    expect(await storedIsebEvidenceMatches(db, detail, STUDENT_ID, { lessonEvidenceHash: hash, atomEvidenceHash: atom?.hash })).toBe(true);
    await snapshot();
    expect(await storedIsebEvidenceMatches(db, detail, STUDENT_ID, { lessonEvidenceHash: hash, atomEvidenceHash: atom?.hash })).toBe(false);
    await expect(db.execute(sql`UPDATE feedback_iseb_evidence SET lesson_record = 'changed'`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM feedback_atom_snapshots`)).rejects.toThrow();
  });
});

describe("unattended collector and rollout", () => {
  const comparisonHash = "a".repeat(64);
  async function approvedComparison() {
    await db.insert(s.feedbackIsebRollouts).values({ id: "iseb-format-1-mimi-2", approvedBy: "owner", approvedAt: now, comparisonHash });
  }
  async function cloudRun(overrides: Partial<typeof s.feedbackAtomSyncRuns.$inferInsert> = {}) {
    const [run] = await db.insert(s.feedbackAtomSyncRuns).values({ triggerSource: "cron", status: "succeeded",
      deploymentId: "dpl_cloud", startedAt: new Date(now.getTime() - 10000), finishedAt: now,
      counts: { snapshots: 1, activities: 7 }, ...overrides }).returning();
    return run;
  }
  it("persists scheduled cloud approval bound to the exact comparison without a shutdown claim", async () => {
    await approvedComparison();
    const run = await cloudRun();
    expect(await atomRolloutApproved(db)).toBe(false);
    await approveScheduledAtomProof(db, run.id, comparisonHash, "owner", "Scheduled cloud retrieval accepted");
    expect(await atomRolloutApproved(db)).toBe(true);
    expect(await readIsebRollout(db)).toMatchObject({ comparisonHash, approvedBy: "owner", cloudProofRunId: run.id,
      unattendedConfirmedBy: null, cloudProofReview: { method: "scheduled_cloud_run", runId: run.id,
        comparisonHash, approvedBy: "owner", note: "Scheduled cloud retrieval accepted", computerOffConfirmed: false,
        approvedAt: expect.any(String) } });
    // A replaced bundle cannot inherit this proof, even if somebody preserves its old approval fields.
    await db.update(s.feedbackIsebRollouts).set({ comparisonHash: "b".repeat(64) });
    expect(await atomRolloutApproved(db)).toBe(false);
  });
  it("requires the current comparison approval before recording cloud proof", async () => {
    const run = await cloudRun();
    await expect(approveScheduledAtomProof(db, run.id, comparisonHash, "owner", "Accepted")).rejects.toThrow("current comparison");
    await approvedComparison();
    await expect(approveScheduledAtomProof(db, run.id, "b".repeat(64), "owner", "Accepted")).rejects.toThrow("current comparison");
    expect((await readIsebRollout(db))?.cloudProofReview).toBeNull();
  });
  it.each([
    { triggerSource: "admin" }, { status: "failed", errorCode: "authentication_failed" }, { finishedAt: null },
    { deploymentId: null }, { counts: { snapshots: 1, activities: 0 } },
  ] satisfies Partial<typeof s.feedbackAtomSyncRuns.$inferInsert>[])("cannot activate from an unsuitable collection: %j", async overrides => {
    await approvedComparison();
    const run = await cloudRun(overrides);
    await expect(approveScheduledAtomProof(db, run.id, comparisonHash, "owner", "Accepted")).rejects.toThrow("scheduled cloud run");
    expect(await atomRolloutApproved(db)).toBe(false);
    expect((await readIsebRollout(db))?.cloudProofRunId).toBeNull();
  });
  it("collects only linked pending students and retains a complete overlap timetable", async () => {
    const { runAtomCollector } = await import("../atom/collector");
    const { KEVIN_ONLINE_WISE_USER_ID } = await import("../roster");
    await approveAtomLink(db, approval);
    await db.execute(sql`TRUNCATE feedback_autowriter_sessions`);
    await db.insert(s.feedbackAutowriterSessions).values({ wiseSessionId: detail._id, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, scheduledEndAt: now, deadlineAt: new Date(now.getTime()+86400000) });
    const collect = vi.fn<(studentId: string, dates: string[]) => Promise<never[]>>(async () => []);
    const close = vi.fn(async () => {});
    const result = await runAtomCollector({ db, deadlineMs: Date.now()+60000, triggerSource: "cron", now,
      openClient: async () => ({ catalog: [{ id: "_123", name: "Same Name" }, { id: "_999", name: "Same Name" }], collect, close }),
      fetchDays: async () => [{ _id: detail._id, userId: KEVIN_ONLINE_WISE_USER_ID, students: [STUDENT_ID], classId: { _id: "class", subject: "13+" }, title: "Online Maths", type: "SCHEDULED", meetingStatus: "ENDED", scheduledStartTime: start, scheduledEndTime: end }] as never,
    });
    expect(result.ok).toBe(true); expect(collect).toHaveBeenCalledTimes(1); expect(collect.mock.calls[0][0]).toBe("_123"); expect(close).toHaveBeenCalledOnce();
    expect(await db.select().from(s.feedbackAtomTimetables)).toHaveLength(2);
  });
  it("records an authentication failure and cannot count an admin probe as unattended proof", async () => {
    const { runAtomCollector } = await import("../atom/collector");
    const { AtomCollectionError } = await import("../atom/normalize");
    const { confirmUnattendedAtomProof } = await import("../iseb-rollout");
    const fetchDays = vi.fn(async () => []);
    const result = await runAtomCollector({ db, deadlineMs: Date.now()+60000, triggerSource: "admin", probe: { studentId: "_123", date: "2026-09-20" }, fetchDays, openClient: async () => { throw new AtomCollectionError("authentication_failed"); } });
    expect(fetchDays).toHaveBeenCalledWith(expect.arrayContaining(["2026-09-19", "2026-09-20"]));
    expect(result.ok).toBe(false);
    const [run] = await db.select().from(s.feedbackAtomSyncRuns); expect(run.errorCode).toBe("authentication_failed");
    expect(run.counts).toMatchObject({ failureStage: "atom_open", failureCause: "authentication_failed" });
    const incidents = await db.select().from(s.feedbackAutowriterIncidents).where(like(s.feedbackAutowriterIncidents.dedupeKey, "atom-collection:%:authentication_failed"));
    expect(incidents).toMatchObject([{ kind: "atom_collection_failed", severity: "critical", pushStatus: "pending" }]);
    const [probe] = await db.insert(s.feedbackAtomSyncRuns).values({triggerSource:"admin",status:"succeeded",deploymentId:"cloud",counts:{snapshots:1,activities:1}}).returning();
    await expect(confirmUnattendedAtomProof(db,probe.id,"owner")).rejects.toThrow("scheduled cloud run");
  });
  it("records the failing stage and a fixed cause label, never the raw error text", async () => {
    const { runAtomCollector } = await import("../atom/collector");
    await db.execute(sql`DELETE FROM feedback_autowriter_incidents`);
    const openClient = vi.fn();
    const result = await runAtomCollector({ db, deadlineMs: Date.now() + 60000, triggerSource: "admin", probe: { studentId: "_123", date: "2026-09-20" },
      fetchDays: async () => { throw new Error("Wise timetable occurrences conflict for teacher-secret-value"); }, openClient });
    expect(result).toMatchObject({ ok: false, errorCode: "collection_failed", failureStage: "wise_timetable", failureCause: "timetable_conflict" });
    expect(openClient).not.toHaveBeenCalled();
    const [run] = await db.select().from(s.feedbackAtomSyncRuns);
    expect(run.counts).toMatchObject({ failureStage: "wise_timetable", failureCause: "timetable_conflict" });
    const [incident] = await db.select().from(s.feedbackAutowriterIncidents);
    expect(incident.detail).toEqual({ runId: run.id, code: "collection_failed", stage: "wise_timetable", cause: "timetable_conflict" });
    expect(incident.summary).toContain("(wise_timetable: timetable_conflict)");
    expect(JSON.stringify([run, incident])).not.toContain("teacher-secret-value");
  });
  it("allows a scheduled retrieval trial only for an actively approved student", async () => {
    const { runAtomCollector } = await import("../atom/collector");
    const sessionsBefore = await db.select().from(s.feedbackAutowriterSessions);
    const collect = vi.fn(async () => []);
    const openClient = vi.fn(async () => ({ catalog: [{ id: "_123", name: "Same Name" }], collect, close: async () => {} }));
    const input = { db, deadlineMs: Date.now() + 60000, triggerSource: "cron" as const, deploymentId: "cloud", trial: true,
      probe: { studentId: "_123", date: "2026-09-20" }, fetchDays: async () => [], openClient };
    expect((await runAtomCollector(input)).ok).toBe(false);
    expect(openClient).not.toHaveBeenCalled();
    await approveAtomLink(db, approval);
    const result = await runAtomCollector(input);
    expect(result.ok).toBe(true);
    expect(collect).toHaveBeenCalledWith("_123", ["2026-09-20"]);
    const runs = await db.select().from(s.feedbackAtomSyncRuns);
    expect(runs.find(run => run.status === "succeeded")?.counts.trial).toBe(true);
    expect(await db.select().from(s.feedbackAutowriterSessions)).toEqual(sessionsBefore);
  });
  it("keeps pending lesson dates when the same student is used for the retrieval trial", async () => {
    const { runAtomCollector } = await import("../atom/collector");
    const { KEVIN_ONLINE_WISE_USER_ID } = await import("../roster");
    const { bangkokDate } = await import("../atom/evidence");
    await approveAtomLink(db, approval);
    await db.execute(sql`TRUNCATE feedback_autowriter_sessions`);
    await db.insert(s.feedbackAutowriterSessions).values({ wiseSessionId: detail._id, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, scheduledEndAt: now, deadlineAt: new Date(now.getTime() + 86400000) });
    const sessionsBefore = await db.select().from(s.feedbackAutowriterSessions);
    const trialDate = bangkokDate(new Date(now.getTime() - 3 * 86400000).toISOString());
    const collect = vi.fn(async () => []);
    const result = await runAtomCollector({ db, deadlineMs: Date.now() + 60000, triggerSource: "cron", now, trial: true,
      probe: { studentId: "_123", date: trialDate },
      openClient: async () => ({ catalog: [{ id: "_123", name: "Same Name" }], collect, close: async () => {} }),
      fetchDays: async () => [{ _id: detail._id, userId: KEVIN_ONLINE_WISE_USER_ID, students: [STUDENT_ID], classId: { _id: "class", subject: "13+" }, title: "Online Maths", type: "SCHEDULED", meetingStatus: "ENDED", scheduledStartTime: start, scheduledEndTime: end }] as never,
    });
    expect(result.ok).toBe(true);
    expect(collect).toHaveBeenCalledExactlyOnceWith("_123", [...new Set([bangkokDate(start), bangkokDate(end), trialDate])]);
    expect(await db.select().from(s.feedbackAutowriterSessions)).toEqual(sessionsBefore);
  });
});

describe("server review accounting", () => {
  it("counts only verified posts with source evidence, both factual verdicts and a passing style review", async () => {
    const { reviewIsebPosts, isebMonitoringProgress } = await import("../iseb-review");
    const { fieldsHash } = await import("../submit");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    await db.execute(sql`TRUNCATE feedback_autowriter_posts CASCADE`);
    const fields={topics:"1. Fractions",performance:"We worked carefully on finding common denominators. Tom explained the fraction additions clearly and corrected his simplification after checking the highest common factor. We practised checking each result together.",improvement:"1. Check the highest common factor of the numerator and denominator before writing the final fraction.",homework:""};
    const evidenceHash=await retainIsebEvidence(db,{wiseSessionId:"verified",atom:null,lessonRecord:"Tom practised fractions.",evidenceKind:"summary"});
    const fact={faithful:true,unsupported:[],misattributed:[],homeworkNotSet:[]};
    const pipeline={formatGuide:{id:"iseb",version:1},styleGuide:{id:"mimi",version:2},lessonEvidenceHash:evidenceHash,factualVerdicts:{...fact,levels:{medium:fact,high:fact}}};
    const base={kind:"first_shot" as const,fields,fieldsSha256:fieldsHash(fields),pipeline,billing:{},actorKind:"autowriter" as const,actor:"test",provenance:"live" as const};
    await db.insert(s.feedbackAutowriterPosts).values([{...base,wiseSessionId:"unknown",outcome:"unknown_outcome"},{...base,wiseSessionId:"verified",outcome:"verified"},{...base,wiseSessionId:"source_missing",outcome:"verified"}]);
    const call=vi.fn(async ()=>({ok:true as const,content:JSON.stringify({matches:true,problems:[]}),model:"openai/gpt-6.1-sol",provider:"Azure",generationId:"g",finishReason:"stop",usage:{promptTokens:1,completionTokens:1,reasoningTokens:0,cachedTokens:0,costUsd:0},latencyMs:1}));
    await reviewIsebPosts(db,Date.now()+200000,call);
    expect(call).toHaveBeenCalledOnce();
    const progress=await isebMonitoringProgress(db);
    expect(progress[0]).toMatchObject({cohort:"mimi_v2",verified:2,reviewed:1,unresolved:1});
    const incidents=await db.select().from(s.feedbackAutowriterIncidents).where(like(s.feedbackAutowriterIncidents.dedupeKey,"iseb-%"));
    expect(incidents).toMatchObject([{kind:"style_review_source_missing",severity:"critical",pushStatus:"pending",wiseSessionId:"source_missing"}]);
  });
  it("records a style fix and a style check that could not run as dashboard-only incidents", async () => {
    const { reviewIsebPosts } = await import("../iseb-review");
    const { fieldsHash } = await import("../submit");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    await db.execute(sql`TRUNCATE feedback_autowriter_posts, feedback_autowriter_incidents CASCADE`);
    const fields={topics:"1. Fractions",performance:"We worked carefully on finding common denominators. Tom explained the fraction additions clearly and corrected his simplification after checking the highest common factor. We practised checking each result together.",improvement:"1. Check the highest common factor of the numerator and denominator before writing the final fraction.",homework:""};
    const fact={faithful:true,unsupported:[],misattributed:[],homeworkNotSet:[]};
    const posts=[];
    for (const wiseSessionId of ["style_fix","style_down"]) {
      const evidenceHash=await retainIsebEvidence(db,{wiseSessionId,atom:null,lessonRecord:"Tom practised fractions.",evidenceKind:"summary"});
      const pipeline={formatGuide:{id:"iseb",version:1},styleGuide:{id:"mimi",version:2},lessonEvidenceHash:evidenceHash,factualVerdicts:{...fact,levels:{medium:fact,high:fact}}};
      posts.push({kind:"first_shot" as const,fields,fieldsSha256:fieldsHash(fields),pipeline,billing:{},actorKind:"autowriter" as const,actor:"test",provenance:"live" as const,wiseSessionId,outcome:"verified" as const,postStartedAt:new Date(now.getTime()-(wiseSessionId==="style_fix"?20000:10000))});
    }
    await db.insert(s.feedbackAutowriterPosts).values(posts);
    const usage={promptTokens:1,completionTokens:1,reasoningTokens:0,cachedTokens:0,costUsd:0};
    const call=vi.fn()
      .mockResolvedValueOnce({ok:true as const,content:JSON.stringify({matches:false,problems:["Use the numbered layout."]}),model:"openai/gpt-6.1-sol",provider:"Azure",generationId:"g",finishReason:"stop",usage,latencyMs:1})
      .mockResolvedValueOnce({ok:false as const,error:"rate limited",model:"openai/gpt-6.1-sol",provider:"Azure",latencyMs:1});
    await reviewIsebPosts(db,Date.now()+200000,call);
    expect(call).toHaveBeenCalledTimes(2);
    const incidents=(await db.select().from(s.feedbackAutowriterIncidents)).toSorted((a,b)=>String(a.wiseSessionId).localeCompare(String(b.wiseSessionId)));
    expect(incidents).toMatchObject([
      {wiseSessionId:"style_down",kind:"style_review_unavailable",severity:"info",pushStatus:"not_required"},
      {wiseSessionId:"style_fix",kind:"style_review_flagged",severity:"info",pushStatus:"not_required"},
    ]);
  });
});

describe("migration 0110", () => {
  it("relabels incidents recorded under scan_failed by the job that raised them; style results become dashboard-only", async () => {
    await db.execute(sql`TRUNCATE feedback_autowriter_incidents`);
    const I=s.feedbackAutowriterIncidents;
    await db.insert(I).values([
      {dedupeKey:"atom-collection:2026-10-02:collection_failed",kind:"scan_failed",severity:"critical",summary:"Atom",pushStatus:"pending"},
      {dedupeKey:"iseb-review-source:p1",kind:"scan_failed",severity:"critical",summary:"Source",pushStatus:"failed"},
      {dedupeKey:"iseb-style:p2:flagged",kind:"scan_failed",severity:"critical",summary:"Flagged",pushStatus:"pending",nextPushAt:now},
      {dedupeKey:"iseb-style:p3:unavailable",kind:"scan_failed",severity:"critical",summary:"Unavailable",pushStatus:"sent",pushedAt:now,pushedChannels:["email:owner@example.com"]},
      {dedupeKey:"forward-scan:x",kind:"scan_failed",severity:"critical",summary:"Scan",pushStatus:"pending"},
    ]);
    const file=fs.readFileSync(path.resolve(__dirname,"../../../../drizzle/0110_feedback_autowriter_incident_kinds.sql"),"utf8");
    for (const statement of file.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    const rows=Object.fromEntries((await db.select().from(I)).map(row=>[row.dedupeKey,row]));
    expect(rows["atom-collection:2026-10-02:collection_failed"]).toMatchObject({kind:"atom_collection_failed",severity:"critical",pushStatus:"pending"});
    expect(rows["iseb-review-source:p1"]).toMatchObject({kind:"style_review_source_missing",severity:"critical",pushStatus:"failed"});
    expect(rows["iseb-style:p2:flagged"]).toMatchObject({kind:"style_review_flagged",severity:"info",pushStatus:"not_required",nextPushAt:null});
    expect(rows["iseb-style:p3:unavailable"]).toMatchObject({kind:"style_review_unavailable",severity:"info",pushStatus:"not_required",pushedChannels:["email:owner@example.com"]});
    expect(rows["iseb-style:p3:unavailable"].pushedAt).not.toBeNull();
    expect(rows["forward-scan:x"]).toMatchObject({kind:"scan_failed",severity:"critical"});
    await expect(db.insert(I).values({dedupeKey:"bad",kind:"not_a_kind" as never,severity:"info",summary:"x",pushStatus:"not_required"})).rejects.toThrow();
  });
});
