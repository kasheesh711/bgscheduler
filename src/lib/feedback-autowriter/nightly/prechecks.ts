import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { postedBilling } from "../first-shot";
import { chooseStudentDisplayName } from "../prompt";
import { rosterAccountIds } from "../roster";
import { parseAutowriterSessionDetail, teacherSubmissionSnapshot } from "../session";
import { evidenceNotes, type RawEvidence } from "./evidence";
import { correctionTextProblems, guidesFromStamp, type TextProblem } from "./text-problems";
import type { EvidenceBundle, NightlyTarget, PrecheckFinding } from "./types";

/**
 * Deterministic floors before the model looks (the auditor can only raise them):
 * - critical: billing drift between Wise's teacher submission and what we posted, or not exactly one teacher submission;
 * - major: production validator codes on the posted text, the student called by their multi-word name;
 * - candidates the auditor must confirm: another student's or person's name, a tutor name, a one-word form of the
 *   student's name, meta words (all can be ordinary words or lesson content);
 * - info: Wise's text edited since our post (never corrected over), a guided post, a person's save, an open owner flag.
 * Codes carry no names or lesson text; `detail` does (local files and the auditor's prompt only).
 */

const S = schema.feedbackAutowriterSessions;
const PC = schema.postClassSessions;

/** Which failure mode a validator reason points to (null: the content policy's own length/padding rules). */
function validatorMode(reason: string): string | null {
  if (/^validator:(placeholder_token|thai_text|markdown|style:|attendance_wording)/u.test(reason)) return "M12";
  if (/^validator:ai_suspect:/u.test(reason)) return "M10";
  return null;
}

function finding(code: string, severity: PrecheckFinding["severity"], detail: string, mode: string | null, candidate = false): PrecheckFinding {
  return { code, severity, candidate, detail: detail.slice(0, 300), mode };
}

function fromTextProblem(problem: TextProblem): PrecheckFinding {
  const where = problem.field ? ` in ${problem.field}` : "";
  const what = problem.detail ? ` (${problem.detail})` : "";
  if (problem.code.startsWith("validator:")) {
    return finding(problem.code, "major", `Production validator: ${problem.code.slice("validator:".length)}${where}`, validatorMode(problem.code));
  }
  if (problem.code.startsWith("meta_word:")) {
    return finding(problem.code, "major", `Meta word${what}${where}: confirm it is about the lesson's delivery, not lesson content`, "M12", true);
  }
  if (problem.code === "student_name_form") {
    // A one-word form (a first name, a surname, a nickname code) can be an ordinary word or another person's name:
    // the audit confirms it. The student's multi-word name is unmistakable: a floor.
    const oneWord = !/\s/u.test(problem.detail ?? "");
    return oneWord
      ? finding(problem.code, "major", `The student may be called${what}${where}, not by the display name: confirm it is the student's name`, "M11", true)
      : finding(problem.code, "major", `The student is called${what}${where}, not by the display name`, "M11");
  }
  if (problem.code === "tutor_named") {
    return finding(problem.code, "major", `A tutor name${what}${where}: confirm it names the tutor`, "M11", true);
  }
  if (problem.code === "other_student_named") {
    return finding(problem.code, "critical", `Another student of this tutor${what}${where}: confirm it is a person named in this feedback`, "M02", true);
  }
  return finding(problem.code, "major", `Another person may be named${what}${where}: confirm it is a person's name`, "M11", true);
}

/** Wise's teacher submission against the billing we posted with (from the detail read tonight). */
function billingFindings(target: NightlyTarget, raw: RawEvidence | null | undefined): PrecheckFinding[] {
  if (!raw?.detail) return [];
  let snapshot: ReturnType<typeof teacherSubmissionSnapshot>;
  try {
    snapshot = teacherSubmissionSnapshot(parseAutowriterSessionDetail(raw.detail));
  } catch {
    return [];
  }
  const out: PrecheckFinding[] = [];
  if (snapshot.count !== 1) {
    out.push(finding(`teacher_submissions_${snapshot.count}`, "critical", `Wise shows ${snapshot.count} teacher submissions for the class (expected exactly 1)`, "M13"));
  }
  const billing = postedBilling(target.billing);
  if (!billing) {
    out.push(finding("billing_unknown", "info", "The posted billing is not readable; billing drift was not checked", null));
  } else if (snapshot.count >= 1 && (snapshot.sessionStatus !== billing.sessionStatus || snapshot.creditsConsumed !== billing.creditsConsumed)) {
    out.push(finding(
      "billing_drift",
      "critical",
      `Wise shows ${snapshot.sessionStatus ?? "no status"} / ${snapshot.creditsConsumed ?? "no"} credits; we posted ${billing.sessionStatus} / ${billing.creditsConsumed}`,
      "M13",
    ));
  }
  return out;
}

