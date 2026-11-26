import { and, count, eq, exists, inArray, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { hiringCandidates as candidates, hiringDecisions as decisions } from "@/lib/db/schema";
import { DECIDED_STAGES } from "./model";
import { resumeAts, settings } from "./service";

type Ats = NonNullable<ReturnType<typeof resumeAts>>;

export function summarizeScores(scores: (Ats | null)[], threshold: number) {
  const scored = scores.filter((ats): ats is Ats => ats !== null);
  const sorted = scored.map((ats) => ats.score).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    total: scores.length,
    scored: n,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    atOrAbove: sorted.filter((score) => score >= threshold).length,
    parts: (scored[0]?.parts ?? []).map(({ name, max }, i) => ({
      name, max, mean: scored.reduce((sum, ats) => sum + ats.parts[i].earned, 0) / n,
    })),
    meanPenalty: n ? scored.reduce((sum, ats) => sum + ats.penalty, 0) / n : null,
    // All candidates use the same current rules. Compare the unrounded score with each boundary.
    bands: [0, 20, 40, 60, 80].map((low) => sorted.filter((score) => score >= low && (low === 80 || score < low + 20)).length),
  };
}

export async function atsOutcomes(db: Database) {
  const [{ config }, rows, [soft]] = await Promise.all([
    settings(db),
    db.select({
      stage: candidates.stage,
      profileAssessment: candidates.profileAssessment,
      universityAssessment: candidates.universityAssessment,
      workRightsAnswer: candidates.workRightsAnswer,
      confirmed: exists(db.select({ id: decisions.id }).from(decisions).where(and(
        eq(decisions.candidateId, candidates.id), eq(decisions.status, "sent"),
        or(and(eq(candidates.stage, "hired"), eq(decisions.decision, "hire")),
          and(eq(candidates.stage, "rejected"), eq(decisions.decision, "reject"))),
      ))),
    }).from(candidates).where(inArray(candidates.stage, [...DECIDED_STAGES])),
    db.select({ total: count() }).from(candidates).where(eq(candidates.stage, "soft_rejected")),
  ]);
  const cohort = (stage: "hired" | "rejected") => summarizeScores(
    rows.filter((row) => row.stage === stage && row.confirmed).map((row) => resumeAts(row, config)),
    config.profileThreshold,
  );
  return {
    accepted: cohort("hired"), rejected: cohort("rejected"),
    threshold: config.profileThreshold, softRejected: soft.total,
    stageOnly: rows.filter((row) => !row.confirmed).length,
  };
}
