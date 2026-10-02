import { AtomCollectionError } from "./normalize";

/** A temporary, read-only scheduled retrieval test. It never queues feedback. */
export function configuredAtomTrial(env: Record<string, string | undefined>, now = new Date()) {
  const studentId = env.FEEDBACK_ATOM_TRIAL_STUDENT_ID;
  const date = env.FEEDBACK_ATOM_TRIAL_DATE;
  const expires = env.FEEDBACK_ATOM_TRIAL_EXPIRES_AT;
  if (!studentId && !date && !expires) return null;
  const expiresAt = Date.parse(expires ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) return null;
  const day = Date.parse((date ?? "") + "T00:00:00+07:00");
  if (!studentId || !/^_[0-9]+$/u.test(studentId) || !date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)
    || !Number.isFinite(day) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
    || day > now.getTime() || now.getTime() - day > 30 * 86400_000
    || !Number.isFinite(expiresAt) || expiresAt - now.getTime() > 86400_000) {
    throw new AtomCollectionError("collection_failed", "trial_configuration");
  }
  return { studentId, date };
}
