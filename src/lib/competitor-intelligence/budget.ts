import type { CompetitorSourceType } from "./types";

export interface BudgetState {
  provider: string;
  sourceType: CompetitorSourceType;
  usageMonth: string;
  hardCapUsd: number;
  estimatedCostUsd: number;
}

export function monthStartIso(date = new Date()): string {
  const value = new Date(date);
  value.setUTCDate(1);
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString().slice(0, 10);
}

export function providerHardCapUsd(provider: string, sourceType: CompetitorSourceType): number {
  const scoped = process.env[`COMPETITOR_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MONTHLY_CAP_USD`];
  const global = process.env.COMPETITOR_INTEL_MONTHLY_CAP_USD;
  const parsed = Number(scoped ?? global);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  if (sourceType === "website" || sourceType === "manual") return 0;
  return 250;
}

export function wouldExceedBudget(state: BudgetState, nextEstimatedCostUsd: number): boolean {
  if (state.hardCapUsd <= 0) return false;
  return state.estimatedCostUsd + Math.max(0, nextEstimatedCostUsd) > state.hardCapUsd;
}

export function budgetUsageRatio(state: Pick<BudgetState, "hardCapUsd" | "estimatedCostUsd">): number {
  if (state.hardCapUsd <= 0) return 0;
  return Math.min(1, Math.max(0, state.estimatedCostUsd / state.hardCapUsd));
}
