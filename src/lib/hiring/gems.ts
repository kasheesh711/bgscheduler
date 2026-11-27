import { profileGate } from "./insights";
import type { CandidateStage } from "./funnel";
import type { Stage } from "./model";
import { highSchoolFraction } from "./scoring";

/**
 * Hidden gems (Kevin, 25 Nov 2026): candidates the gate or the queue would pass over, but who deserve a second look.
 * - `school`: strong university or tier-1 high school, total profile score under the pass score.
 * - `blocker`: score at or above the pass score, and exactly one gate reason holds them (work rights, subject, email…).
 * - `idle`: score at or above the pass score, still open, and 14 or more days in the same stage.
 * Only rows nobody is working on count for the first two: new, review, soft rejected, and stopped (marked `closed`).
 * Each person sits in one group only, first match in this order: blocker, idle, school.
 */
export type GemKind = "school" | "blocker" | "idle";
export type Gem = { id: string; name: string; subject: string | null; score: number; school: number; kind: GemKind; reason: string; closed: boolean };

/** University fraction (0–1) at or above which the school counts as strong. Tier 1 high school is 1. */
export const STRONG_SCHOOL = 0.75;
export const IDLE_DAYS = 14;
// Soft rejected (Kevin, 25 Nov 2026) stays a gem source: "strong school, under pass" is exactly who it holds.
const UNWORKED = new Set<Stage>(["new", "review", "stopped", "soft_rejected"]);
const CLOSED = new Set<Stage>(["stopped", "rejected", "hired", "no_reply", "no_booking", "soft_rejected"]);
// Reasons that are not one rule holding a strong profile.
const STAGE_WORD: Partial<Record<Stage, string>> = { new: "new", review: "review", pre_screen: "pre-screen", onsite_invited: "visit invite", onsite_booked: "visit booked" };
const NOT_A_BLOCKER = new Set(["Below profile threshold", "Not scored", "Waiting for a call"]);

type GemCandidate = Parameters<typeof profileGate>[0] & {
  id: string;
  name: string;
  stage: Stage;
  profileScore: number | null;
  subjects?: string[] | null;
};
type GemConfig = Parameters<typeof profileGate>[1];

/** The stronger of university and high school, 0 to 1. */
export function schoolStrength(c: Pick<GemCandidate, "universityAssessment" | "profileAssessment">, config: GemConfig) {
  return Math.max(c.universityAssessment?.fraction ?? 0, highSchoolFraction(c.profileAssessment, config));
}

export function buildGems(
  candidates: GemCandidate[],
  config: GemConfig,
  byCandidate: Record<string, CandidateStage>,
  /** People already moving: a visit or call ahead, or a place in a send queue. Never a gem. */
  busy: Set<string> = new Set(),
): Record<GemKind, Gem[]> {
  const out: Record<GemKind, Gem[]> = { school: [], blocker: [], idle: [] };
  const pass = config.profileThreshold;
  for (const c of candidates) {
    if (c.profileScore === null || busy.has(c.id)) continue;
    const score = c.profileScore;
    const school = schoolStrength(c, config);
    const base = { id: c.id, name: c.name, subject: c.subjects?.[0] ?? null, score, school, closed: c.stage === "stopped" };
    const gate = UNWORKED.has(c.stage) && score >= pass ? profileGate(c, config) : null;
    const timing = byCandidate[c.id];
    // A pending HR call is not a second rule: count only the reasons a person must resolve.
    const rules = gate?.short.filter((r) => !NOT_A_BLOCKER.has(r)) ?? [];
    if (gate && rules.length === 1 && !gate.short.includes("Below profile threshold"))
      out.blocker.push({ ...base, kind: "blocker", reason: rules[0] });
    else if (!CLOSED.has(c.stage) && score >= pass && timing && !timing.importDateOnly && timing.daysInStage >= IDLE_DAYS)
      out.idle.push({ ...base, kind: "idle", reason: `${Math.floor(timing.daysInStage)} d in ${STAGE_WORD[c.stage] ?? c.stage}` });
    else if (UNWORKED.has(c.stage) && score < pass && school >= STRONG_SCHOOL)
      out.school.push({ ...base, kind: "school", reason: `school ${Math.round(school * 100)}% · ${Math.round(score)} of ${pass}` });
  }
  // Closest to the pass score first: the cheapest second look.
  out.school.sort((a, b) => b.score - a.score || b.school - a.school);
  out.blocker.sort((a, b) => b.score - a.score);
  // Active first in every group; stopped ones need a decision to reopen.
  const days = (g: Gem) => byCandidate[g.id]?.daysInStage ?? 0;
  out.idle.sort((a, b) => days(b) - days(a) || b.score - a.score);
  for (const kind of Object.keys(out) as GemKind[]) out[kind].sort((a, b) => Number(a.closed) - Number(b.closed));
  return out;
}
