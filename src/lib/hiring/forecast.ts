import { FUNNEL_STEPS, type FunnelStep, type GroupFunnel } from "./funnel";
import type { Stage } from "./model";

/**
 * Hiring forecast (Kevin, 25 Nov 2026): expected offers per subject from the people in the pipeline today.
 * Each open candidate counts as the chance to reach Offer from their current step: the product of the measured
 * step-to-step shares after it, over the same people (`atLeast`), so a chance is never above 1. Open people still in a
 * step count as not passed, so the chance is low while the campaign is young (a lower bound). Compared with the Capacity tab's
 * "hire now" number, it shows which subjects the pipeline will cover and which will run dry.
 * shortcut: one conversion rate for all subjects (per-subject samples are a handful of people); upgrade when each
 * subject has 20+ visits.
 */
const STEP_OF: Partial<Record<Stage, FunnelStep>> = {
  new: "applied",
  review: "applied",
  pre_screen: "contacted",
  onsite_invited: "onsite_invited",
  onsite_booked: "visit_booked",
  paper_invited: "onsite_invited",
  paper_booked: "visit_booked",
  paper_passed: "visited",
  mock_booked: "visited",
};

export type ForecastRow = {
  subject: string;
  /** Open candidates whose subject this is. */
  pipeline: number;
  /** Expected offers, the sum of each person's chance. */
  expected: number;
  /** 10th and 90th percentile of the number of offers (whole people), from the exact sum of the chances. */
  low: number;
  high: number;
  /** Ids of the open candidates counted here, for the drill-down. */
  ids: string[];
  /** Chance of at least `need` offers, 0–1. Null without a need. */
  chance: number | null;
  /** People to hire now, from Capacity. Null when Capacity has not loaded or does not list the subject. */
  need: number | null;
};

export function buildForecast(
  candidates: { id: string; stage: Stage; visitSubject?: string | null; subjects?: string[] | null }[],
  funnel: Pick<GroupFunnel, "atLeast">,
  /** Capacity's hire-now numbers; a subject with status "unknown" must be left out (no measure, not zero). */
  needs: { subject: string; hire: number }[] | null,
): ForecastRow[] {
  const steps = FUNNEL_STEPS.map(([key]) => key);
  // chance[i]: from step i to Offer.
  const chance: number[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const before = funnel.atLeast[steps[i]];
    chance[i] = i === steps.length - 1 ? 1 : (before ? funnel.atLeast[steps[i + 1]] / before : 0) * chance[i + 1];
  }
  const rows = new Map<string, ForecastRow>();
  const row = (subject: string) => {
    let r = rows.get(subject);
    if (!r) rows.set(subject, (r = { subject, pipeline: 0, expected: 0, low: 0, high: 0, ids: [], need: null, chance: null }));
    return r;
  };
  // dist.get(subject)[k] = chance of exactly k offers (Poisson binomial, built one person at a time).
  const dist = new Map<string, number[]>();
  for (const c of candidates) {
    const step = STEP_OF[c.stage];
    const subject = c.visitSubject ?? c.subjects?.[0];
    if (!step || !subject) continue;
    const i = steps.indexOf(step);
    const r = row(subject);
    r.pipeline++;
    r.ids.push(c.id);
    r.expected += chance[i];
    const p = chance[i];
    const d = dist.get(subject) ?? [1];
    dist.set(subject, [...d.map((v, k) => v * (1 - p) + (k ? d[k - 1] * p : 0)), d[d.length - 1] * p]);
  }
  for (const n of needs ?? []) row(n.subject).need = n.hire;
  for (const r of rows.values()) {
    const d = dist.get(r.subject) ?? [1];
    const quantile = (q: number) => {
      let sum = 0;
      for (let k = 0; k < d.length; k++) if ((sum += d[k]) >= q - 1e-9) return k;
      return d.length - 1;
    };
    r.low = quantile(0.1);
    r.high = quantile(0.9);
    if (r.need) r.chance = d.slice(r.need).reduce((a, b) => a + b, 0);
  }
  // Subjects with a need first, the lowest chance first; then the rest by expected offers.
  return [...rows.values()]
    .filter((r) => r.pipeline || r.need)
    .sort((a, b) => Number(!a.need) - Number(!b.need) || (a.chance ?? 0) - (b.chance ?? 0) || b.expected - a.expected);
}
