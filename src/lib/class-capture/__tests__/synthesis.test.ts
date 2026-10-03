import { beforeEach, describe, expect, it, vi } from "vitest";
const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/feedback-autowriter/openrouter", () => ({ callOpenRouter: call }));
import { AUTOWRITER_MODELS } from "@/lib/feedback-autowriter/config";
import { readWorksheet, renderSynthesis, synthesizeFeedback } from "../synthesis";
import { transcriptSegments } from "../transcript-segments";
const empty = () => ({ text: "", sources: [], question: null as string | null });
const response = () => ({ topicsCovered: { text: "We discussed fractions.", sources: [{ sourceId: "recording:audio", quote: "fractions" }], question: null }, demonstratedUnderstanding: empty(), difficulties: empty(), homeworkNextSteps: empty() });
const source = { id: "recording:audio", kind: "recording", text: "Let's discuss fractions", segments: [{ text: "Let's discuss fractions", startMs: 1234, speaker: "1" }] };
beforeEach(() => { call.mockReset(); vi.stubEnv("OPENROUTER_API_KEY", "synthetic"); });
describe("readable feedback and separate evidence", () => {
  it("keeps citations and timestamps separate from copyable prose and leaves unsupported sections empty", () => {
    const result = renderSynthesis(response(), [source]);
    expect(result.fields.topicsCovered).toBe("We discussed fractions."); expect(result.fields.demonstratedUnderstanding).toBe("");
    expect(result.evidence.sources[0]).toMatchObject({ sourceId: source.id, startMs: 1234 });
    expect(JSON.stringify(result.fields)).not.toMatch(/recording:|1234|unverified/);
  });
  it("rejects fabricated sources, quotations, uncited sections and leaked internal labels", () => {
    for (const topicsCovered of [
      { text: "Mastered everything.", sources: [], question: null },
      { text: "Fractions.", sources: [{ sourceId: "other", quote: "fractions" }], question: null },
      { text: "Fractions.", sources: [{ sourceId: source.id, quote: "made up" }], question: null },
      { ...response().topicsCovered, text: "Class audio (speaker unverified; recording:audio)" },
      { ...response().topicsCovered, text: "11111111-1111-4111-8111-111111111111" },
    ]) expect(() => renderSynthesis({ ...response(), topicsCovered }, [source])).toThrow();
  });
  it("puts unclear homework questions only in review metadata", () => {
    const value = response(); value.homeworkNextSteps = { text: "", sources: [], question: "Which paper was assigned?" } as typeof value.homeworkNextSteps;
    const result = renderSynthesis(value, [source]); expect(result.fields.homeworkNextSteps).toBe(""); expect(result.evidence.questions).toEqual(["Which paper was assigned?"]);
  });
  it("sends private image bytes with the approved ZDR route and preserves worksheet categories", async () => {
    const findings = { questions: ["2+2"], studentWork: [], markings: [], uncertainties: ["Blank worksheet; no student answer visible."] };
    call.mockResolvedValue({ ok: true, model: AUTOWRITER_MODELS.writer.expectModel, content: JSON.stringify(findings) });
    expect(await readWorksheet(Buffer.from("private-fixture"), "image/jpeg")).toEqual(findings);
    const request = call.mock.calls[0][0]; expect(request.provider).toMatchObject({ zdr: true, data_collection: "deny" });
    expect(request.messages[1].content[1].image_url.url).toBe("data:image/jpeg;base64,cHJpdmF0ZS1maXh0dXJl");
  });
  it("supplies speaker turns and photo findings, with explicit ambiguity and blank-work rules", async () => {
    call.mockResolvedValue({ ok: true, model: AUTOWRITER_MODELS.writer.expectModel, content: JSON.stringify(response()) });
    await synthesizeFeedback({ topic: "Fractions", tutorNotes: "", prior: [], assets: [
      { id: "audio", kind: "recording", transcript: "Let's discuss fractions", transcriptSegments: source.segments },
      { id: "photo", kind: "worksheet", transcript: null, photoFindings: { questions: ["2+2"], studentWork: ["5"], markings: ["Cross beside 5"], uncertainties: ["Writer unidentified"] } },
    ] });
    const request = call.mock.calls[0][0];
    expect(request.messages[0].content).toContain("A teacher explanation"); expect(request.messages[0].content).toContain("blank worksheet");
    expect(request.messages[0].content).toContain("positive paper"); expect(request.messages[0].content).toContain("natural English");
    const input = JSON.parse(request.messages[1].content); expect(input.sources[0].segments).toEqual(source.segments); expect(input.sources[1].text).toContain("Cross beside 5");
  });
  it("distinguishes definite throttling from uncertain paid outcomes", async () => {
    call.mockResolvedValue({ ok: false, httpStatus: 429 }); await expect(readWorksheet(Buffer.from("x"), "image/jpeg")).rejects.toMatchObject({ retryable: true, uncertain: false });
    call.mockResolvedValue({ ok: false, httpStatus: 401 }); await expect(readWorksheet(Buffer.from("x"), "image/jpeg")).rejects.toMatchObject({ retryable: false, uncertain: false });
    call.mockResolvedValue({ ok: false, httpStatus: null }); await expect(readWorksheet(Buffer.from("x"), "image/jpeg")).rejects.toMatchObject({ retryable: false, uncertain: true });
  });
  it("preserves mixed Thai/English speaker boundaries, spacing and timings", () => {
    expect(transcriptSegments([
      { text: "ครึ่ง", start_ms: 10, end_ms: 30, speaker: "1" }, { text: " means half.", start_ms: 40, end_ms: 100, speaker: "1" },
      { text: "Half plus half is one.", start_ms: 110, end_ms: 300, speaker: "2" },
    ])).toEqual([{ text: "ครึ่ง means half.", startMs: 10, endMs: 100, speaker: "1" }, { text: "Half plus half is one.", startMs: 110, endMs: 300, speaker: "2" }]);
  });
});
