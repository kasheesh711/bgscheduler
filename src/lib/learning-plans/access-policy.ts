export const LEARNING_PLANS_ROUTE = "/learning-plans";

export function hasLearningPlansAccess(
  allowedPages: string[] | null | undefined,
  role: string | null | undefined,
  hasGrant: boolean,
): boolean {
  const isAdmin = role === "admin" || role === null || role === undefined;

  // Preserve automatic access for full admins, including legacy sessions
  // issued before the role claim existed. Admin sessions that already carry
  // the exact historical page grant also remain valid during the migration.
  if (
    isAdmin &&
    (
      !allowedPages ||
      allowedPages.includes(LEARNING_PLANS_ROUTE)
    )
  ) {
    return true;
  }
  if (!hasGrant) return false;

  return isAdmin || role === "teacher";
}
