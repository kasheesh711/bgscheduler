import type { GrowthBookingKind, GrowthBookingMetadata } from "./types";

const CLASSIFICATIONS = new Map<string, GrowthBookingKind>([
  ["REGULAR", "regular"], ["REGULAR_CLASS", "regular"], ["REGULAR_LESSON", "regular"],
  ["TRIAL", "trial"], ["TRIAL_CLASS", "trial"], ["TRIAL_LESSON", "trial"],
  ["PRETEST", "pretest"], ["PRE_TEST", "pretest"],
]);
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Purpose is independent of price, class format and academic subject. */
export function normalizeGrowthBookingMetadata(raw: unknown, observedAt: string, hasReviewedAcademicSubject = false): GrowthBookingMetadata {
  const row = asRecord(raw), classroom = asRecord(row.classId), retained = asRecord(row.bookingClassificationSource);
  const id = row.wiseSessionId ?? row._id;
  if (typeof id !== "string" || !id.trim()) throw new Error("Missing growth session identity");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid growth observation time");
  const candidates = [
    ["purpose", row.purpose], ["classId.purpose", classroom.purpose],
    ["classType", row.classType], ["classId.classType", classroom.classType],
    ["bookingClassificationSource.purpose", retained.purpose],
    ["bookingClassificationSource.classType", retained.classType],
  ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim().length > 0);
  const unknownPurpose = candidates.some(([field, value]) => field.endsWith("purpose")
    && !CLASSIFICATIONS.has(value.trim().toUpperCase().replace(/[ -]+/g, "_")));
  const hasPurpose = candidates.some(([field]) => field.endsWith("purpose"));
  const matches = candidates.flatMap(([field, value]) => {
    const kind = CLASSIFICATIONS.get(value.trim().toUpperCase().replace(/[ -]+/g, "_"));
    return kind ? [{ field, value, kind }] : [];
  });
  const titleValue = row.classTitle ?? row.title ?? retained.title;
  const title = typeof titleValue === "string" ? titleValue : "";
  if (!hasPurpose && /\btrial\b/i.test(title)) matches.push({ field: "title", value: title, kind: "trial" });
  if (!hasPurpose && /\bpre[\s_-]*test\b/i.test(title)) matches.push({ field: "title", value: title, kind: "pretest" });
  if (!hasPurpose && !matches.length && hasReviewedAcademicSubject) matches.push({ field: "reviewed_academic_mapping", value: title, kind: "regular" });
  const kinds = new Set(matches.map(m => m.kind));
  const conflict = kinds.size > 1;
  const match = !unknownPurpose && !conflict && matches.length ? matches[0] : null;
  return {
    wiseSessionId: id, classification: match?.kind ?? "unknown",
    sourceField: match?.field ?? (candidates.length ? candidates.map(c => c[0]).join(" | ") : null),
    sourceValue: match?.value ?? (candidates.length ? candidates.map(c => c[1]).join(" | ") : null),
    observedAt: new Date(observedAt).toISOString(), completeness: match ? "complete" : "unknown",
    reasonCodes: match ? ["title", "reviewed_academic_mapping"].includes(match.field) ? ["OWNER_CONFIRMED_TITLE_CLASSIFICATION"] : [] : [unknownPurpose ? "UNRECOGNIZED_BOOKING_PURPOSE" : conflict ? "CONFLICTING_BOOKING_CLASSIFICATION" : "BOOKING_CLASSIFICATION_UNAVAILABLE"],
  };
}
