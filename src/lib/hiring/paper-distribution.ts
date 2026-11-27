/** All final papers in the subject are the population. Each paper has equal weight. */
export function paperDistribution(scores: readonly number[]) {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, score) => sum + score, 0) / n;
  const median = (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
  const sd = sorted[0] === sorted[n - 1] ? 0 :
    Math.sqrt(sorted.reduce((sum, score) => sum + (score - mean) ** 2, 0) / n);
  return { scores: sorted, mean, median, sd };
}
