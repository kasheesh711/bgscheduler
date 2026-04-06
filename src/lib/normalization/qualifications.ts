import { WiseTag } from "@/lib/wise/types";

export interface NormalizedQualification {
  subject: string;
  curriculum: string;
  level: string;
  examPrep?: string;
  sourceTag: string;
}

export interface QualificationIssue {
  type: "tag";
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
}

/**
 * Known tag parsing patterns from Wise.
 *
 * Examples:
 *  "Math (Int.) Y2-8" → { subject: "Math", curriculum: "International", level: "Y2-8" }
 *  "Math (Thai) Y2-8" → { subject: "Math", curriculum: "Thai", level: "Y2-8" }
 *  "Math (ExamPrep) SAT" → { subject: "Math", curriculum: "ExamPrep", level: "SAT", examPrep: "SAT" }
 *  "EFL (Int.) Y2-8" → { subject: "EFL", curriculum: "International", level: "Y2-8" }
 *  "Science (Int.) Y2-8" → { subject: "Science", curriculum: "International", level: "Y2-8" }
 */

// Pattern: Subject (Curriculum) Level
const TAG_PATTERN = /^(.+?)\s*\(([^)]+)\)\s*(.+)$/;

const CURRICULUM_MAP: Record<string, string> = {
  "int.": "International",
  "int": "International",
  "international": "International",
  "thai": "Thai",
  "examprep": "ExamPrep",
  "exam prep": "ExamPrep",
};

export function normalizeTag(tag: WiseTag): NormalizedQualification | null {
  const match = tag.name.match(TAG_PATTERN);
  if (!match) return null;

  const [, rawSubject, rawCurriculum, rawLevel] = match;
  const subject = rawSubject.trim();
  const curriculumKey = rawCurriculum.trim().toLowerCase();
  const curriculum = CURRICULUM_MAP[curriculumKey] ?? rawCurriculum.trim();
  const level = rawLevel.trim();

  const result: NormalizedQualification = {
    subject,
    curriculum,
    level,
    sourceTag: tag.name,
  };

  if (curriculum === "ExamPrep") {
    result.examPrep = level;
  }

  return result;
}

/**
 * Normalize all tags for a teacher, collecting issues for unmapped tags.
 */
export function normalizeTeacherTags(
  tags: WiseTag[],
  wiseTeacherId: string,
  wiseTeacherName: string
): {
  qualifications: NormalizedQualification[];
  issues: QualificationIssue[];
} {
  const qualifications: NormalizedQualification[] = [];
  const issues: QualificationIssue[] = [];

  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      qualifications.push(normalized);
    } else {
      issues.push({
        type: "tag",
        entityType: "teacher",
        entityId: wiseTeacherId,
        entityName: wiseTeacherName,
        message: `Unmapped Wise tag: "${tag.name}"`,
      });
    }
  }

  return { qualifications, issues };
}
