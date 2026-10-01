import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { approveAtomLink, loadAtomLessonEvidence, retainIsebEvidence, storedIsebEvidenceMatches } from "../atom/data";
import { evidenceHash } from "../atom/evidence";
import { parseAutowriterSessionDetail } from "../session";
import { sessionDetail, STUDENT_ID } from "./fixtures";
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
  await db.execute(sql`TRUNCATE feedback_atom_links, feedback_atom_sync_runs, feedback_iseb_evidence CASCADE`);
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
    const result = await runAtomCollector({ db, deadlineMs: Date.now()+60000, triggerSource: "cron", fetchDays: async () => [], openClient: async () => { throw new AtomCollectionError("authentication_failed"); } });
    expect(result.ok).toBe(false);
    const [run] = await db.select().from(s.feedbackAtomSyncRuns); expect(run.errorCode).toBe("authentication_failed");
    const [probe] = await db.insert(s.feedbackAtomSyncRuns).values({triggerSource:"admin",status:"succeeded",deploymentId:"cloud",counts:{snapshots:1,activities:1}}).returning();
    await expect(confirmUnattendedAtomProof(db,probe.id,"owner")).rejects.toThrow("scheduled cloud run");
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
  });
});
