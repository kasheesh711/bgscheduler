import { KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import { fieldsHash } from "../../submit";
import type { CorrectionProposal } from "../proposals";
import type { EvidenceBundle, NightlyTarget } from "../types";

/** Synthetic people and lesson only: the repository is public. */
export const SID = "6a0000000000000000000a01";
export const CID = "6a00000000000000000000c1";
export const STUDENT = "Pimchanok (Pim.Ta) Testwong";

/** A sound synthetic post for the student called Pim. */
export const PIM_FIELDS = {
  topics: "Today we worked on adding and subtracting fractions with unlike denominators, finding the lowest common multiple first, and then two word problems about sharing a cake fairly between friends.",
  performance: "Pim found the lowest common multiple for most questions without help and rewrote each fraction carefully. She hesitated on the second word problem, but once we drew a bar model she set up the subtraction correctly and checked her answer.",
  improvement: "Before our next lesson, Pim should practise simplifying answers fully by dividing by the highest common factor, and draw a quick bar model whenever a word problem has more than one step. Five short questions a day will build both habits.",
  homework: "",
};

export function nightlyTarget(patch: Partial<NightlyTarget> = {}): NightlyTarget {
  return {
    wiseSessionId: SID, wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, tutorKey: "Kevin",
    scheduledEndAt: "2026-10-02T09:30:00.000Z", deadlineAt: "2026-10-04T16:59:00.000Z", evidence: "transcript", arm: "sol",
    fields: PIM_FIELDS, fieldsSha256: "sha-1", billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
    sonioxTranscriptionId: "prod-job", firstShotPostId: "post-1", currentVerdictId: null, verdict: null, ownerFlagOpen: false,
    humanSavedSincePost: false, guided: false, pipeline: { evidence: "transcript", promptVersion: 5 },
    studentFullName: STUDENT, studentDisplayName: "Pim", className: STUDENT, ...patch,
  };
}

export function nightlyBundle(patch: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    wiseSessionId: SID, night: "2026-10-02", grade: "rebuilt", hash: "bundle-hash-0001",
    classDetails: ["Programme: Y5-6", "Class subject: Maths"], tutorNames: ["Arthit Teacherson", "Art"],
    studentFullName: STUDENT, studentDisplayName: "Pim", studentAliases: [], postedFields: PIM_FIELDS,
    wiseCurrentFields: PIM_FIELDS, wiseTextMatchesPost: true,
    transcript: { text: "[00:00] TUTOR: Today we add fractions.\n[00:10] STUDENT: Twelve.", source: "production_soniox", speakerMethod: "zoom_alignment", speakerLabels: "verified" },
    wiseSummary: "Overview: The class added fractions.", zoomCaptions: null, postedEvidenceKind: "transcript", scheduledMinutes: 60,
    storedJudge: null, pipeline: { evidence: "transcript" }, ...patch,
  };
}

/** PIM_FIELDS with the second performance sentence removed: a minimal fix's result. */
export const PIM_CORRECTED = {
  ...PIM_FIELDS,
  performance: "Pim found the lowest common multiple for most questions without help and rewrote each fraction carefully.",
};

/** A correction proposal as `verify` writes it, before signing. */
export function correctionProposal(patch: Partial<CorrectionProposal> = {}): CorrectionProposal {
  return {
    version: 1, night: "2026-10-02", wiseSessionId: SID, fieldsSha256: fieldsHash(PIM_FIELDS), fields: PIM_CORRECTED,
    fieldsHash: fieldsHash(PIM_CORRECTED), source: "minimal_fix", evidence: "transcript", arm: "sol",
    issues: [{ id: "i1", mode: "M06", severity: "major" }], modes: ["M06"], severity: "major", criticalCategory: null,
    checks: ["word_change", "length_ratio", "text_problems", "display_name", "judge", "reaudit", "reaudit_verdict", "reaudit_omissions",
      "reaudit_prior_issues", "reaudit_names", "reaudit_homework"].map((name) => ({ name, pass: true, detail: "synthetic" })),
    reason: "M06 overstated_judgement (major): corrected from the audit's minimal fix", rootCauseRef: "fix/autowriter-audit-m06",
    pipeline: { auditVersion: 1 }, createdAt: "2026-10-02T20:00:00.000Z", ...patch,
  };
}

/** Column order of `loadNightlyTargets`' main SELECT, for the pg-proxy fake. */
const TARGET_COLUMNS = [
  "wiseSessionId", "wiseClassId", "postWiseClassId", "wiseTeacherUserId", "scheduledEndAt", "deadlineAt", "evidence", "arm",
  "fields", "fieldsSha256", "billing", "sonioxTranscriptionId", "metadata", "sessionPostStartedAt", "firstShotPostId", "firstShotPipeline",
  "firstShotStartedAt", "firstShotRecordedAt", "reviewTutorKey", "currentVerdictId", "mirrorClassName",
] as const;

/** One raw row of the main target query (as the pg-proxy fake returns it) for a synthetic verified post. */
export function targetQueryRow(patch: { wiseSessionId: string; scheduledEndAt: string; fieldsSha256?: string; evidence?: "summary" | "transcript" }): unknown[] {
  const values: Record<string, unknown> = {
    wiseSessionId: patch.wiseSessionId, wiseClassId: CID, postWiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    scheduledEndAt: patch.scheduledEndAt, deadlineAt: null, evidence: patch.evidence ?? "transcript", arm: "sol", fields: PIM_FIELDS,
    fieldsSha256: patch.fieldsSha256 ?? `sha-${patch.wiseSessionId.slice(-4)}`, billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
    sonioxTranscriptionId: null, metadata: { className: STUDENT }, sessionPostStartedAt: null, firstShotPostId: `post-${patch.wiseSessionId.slice(-4)}`,
    firstShotPipeline: { evidence: patch.evidence ?? "transcript" }, firstShotStartedAt: null, firstShotRecordedAt: patch.scheduledEndAt,
    reviewTutorKey: "Kevin", currentVerdictId: null, mirrorClassName: null,
  };
  return TARGET_COLUMNS.map((column) => values[column] ?? null);
}
