/** Wise web app origin for the BeGifted tenant (white-labelled Wise). */
export const WISE_LEARN_ORIGIN = "https://learn.begiftededucation.com";

/**
 * Deep link that opens one Wise session in the web app. Wise resolves the
 * `/links` entry point to the class/session page for the signed-in user.
 */
export function wiseSessionLink(input: { wiseClassId: string; wiseSessionId: string }): string {
  const params = new URLSearchParams({
    type: "classroom_entity",
    entityType: "session",
    entityId: input.wiseSessionId,
    classId: input.wiseClassId,
    profile: "teacher",
  });
  return `${WISE_LEARN_ORIGIN}/links?${params.toString()}`;
}
