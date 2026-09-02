import {
  POST_CLASS_REQUIRED_FIELDS,
  type AiSuspectAssessment,
  type FeedbackFieldAnswers,
} from "./types";
import {
  POST_CLASS_MIN_COMBINED_CHARACTERS,
  POST_CLASS_SHORT_FIELD_CHARACTERS,
  assessFeedbackContent,
  countUnicodeCodePoints,
  isPlaceholderFeedback,
  normalizeFeedbackText,
} from "./policy";

export interface PriorFeedbackComparison {
  key: string;
  fields: Partial<FeedbackFieldAnswers>;
  studentNames?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(value: string): RegExp {
  const escaped = escapeRegExp(value);
  return /^[\p{Script=Latin}\s.'’-]+$/u.test(value)
    ? new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "giu")
    : new RegExp(escaped, "giu");
}

function knownNameVariants(value: string): string[] {
  const full = value.trim();
  if (!full) return [];
  const withoutParenthetical = full.replace(/\s*[([].*?[)\]]\s*/gu, " ").trim();
  const components = withoutParenthetical
    .split(/[\s,;/|_–—-]+/gu)
    .map((part) => part.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").trim())
    .filter((part) => [...part].length >= 2 && /\p{L}/u.test(part));
  return [...new Set([full, withoutParenthetical, ...components].filter(Boolean))]
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right));
}

export function redactKnownNames(
  value: string,
  input: { studentNames?: string[]; tutorNames?: string[] },
): string {
  let result = value;
  const studentNames = [...new Set(input.studentNames ?? [])]
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const tutorNames = [...new Set(input.tutorNames ?? [])]
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));

  const studentReplacements = studentNames.flatMap((name, index) =>
    knownNameVariants(name).map((variant) => ({ variant, replacement: `[STUDENT_${index + 1}]` })),
  ).toSorted((left, right) =>
    right.variant.length - left.variant.length || left.variant.localeCompare(right.variant),
  );
  for (const { variant, replacement } of studentReplacements) {
    result = result.replace(namePattern(variant), replacement);
  }
  const tutorVariants = [...new Set(tutorNames.flatMap(knownNameVariants))]
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right));
  for (const variant of tutorVariants) {
    result = result.replace(namePattern(variant), "[TUTOR]");
  }
  return result;
}

export function combinedRequiredFeedback(fields: Partial<FeedbackFieldAnswers>): string {
  return POST_CLASS_REQUIRED_FIELDS.map((field) => fields[field] ?? "").join("\n");
}

export function normalizeForSimilarity(
  fields: Partial<FeedbackFieldAnswers>,
  names: { studentNames?: string[]; tutorNames?: string[] } = {},
): string {
  return normalizeFeedbackText(redactKnownNames(combinedRequiredFeedback(fields), names));
}

function trigramCounts(value: string): Map<string, number> {
  const points = [...value];
  if (points.length === 0) return new Map();
  const grams = points.length < 3 ? [points.join("")] : points.slice(0, -2).map((_, index) =>
    points.slice(index, index + 3).join(""));
  const counts = new Map<string, number>();
  for (const gram of grams) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  return counts;
}

export function characterTrigramCosineSimilarity(left: string, right: string): number {
  const leftCounts = trigramCounts(left);
  const rightCounts = trigramCounts(right);
  if (leftCounts.size === 0 || rightCounts.size === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const count of leftCounts.values()) leftMagnitude += count * count;
  for (const count of rightCounts.values()) rightMagnitude += count * count;
  for (const [gram, count] of leftCounts) dot += count * (rightCounts.get(gram) ?? 0);
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function assessAiSuspect(
  fields: Partial<FeedbackFieldAnswers>,
  input: {
    studentNames?: string[];
    tutorNames?: string[];
    priorFeedback?: PriorFeedbackComparison[];
    similarityThreshold?: number;
  } = {},
): AiSuspectAssessment {
  const content = assessFeedbackContent(fields);
  const reasons = new Set<AiSuspectAssessment["reasons"][number]>();
  if (POST_CLASS_REQUIRED_FIELDS.some(
    (field) => countUnicodeCodePoints(fields[field] ?? "") < POST_CLASS_SHORT_FIELD_CHARACTERS,
  )) {
    reasons.add("short_required_field");
  }
  if (
    content.combinedRawCharacterCount >= POST_CLASS_MIN_COMBINED_CHARACTERS &&
    content.combinedRawCharacterCount <= 349
  ) {
    reasons.add("borderline_total_length");
  }
  if (POST_CLASS_REQUIRED_FIELDS.some((field) => isPlaceholderFeedback(fields[field] ?? ""))) {
    reasons.add("placeholder_pattern");
  }

  const current = normalizeForSimilarity(fields, input);
  let highestPriorSimilarity = 0;
  let matchingPriorKey: string | null = null;
  for (const prior of input.priorFeedback ?? []) {
    const normalizedPrior = normalizeForSimilarity(prior.fields, {
      studentNames: prior.studentNames,
      tutorNames: input.tutorNames,
    });
    const similarity = characterTrigramCosineSimilarity(current, normalizedPrior);
    if (similarity > highestPriorSimilarity) {
      highestPriorSimilarity = similarity;
      matchingPriorKey = prior.key;
    }
  }
  if (highestPriorSimilarity >= (input.similarityThreshold ?? 0.85)) {
    reasons.add("similar_prior_feedback");
  }

  return {
    suspect: reasons.size > 0,
    reasons: [...reasons],
    highestPriorSimilarity,
    matchingPriorKey,
  };
}
