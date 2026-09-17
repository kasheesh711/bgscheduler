/** Deliberately narrower than the website's configurable owner list. */
export const CLASSROOM_OPERATIONS_OWNER = "kevhsh7@gmail.com";

export function isClassroomOperationsOwner(email: string | null | undefined): boolean {
  return email?.trim().toLowerCase() === CLASSROOM_OPERATIONS_OWNER;
}

/** Missing or misspelled configuration keeps the emergency pause engaged. */
export function wiseClassroomAutomationEnabled(raw = process.env.WISE_CLASSROOM_AUTOMATION_ENABLED): boolean {
  return raw === "true";
}

export const WISE_CLASSROOM_JOBS = [
  "wise_snapshot", "classroom_morning", "classroom_publish_recovery",
  "classroom_admin_email", "classroom_weekend_check",
] as const;

export function isWiseClassroomJob(key: string): boolean {
  return WISE_CLASSROOM_JOBS.some(job => job === key);
}

/** These action APIs return JSON 401 even when no browser cookie is present. */
export function isClassroomOperationsApi(pathname: string): boolean {
  if (pathname === "/api/admin/sync-wise" || pathname === "/api/class-assignments/run") return true;
  if (/^\/api\/class-assignments\/runs\/[^/]+\/publish$/.test(pathname)) return true;
  const job = /^\/api\/data-health\/jobs\/([^/]+)\/run$/.exec(pathname)?.[1];
  return Boolean(job && isWiseClassroomJob(job));
}

export function pausedWiseClassroomResult() {
  return { ok: true, skipped: true, paused: true, reason: "AUTOMATION_PAUSED",
    message: "Wise and classroom automation is paused by the owner." } as const;
}

export const CLASSROOM_SHUTDOWN_REASON = "Stopped by owner: classroom operations are restricted to Kevin; automatic publishing is paused.";
