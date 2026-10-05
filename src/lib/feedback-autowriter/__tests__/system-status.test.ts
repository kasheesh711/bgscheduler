import { describe, expect, it } from "vitest";
import { AUTOWRITER_JUDGE_EFFORTS, AUTOWRITER_MODELS } from "../config";
import { JUDGE_PROMPT_VERSION } from "../judge";
import { PROMPT_VERSION } from "../prompt";
import { buildSystemStatus } from "../system-status";

describe("buildSystemStatus", () => {
  it("reports the models, judge levels and versions the pipeline runs with", () => {
    const status = buildSystemStatus({});
    expect(status.writer).toEqual({ model: AUTOWRITER_MODELS.writer.model, effort: AUTOWRITER_MODELS.writer.effort });
    expect(status.fallbackWriter).toEqual({ model: AUTOWRITER_MODELS.fallbackWriter.model, effort: AUTOWRITER_MODELS.fallbackWriter.effort });
    // The judge runs at every level in AUTOWRITER_JUDGE_EFFORTS, never at the config's own `effort`.
    expect(status.judge).toEqual({ model: AUTOWRITER_MODELS.judge.model, efforts: [...AUTOWRITER_JUDGE_EFFORTS] });
    expect(status.writer.model).not.toBe(status.fallbackWriter.model);
    expect(status.promptVersion).toBe(PROMPT_VERSION);
    expect(status.judgeVersion).toBe(JUDGE_PROMPT_VERSION);
  });

  it("shows the evidence switches as they act, not as they are set", () => {
    expect(buildSystemStatus({})).toMatchObject({ secondPass: false, transcriptFirst: false });
    // The second pass needs both its switch and a Soniox key.
    expect(buildSystemStatus({ FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED: "true" }).secondPass).toBe(false);
    expect(buildSystemStatus({ SONIOX_API_KEY: "key" }).secondPass).toBe(false);
    expect(buildSystemStatus({ FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED: "TRUE", SONIOX_API_KEY: "key" }).secondPass).toBe(false);
    const secondPass = { FEEDBACK_AUTOWRITER_TRANSCRIPTS_ENABLED: "true", SONIOX_API_KEY: "key" };
    expect(buildSystemStatus(secondPass)).toMatchObject({ secondPass: true, transcriptFirst: false });
    // Transcript first acts only while the second pass is on.
    expect(buildSystemStatus({ FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST: "true" }).transcriptFirst).toBe(false);
    expect(buildSystemStatus({ ...secondPass, FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST: "true" })).toMatchObject({ secondPass: true, transcriptFirst: true });
    // Holding summary-only drafts does not depend on the second pass.
    expect(buildSystemStatus({}).holdSummaryOnly).toBe(false);
    expect(buildSystemStatus({ FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY: "true" }).holdSummaryOnly).toBe(true);
  });

  it("names the commit that is running: the deploy's, else a local checkout's, else none", () => {
    expect(buildSystemStatus({}).commit).toBeNull();
    expect(buildSystemStatus({ AUTOWRITER_LOCAL_COMMIT: "local:abc1234" }).commit).toBe("local:abc1234");
    expect(buildSystemStatus({ VERCEL_GIT_COMMIT_SHA: "0123abc", AUTOWRITER_LOCAL_COMMIT: "local:abc1234" }).commit).toBe("0123abc");
    expect(buildSystemStatus({ VERCEL_GIT_COMMIT_SHA: "" }).commit).toBeNull();
  });
});
