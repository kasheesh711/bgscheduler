/**
 * Failure modes the nightly audit sorts autowriter posts into (quick 261003-12b). The auditor's rubric
 * (`audit-prompt.ts`) and the committed registry (`docs/operations/feedback-autowriter-failure-modes.md`) are written
 * from this list, so the three never drift.
 *
 * Severities follow the owner's 29 Sep definitions: critical = wrong person, billing/status, invented content,
 * should not have posted; major = a real fix; cosmetic = wording only (still first-shot accurate). Two owner verdicts
 * of 30 Sep fix the line between them: P1 (another student's unfinished exam credited to ours) is critical,
 * wrong_person; P2 (homework claimed from a summary's mis-heard exchange, right student) is major.
 *
 * Examples are synthetic: no real student, tutor or lesson appears here (the repository is public).
 */

export type FailureSeverity = "critical" | "major" | "cosmetic";

export type CriticalCategory = "wrong_person" | "billing_status" | "invented_content" | "should_not_have_posted";

export const FAILURE_MODE_IDS = [
  "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09",
  "M10", "M11", "M12", "M13", "M14", "M15", "M16", "M17",
] as const;

export type FailureModeId = (typeof FAILURE_MODE_IDS)[number];

/** Where in the pipeline a failure starts. */
export const ROOT_STAGES = ["evidence", "redaction", "writer", "judge", "validator", "gate", "style", "renderer"] as const;

export type RootStage = (typeof ROOT_STAGES)[number];

export interface FailureMode {
  id: FailureModeId;
  slug: string;
  title: string;
  /** What counts, written for the auditor. */
  definition: string;
  defaultSeverity: FailureSeverity;
  /** Set when the default severity is critical. */
  criticalCategory?: CriticalCategory;
  /** Whether a text correction can fix it. Billing and scope failures need a person, never an edit. */
  textFixable: boolean;
  /** Whether the nightly audit judges it from a posted text (false: found from holds or call logs instead). */
  auditedFromPost: boolean;
  /** Owner precedent, when one fixed the severity. */
  precedent?: "P1" | "P2";
  /** A synthetic example (invented names and lesson). */
  example: string;
}

