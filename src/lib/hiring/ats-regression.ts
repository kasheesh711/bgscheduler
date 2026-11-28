import type { atsOutcomes } from "./ats-outcomes";

export type Outcome = "paper" | "mock" | "decision";
export type Report = Awaited<ReturnType<typeof atsOutcomes>>;
export type Observation = { id: string; name: string; x: number; y: number; factors: number[]; positive: boolean | null; subjects: string[] };
const mean = (xs: number[]) => xs.reduce((sum, v) => sum + v, 0) / xs.length;

export function observations(report: Report, outcome: Outcome) {
  const points: Observation[] = [];
  let noOutcome = 0, noScore = 0;
  for (const c of report.cases) {
    const records = outcome === "paper" ? c.results.flatMap(r => r.verdict && r.percent !== null ? [{ subject: r.subject, percent: r.percent }] : [])
      : outcome === "mock" ? c.mock : [];
    const y = outcome === "decision" ? c.decision && (c.decision === "Accepted" ? 100 : 0)
      : records.length ? mean(records.map(r => r.percent)) : null;
    if (y === null) { noOutcome++; continue; }
    if (!c.ats || !c.fractions) { noScore++; continue; }
    points.push({ id: c.id, name: c.name, x: c.ats.score, y, factors: [...c.fractions, c.ats.penalty],
      subjects: records.map(r => r.subject), positive: outcome === "decision" ? c.decision === "Accepted"
        : outcome === "paper" && c.paper ? c.paper === "pass" : null });
  }
  return { points, noOutcome, noScore };
}

export function linearFit(points: Pick<Observation, "x" | "y">[]) {
  if (points.length < 3) return null;
  const x = mean(points.map(p => p.x)), y = mean(points.map(p => p.y));
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) {
    xx += (p.x - x) ** 2; yy += (p.y - y) ** 2; xy += (p.x - x) * (p.y - y);
  }
  if (xx < 1e-10) return null;
  const slope = xy / xx;
  // Deleting a row from a centered cross-product updates it without refitting every point.
  const scale = points.length / (points.length - 1);
  const omitted = points.flatMap(p => {
    const variance = xx - scale * (p.x - x) ** 2;
    return variance > 1e-10 ? [(xy - scale * (p.x - x) * (p.y - y)) / variance] : [];
  });
  return { slope, intercept: y - slope * x, r2: yy < 1e-10 ? null : Math.min(1, xy ** 2 / (xx * yy)),
    low: omitted.length ? Math.min(...omitted) : null, high: omitted.length ? Math.max(...omitted) : null, folds: omitted.length };
}

// Standardized ridge, with an unpenalized intercept and a fixed penalty of one.
// The diagonal penalty makes the system positive definite even for duplicate predictors.
function ridge(points: Observation[]) {
  const k = points[0].factors.length;
  const centers = Array.from({ length: k }, (_, j) => mean(points.map(p => p.factors[j])));
  const sd = centers.map((m, j) => Math.sqrt(mean(points.map(p => (p.factors[j] - m) ** 2))));
  const yMean = mean(points.map(p => p.y));
  const matrix = Array.from({ length: k }, (_, j) => Array.from({ length: k + 1 }, (_, l) => j === l ? 1 : 0));
  const standardize = (values: number[]) => values.map((v, j) => sd[j] > 1e-10 ? (v - centers[j]) / sd[j] : 0);
  for (const p of points) {
    const z = standardize(p.factors);
    for (let j = 0; j < k; j++) {
      matrix[j][k] += z[j] * (p.y - yMean);
      for (let l = 0; l < k; l++) matrix[j][l] += z[j] * z[l];
    }
  }
  for (let j = 0; j < k; j++) {
    const pivot = matrix[j][j];
    for (let l = j; l <= k; l++) matrix[j][l] /= pivot;
    for (let i = 0; i < k; i++) {
      if (i === j) continue;
      const multiplier = matrix[i][j];
      for (let l = j; l <= k; l++) matrix[i][l] -= multiplier * matrix[j][l];
    }
  }
  const coefficients = matrix.map(row => row[k]);
  return { coefficients, sd, yMean, predict: (p: Observation) =>
    standardize(p.factors).reduce((y, z, j) => y + z * coefficients[j], yMean) };
}

export function factorFit(points: Observation[]) {
  if (points.length < 3) return null;
  const full = ridge(points);
  const folds = points.map((p, i) => {
    const fit = ridge(points.filter((_, j) => i !== j));
    return { error: Math.abs(fit.predict(p) - p.y), baseline: Math.abs(fit.yMean - p.y), fit };
  });
  return { factors: full.coefficients.map((value, j) => {
    const estimates = folds.flatMap(({ fit }) => fit.sd[j] > 1e-10 ? [fit.coefficients[j]] : []);
    return { value: full.sd[j] > 1e-10 ? value : null, low: estimates.length ? Math.min(...estimates) : null,
      high: estimates.length ? Math.max(...estimates) : null, folds: estimates.length };
  }), mae: mean(folds.map(f => f.error)), baseline: mean(folds.map(f => f.baseline)) };
}
