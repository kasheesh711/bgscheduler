import {
  AUTOWRITER_JUDGE_EFFORTS,
  AUTOWRITER_MODELS,
  autowriterTranscriptFirst,
  autowriterTranscriptsEnabled,
  sonioxApiKey,
} from "./config";
import { JUDGE_PROMPT_VERSION } from "./judge";
import { PROMPT_VERSION } from "./prompt";

/**
 * What the autowriter is running with right now: the dashboard's system line. Built from `config.ts`, the prompt and
 * judge versions and the environment switches — never from the control row (mode and halt are `control`).
 */
export interface AutowriterSystemStatus {
  writer: { model: string; effort: string };
  fallbackWriter: { model: string; effort: string };
  /** The judge runs at every one of these efforts (`AUTOWRITER_JUDGE_EFFORTS`); a draft passes only when all pass it. */
  judge: { model: string; efforts: string[] };
  /** Transcript first as it acts: its switch, and the second pass on. */
  transcriptFirst: boolean;
  /** The second pass (Soniox transcript) as it acts: its switch, and a Soniox key. */
  secondPass: boolean;
  promptVersion: number;
  judgeVersion: number;
  /** The Vercel deploy's commit, or a local checkout's (`local:<sha>[+dirty]`); null when neither is known. */
  commit: string | null;
}

/**
 * The switches are reported as they act (`dispatch.ts`, `job.ts`): the second pass needs its switch and a Soniox key,
 * and transcript first acts only while the second pass is on.
 */
export function buildSystemStatus(env: Record<string, string | undefined> = process.env): AutowriterSystemStatus {
  const secondPass = autowriterTranscriptsEnabled(env) && sonioxApiKey(env) !== null;
  return {
    writer: { model: AUTOWRITER_MODELS.writer.model, effort: AUTOWRITER_MODELS.writer.effort },
    fallbackWriter: { model: AUTOWRITER_MODELS.fallbackWriter.model, effort: AUTOWRITER_MODELS.fallbackWriter.effort },
    judge: { model: AUTOWRITER_MODELS.judge.model, efforts: [...AUTOWRITER_JUDGE_EFFORTS] },
    transcriptFirst: secondPass && autowriterTranscriptFirst(env),
    secondPass,
    promptVersion: PROMPT_VERSION,
    judgeVersion: JUDGE_PROMPT_VERSION,
    commit: env.VERCEL_GIT_COMMIT_SHA || env.AUTOWRITER_LOCAL_COMMIT || null,
  };
}