export const FAILURE_MODES: readonly FailureMode[] = [
  {
    id: "M01",
    slug: "wrong_person",
    title: "Another person's work credited to the student",
    definition: "The feedback gives the student something another person did, said, finished, got wrong or did not finish: " +
      "another student, a family member, a friend, a person or character in the lesson material, or the tutor.",
    defaultSeverity: "critical",
    criticalCategory: "wrong_person",
    textFixable: true,
    auditedFromPost: true,
    precedent: "P1",
    example: "The summary says another student, named there, only managed eight pages of a mock paper; the feedback says " +
      "Pim did not finish the paper. In the lesson Pim finished it.",
  },
  {
    id: "M02",
    slug: "wrong_student_or_lesson",
    title: "Another student named, or content from another lesson",
    definition: "The feedback names a student other than this one, or describes a lesson that is not this class's lesson.",
    defaultSeverity: "critical",
    criticalCategory: "wrong_person",
    textFixable: true,
    auditedFromPost: true,
    example: "Feedback for Nok's English lesson mentions Tawan by name and describes a maths lesson.",
  },
  {
    id: "M03",
    slug: "homework_not_set",
    title: "Homework the tutor did not set",
    definition: "The feedback states homework, a task or a due date that the tutor did not clearly set for the student to do " +
      "after this lesson: work only described as remaining or unfinished, an optional suggestion, the summary's own " +
      "\"Next steps\" line, or an invented due date. Critical only when it is part of a wrong-person error (M01).",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    precedent: "P2",
    example: "The tutor says \"we can finish the last three questions next time\"; the feedback says the homework is to " +
      "complete the last three questions by Friday.",
  },
  {
    id: "M04",
    slug: "invented_event",
    title: "Invented fact",
    definition: "A concrete score, result, test, material, activity, topic or date that has no basis anywhere in the evidence.",
    defaultSeverity: "critical",
    criticalCategory: "invented_content",
    textFixable: true,
    auditedFromPost: true,
    example: "The feedback says the student scored 18/20 on a vocabulary quiz; no quiz or score appears in the lesson.",
  },
  {
    id: "M05",
    slug: "misheard_detail",
    title: "Mis-heard or mis-summarised detail",
    definition: "A specific detail that comes from a real exchange in the lesson but is wrong: a wrong number, word, page, " +
      "question or text, usually from a mis-heard transcript or a summary's mistake.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "The class worked on exercise 4B; the feedback says exercise 14B.",
  },
  {
    id: "M06",
    slug: "overstated_judgement",
    title: "Unsupported judgement of how the student did",
    definition: "A judgement of the student's performance (confidently, quickly, mastered, excellent, struggled, engaged) " +
      "that the evidence does not state or clearly show, including padded praise.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "The feedback says the student \"confidently mastered\" fractions; the transcript only shows the tutor " +
      "explaining fractions and the student answering two questions, one of them wrongly.",
  },
  {
    id: "M07",
    slug: "tutor_work_as_student",
    title: "The tutor's work presented as the student's",
    definition: "Something the tutor explained, read, solved or summarised is presented as the student's own work or " +
      "understanding (covered written as understood), often because the speaker labels are swapped or inferred.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "The tutor works through a proof aloud; the feedback says the student explained the proof clearly.",
  },
  {
    id: "M08",
    slug: "wrong_subject_content",
    title: "Subject content described wrongly",
    definition: "A concept, topic, programme, exam or level described wrongly (a subject error, the wrong exam board or level), " +
      "while a real lesson topic is meant. With no basis at all, use M04 instead.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "The lesson covered longitudinal waves; the feedback says the student learned that sound is a transverse wave.",
  },
  {
    id: "M09",
    slug: "material_omission",
    title: "Main topic or set homework left out",
    definition: "The lesson's main topic is missing from the feedback, or homework the tutor clearly set is left out.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "Most of the lesson was essay planning; the feedback only mentions a five-minute vocabulary warm-up. Or: the " +
      "tutor clearly set two practice pages for Monday and the homework field is empty.",
  },
  {
    id: "M10",
    slug: "generic_padding",
    title: "Generic filler",
    definition: "Advice or sentences not tied to this lesson, or text close to earlier feedback. If it states how the " +
      "student performed, it is M06 instead.",
    defaultSeverity: "cosmetic",
    textFixable: true,
    auditedFromPost: true,
    example: "\"Keep practising regularly and stay motivated to achieve your goals.\" with nothing from the lesson.",
  },
  {
    id: "M11",
    slug: "naming_policy",
    title: "Naming rule broken",
    definition: "The right student, but called by the wrong form of name (not the nickname the school uses), or anyone " +
      "else is named, including the tutor.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "The student's nickname is Pim but the feedback uses the full first name; or it names the tutor.",
  },
  {
    id: "M12",
    slug: "meta_or_format_leak",
    title: "Meta words, attendance or format leak",
    definition: "Mentions Zoom, recordings, transcripts, AI, a summary, attendance, lateness, absence, technical problems, " +
      "rescheduling or cancellation; or contains Thai text, a placeholder like [STUDENT_1], or markdown.",
    defaultSeverity: "major",
    textFixable: true,
    auditedFromPost: true,
    example: "\"According to the lesson summary, [STUDENT_1] joined late because of a connection problem.\"",
  },
  {
    id: "M13",
    slug: "billing_status_drift",
    title: "Session status or credits wrong",
    definition: "The session status or credits in Wise differ from what the autowriter planned, or the class has an extra " +
      "credit entry. Never fixed by editing text.",
    defaultSeverity: "critical",
    criticalCategory: "billing_status",
    textFixable: false,
    auditedFromPost: true,
    example: "The plan reused one credit, but Wise now shows two credit entries for the session.",
  },
  {
    id: "M14",
    slug: "should_not_have_posted",
    title: "Should not have posted",
    definition: "The class should not have had autowriter feedback: the student was absent or attended under half the " +
      "lesson, it was not one-to-one, it was in person, no real lesson took place, a person's own text was overwritten, " +
      "or the tutor was switched off. Never fixed by editing text.",
    defaultSeverity: "critical",
    criticalCategory: "should_not_have_posted",
    textFixable: false,
    auditedFromPost: true,
    example: "The recording shows only the tutor waiting for 50 minutes; the feedback describes a full lesson.",
  },
  {
    id: "M15",
    slug: "false_hold",
    title: "Accurate draft held",
    definition: "A judge or validator held a draft that was accurate, so a person had to write the feedback. Found when " +
      "reviewing holds, not from a posted text.",
    defaultSeverity: "cosmetic",
    textFixable: false,
    auditedFromPost: false,
    example: "Both judge levels flagged \"we practised reading aloud\" as unsupported although the transcript shows it.",
  },
  {
    id: "M16",
    slug: "cost_runaway",
    title: "Retry loop or abnormal spend",
    definition: "A class used abnormally many model calls or abnormal spend (a retry loop, repeated transcriptions). Found " +
      "from call logs, not from a posted text.",
    defaultSeverity: "major",
    textFixable: false,
    auditedFromPost: false,
    example: "One class has 14 writer runs and 30 judge calls in a day because a failing judge retried every 10 minutes.",
  },
  {
    id: "M17",
    slug: "wording",
    title: "Wording only",
    definition: "Grammar, spelling, awkward phrasing or a house-style slip that does not change any fact.",
    defaultSeverity: "cosmetic",
    textFixable: true,
    auditedFromPost: true,
    example: "\"She practised reading and writing well and also she practised.\"",
  },
];

const BY_ID = new Map<string, FailureMode>(FAILURE_MODES.map((mode) => [mode.id, mode]));

/** The failure mode with this id, or null. */
export function failureMode(id: string): FailureMode | null {
  return BY_ID.get(id) ?? null;
}

/** The failure modes the auditor may assign to a posted text (M15 and M16 come from other sources). */
export function postAuditModes(): readonly FailureMode[] {
  return FAILURE_MODES.filter((mode) => mode.auditedFromPost);
}

const SEVERITY_RANK: Record<FailureSeverity, number> = { cosmetic: 0, major: 1, critical: 2 };

/** The higher of two severities. */
export function maxSeverity(a: FailureSeverity, b: FailureSeverity): FailureSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Severity order for sorting and floors. */
export function severityRank(severity: FailureSeverity): number {
  return SEVERITY_RANK[severity];
}
