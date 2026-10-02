import { sqlStateOf } from "@/lib/db/sql-state";

/** A request Tutor Offboarding refuses on purpose; the message is safe to show. */
export class TutorOffboardingError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 422) {
    super(message);
    this.name = "TutorOffboardingError";
  }
}

/** 42P01 (table) or 42703 (column) missing: migration A is not applied yet. */
export function isMissingSchemaError(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === "42P01" || state === "42703";
}
