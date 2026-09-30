import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import mimiExamples from "./style-examples/mimi-v1.json";

export interface StyleGuideStamp { id: string; version: number }
export interface FeedbackStyleGuide extends StyleGuideStamp {
  canonicalTutorKey: string;
  examples: readonly { fields: FeedbackFieldAnswers }[];
}

/** Frozen pre-autowriter examples; never learned from generated posts. */
export const MIMI_STYLE_GUIDE: FeedbackStyleGuide = {
  id: "mimi", version: 1, canonicalTutorKey: "Mimi", examples: mimiExamples.examples,
};

/** Disabled until the owner approves the ten-draft comparison. Both accounts resolve via the canonical key. */
export function activeStyleGuide(
  canonicalTutorKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
): FeedbackStyleGuide | null {
  return canonicalTutorKey === "Mimi" && env.FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED === "true" ? MIMI_STYLE_GUIDE : null;
}

export function styleGuideStamp(guide: FeedbackStyleGuide | null): StyleGuideStamp | null {
  return guide ? { id: guide.id, version: guide.version } : null;
}

/** Legacy drafts have no guide; disabling a guide invalidates its stored drafts too. */
export function matchingStoredStyle(stored: unknown, expected: FeedbackStyleGuide | null): boolean {
  if (!expected) return stored === null || stored === undefined;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const stamp = stored as Record<string, unknown>;
  return stamp.id === expected.id && stamp.version === expected.version;
}

export function styleInstructions(guide: FeedbackStyleGuide): string {
  return [
    `Writing guide ${guide.id} v${guide.version} (presentation only; the lesson record is the only evidence):`,
    "topics: concise numbered items, one item per line, numbered 1., 2., 3. in order. Use brief topic labels rather than explanations of every concept discussed. A short material label, Atom learning or Worksheets, may precede a list only when that material is named in THIS lesson record; restart numbering at 1 after a label.",
    "performance: warm, clear, specific prose, usually one or two paragraphs (at most three). Describe strengths, difficulties and guidance only as supported by this lesson. Use I or we naturally, without generic praise or a forced closing sentence.",
    "improvement: a short numbered list of skills to practise, one item per line. Prefer brief skill labels of roughly 2–8 words per item, as in Mimi's examples; put fuller explanations and guidance in performance instead. One supported item is enough. Do not force two or three strategies, repeat homework or add detail merely to fill space.",
    "homework: a short numbered list, one assigned task per line; empty when the tutor did not clearly assign homework. Never add a task or date from an example.",
    "Use plain text: no Markdown headings, emphasis, bullet symbols or section headings inside fields. A short indented hyphen sub-item is allowed only below a numbered topic or improvement item.",
    "Topics, improvement and homework can be very short; there is no per-field minimum. Performance is usually the fuller explanation. Keep the existing 300-character combined minimum, but never invent or pad facts to reach it. If the lesson evidence is sparse, write only what it supports and let validation hold the draft.",
    "The following anonymised historical examples demonstrate layout and voice ONLY. They are not this lesson: never borrow their topics, scores, materials, homework, observations or dates. Any historical claim in a draft still needs independent support in the current lesson record.",
    ...guide.examples.map((example, index) => `Historical presentation example ${index + 1}:\n${JSON.stringify(example.fields)}`),
  ].join("\n");
}

const MATERIAL_LABEL = /^(Atom learning|Worksheets):?$/iu;
const INLINE_MATERIAL_LABEL = /^\d+\.\s+(Atom learning|Worksheets)\s*[:–-]/iu;
function materialSupported(label: string, record: string): boolean {
  return /^worksheets$/iu.test(label) ? /\bworksheets?\b/iu.test(record) : /\batom\s+learning\b/iu.test(record);
}
const NUMBERED = /^(\d+)\.\s+\S/u;
const SUB_ITEM = /^\s*-\s+\S/u;
const PROHIBITED_FORMAT = /```|`[^`\n]+`|\*\*|(?<![\p{L}\p{N}_*])([*_])(?=\S)[^\n]*?\S\1(?![\p{L}\p{N}_*])|(?:^|\n)\s*(?:#{1,6}\s|>\s)|[•●▪◦]|\[[^\]\n]+\]\([^\n)]+\)/u;

/** Structure is checked locally; voice is reviewed by the owner, facts by the two existing judges. */
export function validateStyleFormat(
  fields: FeedbackFieldAnswers, lessonRecord: string,
): string[] {
  const reasons: string[] = [];
  for (const field of ["topics", "performance", "improvement", "homework"] as const) {
    if (PROHIBITED_FORMAT.test(fields[field])) reasons.push(`style:prohibited_format:${field}`);
  }
  for (const field of ["topics", "improvement", "homework"] as const) {
    if (field === "homework" && !fields[field].trim()) continue;
    let expected = 1;
    let items = 0;
    let afterLabel = false;
    for (const raw of fields[field].split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const label = field === "topics" ? MATERIAL_LABEL.exec(line) : null;
      if (label) {
        if (afterLabel) reasons.push(`style:empty_material_group:${field}`);
        if (!materialSupported(label[1], lessonRecord)) {
          reasons.push(`style:unsupported_material_label:${field}`);
        }
        expected = 1;
        afterLabel = true;
        continue;
      }
      const item = NUMBERED.exec(line);
      if (item) {
        const inlineLabel = field === "topics" ? INLINE_MATERIAL_LABEL.exec(line) : null;
        if (inlineLabel && !materialSupported(inlineLabel[1], lessonRecord)) reasons.push(`style:unsupported_material_label:${field}`);
        if (item[1] !== String(expected)) reasons.push(`style:numbering:${field}`);
        expected += 1;
        items += 1;
        afterLabel = false;
      } else if (field !== "homework" && items > 0 && !afterLabel && SUB_ITEM.test(raw)) {
        // Plain-text sub-items seen in Mimi's historical comments.
      } else {
        reasons.push(`style:list_structure:${field}`);
      }
    }
    if (!items) reasons.push(`style:missing_list:${field}`);
    if (afterLabel) reasons.push(`style:empty_material_group:${field}`);
  }
  const performance = fields.performance.trim();
  if (!performance || performance.split(/\n\s*\n/u).length > 3 ||
    /(?:^|\n)\s*(?:\d+[.)]\s|[-*•]\s|#{1,6}\s|(?:Topics|Performance|Improvement|Homework|Strengths|Weaknesses|Next steps)\s*:)/iu.test(performance)) {
    reasons.push("style:performance_prose");
  }
  return [...new Set(reasons)];
}
