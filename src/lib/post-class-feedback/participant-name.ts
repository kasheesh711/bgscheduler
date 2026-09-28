import type { PostClassParticipant } from "./types";

/** Expand an abbreviated detail name only through the same stable Wise ID. */
export function resolvePostClassParticipantName(
  participant: PostClassParticipant,
  knownStudent?: { wiseStudentId: string; studentName: string },
): string {
  const detailName = participant.studentName?.trim() || null;
  const knownName = knownStudent?.wiseStudentId === participant.wiseStudentId
    ? knownStudent.studentName.trim() || null
    : null;
  if (!detailName) return knownName ?? participant.wiseStudentId;
  // A genuinely different name stays first-hand detail evidence. This only
  // fills in a missing nickname/surname, never matches people by a prefix.
  if (knownName?.startsWith(`${detailName} (`)) return knownName;
  return detailName;
}
