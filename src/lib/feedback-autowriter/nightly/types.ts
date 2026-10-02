/**
 * Shared shapes of the nightly audit of autowriter posts (quick 261003-12b). The audit schema and prompt modules
 * (`audit-schema.ts`, `audit-prompt.ts`) compile against these, so change them only together.
 *
 * Grades say how close the evidence is to what the writer actually saw:
 * - exact: the writer's own input (the retained ISEB lesson record, or Wise's AI summary for a summary-route post);
 * - rebuilt: the production Soniox transcript, rendered again the way the second pass rendered it;
 * - retranscribed: our own Soniox job on Wise's recording (the production job was gone);
 * - secondary_only: only Wise's summary and/or Zoom's captions for a transcript-route post;
 * - none: nothing to audit against.
 */
export type EvidenceGrade = "exact" | "rebuilt" | "retranscribed" | "secondary_only" | "none";

/** One posted autowriter class to audit, as read (SELECT only) from our tables. */
export interface NightlyTarget {
  wiseSessionId: string;
  wiseClassId: string;
  wiseTeacherUserId: string | null;
  tutorKey: string | null;
  scheduledEndAt: string;
  deadlineAt: string | null;
  evidence: "summary" | "transcript";
  arm: string | null;
  fields: Record<string, string>;
  fieldsSha256: string;
  billing: Record<string, unknown> | null;
  sonioxTranscriptionId: string | null;
  firstShotPostId: string;
  currentVerdictId: string | null;
  verdict: "approve" | "needs_fix" | null;
  ownerFlagOpen: boolean;
  humanSavedSincePost: boolean;
  guided: boolean;
  pipeline: Record<string, unknown> | null;
  studentFullName: string | null;
  studentDisplayName: string | null;
  className: string | null;
}

/** Everything the auditor sees for one class (local, 0600; real data allowed). */
export interface EvidenceBundle {
  wiseSessionId: string;
  night: string;
  grade: EvidenceGrade;
  hash: string;
  classDetails: string[];
  tutorNames: string[];
  studentFullName: string | null;
  studentDisplayName: string | null;
  studentAliases: string[];
  postedFields: Record<string, string>;
  wiseCurrentFields: Record<string, string> | null;
  wiseTextMatchesPost: boolean | null;
  transcript: {
    text: string;
    source: "production_soniox" | "retranscribed_soniox" | "iseb_record";
    speakerMethod: string | null;
    speakerLabels: string | null;
  } | null;
  wiseSummary: string | null;
  zoomCaptions: string | null;
  postedEvidenceKind: "summary" | "transcript";
  scheduledMinutes: number | null;
  storedJudge: unknown;
  pipeline: Record<string, unknown> | null;
}

/** A deterministic finding made before the model looks; the model can only raise these, never lower them. */
export interface PrecheckFinding {
  code: string;
  severity: "critical" | "major" | "cosmetic" | "info";
  /** True when the finding is only a hint the auditor must confirm (another name, a meta word). */
  candidate: boolean;
  detail: string;
  mode: string | null;
}

/** One audit of one posted text (cached per session, text hash, audit version and bundle hash). */
export interface AuditRecord {
  wiseSessionId: string;
  fieldsSha256: string;
  auditVersion: number;
  promptVersion: number;
  bundleHash: string;
  grade: EvidenceGrade;
  result: import("./audit-schema").AuditResult | null;
  failure: string | null;
  proof: ClaudeProof | null;
  at: string;
}

/** What a `claude -p` call proves about itself: the argv, the CLI version, the models used and the spend. */
export interface ClaudeProof {
  argv: string[];
  cliVersion: string | null;
  models: string[];
  opusOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  effort: "max";
}
