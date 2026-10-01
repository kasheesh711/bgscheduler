import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { StyleGuideStamp } from "./style";
import { AUTOWRITER_TUTORS } from "./roster";

export interface FeedbackFormatGuide extends StyleGuideStamp { instructions: string }
export const ISEB_FORMAT_GUIDE: FeedbackFormatGuide = Object.freeze({
  id: "iseb", version: 1,
  instructions: [
    "Shared ISEB format guide v1. Applies to all four fields.",
    "topics: short numbered topic labels, one per line, starting 1. Do not explain the lesson or repeat the performance paragraph. Material labels need current lesson or matched Atom evidence.",
    "Make topics noun phrases, such as Rotations and reflections. Put explanations of what we did, worked examples and solution steps in performance or improvement instead.",
    "performance: one or two warm paragraphs about strengths, difficulties and guidance. Include supported statistics with activity names. Do not repeat the topic inventory.",
    "improvement: numbered concrete practice actions, one per line. Keep useful coaching such as choosing answers independently, using precise terminology, and interpreting graphs when supported. Do not reduce coaching to vague skill labels or force a strategy count.",
    "homework: numbered tasks explicitly assigned by the tutor during this lesson; otherwise the empty string. An Atom assignment alone is not proof.",
    "Encouragement, advice to practise, unfinished work and suggested next steps are not homework assignments. Leave homework empty unless the lesson record contains an unambiguous assignment.",
    "Use consecutive 1., 2., 3. numbering separately in each list. No list sub-items, headings or Markdown formatting.",
    "No per-field minimum and no forced count. Keep the existing 300-character combined minimum for topics, performance and improvement; never pad sparse evidence.",
    "Historical examples show voice only. Never copy their facts into a new lesson.",
  ].join("\n"),
});

export function isIsebClass(canonicalTutorKey: string | undefined, classDetails: readonly string[]): boolean {
  return AUTOWRITER_TUTORS.some(tutor => tutor.canonicalKey === canonicalTutorKey) &&
    /\b(?:11|13)\s*\+|\bISEB\b/iu.test(classDetails.join(" "));
}
export function activeFormatGuide(canonicalTutorKey: string | undefined, classDetails: readonly string[],
  env: Record<string, string | undefined> = process.env): FeedbackFormatGuide | null {
  return env.FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED === "true" && isIsebClass(canonicalTutorKey, classDetails) ? ISEB_FORMAT_GUIDE : null;
}
export function matchingFormatStamp(stored: unknown, expected: FeedbackFormatGuide | null): boolean {
  if (!expected) return stored == null;
  return !!stored && typeof stored === "object" && "id" in stored && "version" in stored &&
    stored.id === expected.id && stored.version === expected.version;
}
export function validateIsebFormat(fields: FeedbackFieldAnswers): string[] {
  const errors: string[] = [];
  for (const field of ["topics", "improvement", "homework"] as const) {
    if (field === "homework" && !fields[field].trim()) continue;
    const lines = fields[field].trim().split("\n");
    if (!lines.length || lines.some((line, index) => !line.startsWith(`${index + 1}. `) || !line.slice(line.indexOf(". ") + 2).trim())) {
      errors.push(`style:numbering:${field}`);
    }
  }
  if (fields.performance.trim().split(/\n\s*\n/u).length > 2 || /(?:^|\n)\s*(?:\d+\.|[-*•])\s/u.test(fields.performance)) {
    errors.push("style:performance_prose");
  }
  const inventory = fields.topics.replace(/^\d+\.\s*/gmu, "").trim().toLowerCase();
  if (inventory.length > 35 && fields.performance.toLowerCase().includes(inventory)) errors.push("style:topic_inventory_repeated");
  return errors;
}
