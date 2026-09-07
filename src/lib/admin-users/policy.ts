import type { AdminAccessEnvironment } from "./types";

/** Environment designation alone never grants access; callers also verify the admin row. */
export function isSuperAdminEmail(
  email: string | null | undefined,
  env: AdminAccessEnvironment = process.env,
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return (env.SUPER_ADMIN_EMAILS ?? "").split(",")
    .some((entry) => entry.trim().toLowerCase() === normalized);
}