export function runPrechecks(input: {
  bundle: EvidenceBundle;
  target: NightlyTarget;
  otherStudentNames: readonly string[];
  priorFeedback: readonly PriorFeedbackComparison[];
  /** The raw evidence, for billing (Wise's submission) and collection notes. */
  raw?: RawEvidence | null;
}): PrecheckFinding[] {
  const { bundle, target } = input;
  const findings: PrecheckFinding[] = [...billingFindings(target, input.raw)];

  if (bundle.wiseTextMatchesPost === false) {
    findings.push(finding("wise_text_edited", "info", "Wise's current text is not the posted text: someone edited it since. Never corrected over.", null));
  }

  const studentFullName = bundle.studentFullName ?? target.studentFullName;
  const studentDisplayName = bundle.studentDisplayName ?? (studentFullName ? chooseStudentDisplayName(studentFullName) : null);
  if (studentFullName && studentDisplayName) {
    const lessonRecord = (bundle.transcript?.text ?? bundle.wiseSummary ?? "") + (target.pipeline?.atomEvidenceHash ? "\nAtom learning" : "");
    const problems = correctionTextProblems({
      wiseSessionId: target.wiseSessionId,
      fields: bundle.postedFields,
      studentFullName,
      studentDisplayName,
      studentAliases: bundle.studentAliases,
      tutorNames: bundle.tutorNames,
      classDetails: bundle.classDetails,
      priorFeedback: input.priorFeedback,
      otherStudentNames: input.otherStudentNames,
      ...guidesFromStamp(target.pipeline),
      lessonRecord,
    });
    findings.push(...problems.map(fromTextProblem));
  } else {
    findings.push(finding("student_unknown", "info", "The student's name is unknown: identity checks were skipped", null));
  }

  if (target.guided) findings.push(finding("guided_post", "info", "Written with a style/format guide or Atom evidence", null));
  if (target.firstShotPostId === null) {
    findings.push(finding("no_first_shot_row", "info", "No first-shot post row recorded yet: audited, but a correction would be refused", null));
  }
  if (target.humanSavedSincePost) findings.push(finding("human_save_since_post", "info", "A person (or an unmatched API save) saved this class's feedback after our post", null));
  if (target.ownerFlagOpen) findings.push(finding("owner_flag_open", "info", "The owner has an open flag on this class", null));
  if (target.verdict) findings.push(finding(`owner_verdict_${target.verdict}`, "info", `The owner's current verdict: ${target.verdict}`, null));
  findings.push(finding(`evidence_grade_${bundle.grade}`, "info", `Evidence grade: ${bundle.grade}`, null));
  if (input.raw) {
    for (const note of evidenceNotes(input.raw, bundle)) findings.push(finding(`note:${note.split(":")[0]}`, "info", note, null));
  }
  return findings;
}

/**
 * Display names of the tutor's other students (both accounts) from the autowriter's recent rows (SELECT only), for
 * the "another student named" candidate. The class itself is left out.
 */
export async function loadOtherStudentNames(db: Database, input: {
  tutorKey: string | null;
  excludeClassId: string | null;
  now: Date;
  days?: number;
}): Promise<string[]> {
  if (!input.tutorKey) return [];
  const accounts = rosterAccountIds(input.tutorKey);
  if (accounts.length === 0) return [];
  const since = new Date(input.now.getTime() - (input.days ?? 60) * 24 * 60 * 60 * 1000);
  const rows = await db.select({ wiseClassId: S.wiseClassId, metadata: S.metadata, mirror: PC.className })
    .from(S)
    .leftJoin(PC, eq(PC.wiseSessionId, S.wiseSessionId))
    .where(and(inArray(S.wiseTeacherUserId, accounts), gte(S.scheduledEndAt, since), lte(S.scheduledEndAt, input.now)));
  const names = new Set<string>();
  for (const row of rows) {
    if (input.excludeClassId && row.wiseClassId === input.excludeClassId) continue;
    const className = row.mirror?.trim() || (typeof row.metadata?.className === "string" ? row.metadata.className.trim() : "");
    // A student's Wise name ("First (Nick.Xx) Last"), not a course label with a year or level in it.
    if (!className || /\d/u.test(className)) continue;
    const display = chooseStudentDisplayName(className);
    if ([...display].length >= 2 && /^\p{Lu}[\p{L}\p{M}'-]*$/u.test(display)) names.add(display);
  }
  return [...names].sort();
}
