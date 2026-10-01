import { describe, expect, it, vi } from "vitest";
import { ISEB_FORMAT_GUIDE, activeFormatGuide, matchingFormatStamp, validateIsebFormat } from "../format";
import { MIMI_STYLE_GUIDE, MIMI_STYLE_GUIDE_V2, styleInstructions } from "../style";
import { buildAtomLessonEvidence, evidenceHash } from "../atom/evidence";
import { runWritingPipeline } from "../pipeline";
import type { OpenRouterCallResult } from "../openrouter";
import type { AtomLessonEvidence } from "../atom/types";
import { GOOD_FIELDS, SESSION_ID, STUDENT_ID, STUDENT_NAME } from "./fixtures";
const fields = { topics: "1. Adding fractions\n2. Mixed numbers", performance: GOOD_FIELDS.performance.replaceAll("Somchai", "[STUDENT_1]"), improvement: "1. After adding fractions, check the numerator and denominator for a common factor, then divide both by it before writing the final answer.", homework: "", studentAttended: true, lessonHappened: true };
const pass = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
const atom = () => buildAtomLessonEvidence({ lesson: { sessionId: SESSION_ID, studentId: STUDENT_ID, teacherId: "teacher", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z", subject: "maths" }, link: null, snapshot: null, now: new Date(), otherLessons: null, lessonRecord: "", unavailableReason: "student_unmapped" });
async function run(writers: object[], options: { evidence?: AtomLessonEvidence; judge?: typeof pass; tutor?: string } = {}) {
  const requests: Parameters<NonNullable<Parameters<typeof runWritingPipeline>[0]["callModel"]>>[0][] = [];
  const callModel = vi.fn(async (request: typeof requests[number]): Promise<OpenRouterCallResult> => {
    requests.push(request);
    const content = request.schemaName === "post_class_feedback" ? writers.shift() : options.judge ?? pass;
    return { ok: true, content: JSON.stringify(content), model: request.model, provider: request.schemaName === "post_class_feedback" ? "Azure" : "Together", generationId: "g", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 }, latencyMs: 1 };
  });
  const result = await runWritingPipeline({ apiKey: "test", formatGuide: ISEB_FORMAT_GUIDE, session: {
    canonicalTutorKey: options.tutor ?? "Mimi", wiseSessionId: SESSION_ID, atomEvidence: options.evidence ?? atom(), studentFullName: STUDENT_NAME, studentDisplayName: "Tom", classDetails: ["ISEB 13+", "Maths"], scheduledMinutes: 60,
    summary: { text: "Somchai practised adding fractions with unlike denominators. He found common denominators quickly, but rushed simplification twice and corrected both slips after checking the highest common factor. He explained his steps clearly. No homework was assigned.", meetingUUIDs: [] },
  }, tutorNames: ["Mimi"], priorFeedback: [], record: async () => {}, remainingMs: () => 700000, callModel });
  return { result, requests };
}
describe("ISEB format rollout", () => {
  it("is independent and limited to the initial five tutors and ISEB classes", () => {
    for (const tutor of ["Kevin", "Gift", "Ek", "Peat", "Mimi"]) expect(activeFormatGuide(tutor, ["13+ Maths"], { FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED: "true" })).toBe(ISEB_FORMAT_GUIDE);
    expect(activeFormatGuide("Mimi", ["GCSE Maths"], { FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED: "true" })).toBeNull();
    expect(activeFormatGuide("New tutor", ["ISEB"], { FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED: "true" })).toBeNull();
    expect(activeFormatGuide("Mimi", ["ISEB"], { FEEDBACK_ATOM_ENRICHMENT_ENABLED: "true" })).toBeNull();
  });
  it("preserves v1 while v2 keeps concrete coaching in improvement", () => {
    expect(MIMI_STYLE_GUIDE.version).toBe(1); expect(MIMI_STYLE_GUIDE_V2.version).toBe(2);
    expect(styleInstructions(MIMI_STYLE_GUIDE_V2)).toContain("concrete coaching in improvement");
    expect(matchingFormatStamp({ id: "iseb", version: 0 }, ISEB_FORMAT_GUIDE)).toBe(false);
    expect(matchingFormatStamp({ id: "iseb", version: 1 }, null)).toBe(false);
  });
  it("allows missing homework and short labels without per-field padding", async () => {
    const { result } = await run([fields]);
    expect(result).toMatchObject({ kind: "draft", styleGuide: { id: "mimi", version: 2 }, formatGuide: { id: "iseb", version: 1 }, fields: { homework: "" } });
  });
  it("uses the fallback after a format failure and gives both writers identical guides", async () => {
    const { result, requests } = await run([{ ...fields, topics: "Fractions" }, fields]);
    expect(result).toMatchObject({ kind: "draft", arm: "luna" });
    const writers = requests.filter(r => r.schemaName === "post_class_feedback");
    expect(writers).toHaveLength(2);
    expect(writers[0].messages).toEqual(writers[1].messages);
    expect(writers[0].messages[0].content).toContain("Mimi voice guide v2");
  });
  it("holds after both formatting failures and after both sparse drafts", async () => {
    expect((await run([{ ...fields, topics: "2. Fractions" }, { ...fields, homework: "Worksheet" }])).result.kind).toBe("held");
    const sparse = { ...fields, performance: "[STUDENT_1] tried.", improvement: "1. Check." };
    expect((await run([sparse, sparse])).result.kind).toBe("held");
  });
  it("gives both factual judges identical frozen Atom evidence", async () => {
    const evidence = atom();
    const { result, requests } = await run([fields], { evidence });
    expect(result.kind).toBe("draft");
    const judges = requests.filter(r => r.schemaName === "feedback_faithfulness");
    expect(judges).toHaveLength(2); expect(judges[0].messages).toEqual(judges[1].messages);
    for (const request of requests) expect(JSON.stringify(request.messages)).toContain("student_unmapped");
    expect(JSON.stringify(judges[0].messages)).not.toContain("Mimi voice guide");
  });
  it("holds invented scores rejected by either factual judge", async () => {
    const failed = { ...pass, faithful: false, unsupported: ["95% is invented"] };
    expect((await run([fields, fields], { judge: failed as typeof pass })).result.kind).toBe("held");
  });
  it("falls back for a score repeated from a lesson record without matched Atom evidence", async () => {
    const scored = { ...fields, performance: fields.performance + " We scored 19 out of 25 answers correct." };
    expect((await run([scored, fields])).result).toMatchObject({ kind: "draft", arm: "luna" });
    expect((await run([scored, scored])).result).toMatchObject({ kind: "held", reasons: expect.arrayContaining(["sol:atom:unmatched_result_statistic"]) });
  });
  it("holds confirmed source contradictions before generating or on either judge's report", async () => {
    const { hash: _hash, ...body } = atom(); void _hash;
    const conflict = { ...body, status: "contradiction" as const, contradictions: ["wrong_student"] };
    const first = await run([fields], { evidence: { ...conflict, hash: evidenceHash(conflict) } });
    expect(first.requests).toHaveLength(0); expect(first.result.kind).toBe("held");
    const failed = { ...pass, faithful: false, unsupported: ["SOURCE_CONTRADICTION: score disagrees"] };
    const second = await run([fields, fields], { judge: failed as typeof pass });
    expect(second.requests.filter(r => r.schemaName === "post_class_feedback")).toHaveLength(1);
    expect(second.result).toMatchObject({ kind: "held", reasons: expect.arrayContaining(["atom:source_contradiction"]) });
  });
  it("rejects sublists, numbering gaps and three performance paragraphs", () => {
    expect(validateIsebFormat({ ...fields, improvement: "1. Check\n- detail" })).toContain("style:numbering:improvement");
    expect(validateIsebFormat({ ...fields, performance: "First\n\nSecond\n\nThird" })).toContain("style:performance_prose");
  });
  it("rejects an opening recap of the topic list without rejecting learner-specific feedback", () => {
    const topics = "1. Non-verbal reasoning\n2. Polygon symmetry and parallel sides\n3. Rearranging equations with fractions\n4. Number sequences and nth terms";
    expect(validateIsebFormat({ ...fields, topics, performance: "We reviewed polygon symmetry and parallel sides, then worked on non-verbal reasoning and rearranging equations." })).toContain("style:topic_inventory_repeated");
    expect(validateIsebFormat({ ...fields, topics, performance: "Tom rearranged equations carefully and explained his reasoning about polygon symmetry." })).not.toContain("style:topic_inventory_repeated");
  });
});
