import { createHash } from "node:crypto";
import type { ModelArm } from "./types";

export const AB_SEED = "feedback-autowriter-pilot-2026-09-29";

/**
 * Deterministic half/half split: sort by (class, start) and alternate from a
 * seeded first arm, so consecutive lessons of one student land on different
 * models and the overall split differs by at most one.
 */
export function assignModelArms(
  sessions: ReadonlyArray<{ sessionId: string; classId: string; scheduledStartAt: Date }>,
  seed = AB_SEED,
): Map<string, ModelArm> {
  const firstIsGlm = createHash("sha256").update(seed).digest()[0] % 2 === 0;
  const ordered = [...sessions].toSorted((left, right) =>
    left.classId.localeCompare(right.classId) ||
    left.scheduledStartAt.getTime() - right.scheduledStartAt.getTime() ||
    left.sessionId.localeCompare(right.sessionId));
  return new Map(ordered.map((session, index) => {
    const glm = (index % 2 === 0) === firstIsGlm;
    return [session.sessionId, glm ? "glm" : "luna"] as const;
  }));
}
