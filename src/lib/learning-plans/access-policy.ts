export const LEARNING_PLANS_ROUTE = "/learning-plans";

export function hasLearningPlansAccess(
  allowedPages: string[] | null | undefined,
  role: string | null | undefined,
): boolean {
  if (role && role !== "admin") return false;
  if (!allowedPages) return true;
  return allowedPages.includes(LEARNING_PLANS_ROUTE);
}
