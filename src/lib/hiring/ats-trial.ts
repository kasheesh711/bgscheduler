type Score = { score: number; penalty: number; parts: { name: string; max: number; earned: number }[] };

/** Reapply the deduction after the transfer. A stored total of zero may already have been floored. */
export function trialScore(ats: Score, from: string, to: string) {
  const donor = ats.parts.find(part => part.name === from);
  const recipient = ats.parts.find(part => part.name === to);
  if (from === to || !donor || donor.max < 5 || !recipient?.max) return ats.score;
  const total = ats.parts.reduce((sum, part) => sum + part.earned, 0);
  return Math.max(0, total - ats.penalty + 5 * (recipient.earned / recipient.max - donor.earned / donor.max));
}

export function summarizeScores(scores: (Score | null)[], threshold: number) {
  const scored = scores.filter((ats): ats is Score => ats !== null);
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
