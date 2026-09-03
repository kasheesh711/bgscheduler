import {
  FIFO_PACKAGE_MODEL,
  type UnearnedRevenueCanonicalModel,
  type UnearnedRevenueLotDetail,
  type UnearnedRevenuePeriodKind,
  type UnearnedRevenuePeriodSummary,
} from "./types";

export function unearnedRevenueModelPresentation(model: UnearnedRevenueCanonicalModel) {
  const fifoCanonical = model === FIFO_PACKAGE_MODEL;
  return {
    fifoCanonical,
    badgeLabel: fifoCanonical ? "FIFO canonical" : "FIFO shadow · legacy canonical",
  } as const;
}

export function unearnedRevenuePeriodSuffix(kind: UnearnedRevenuePeriodKind): string {
  return kind === "LATEST" ? "latest completed day" : "month-end";
}

export function completedMonthEndPeriods(
  periods: readonly UnearnedRevenuePeriodSummary[],
): UnearnedRevenuePeriodSummary[] {
  return periods.filter((period) => period.periodKind === "MONTH_END");
}

export function unearnedRevenueWaterfall(input: {
  opening: number;
  deferred: number;
  recognized: number;
  closing: number;
}): Array<[number, number]> {
  const afterDeferred = input.opening + input.deferred;
  return [
    [0, input.opening],
    [input.opening, afterDeferred],
    [input.closing, afterDeferred],
    [0, input.closing],
  ];
}

export function unearnedRevenueLotLabel(
  lot: Pick<UnearnedRevenueLotDetail, "lotKind" | "packageName" | "transactionNumber">,
): string {
  if (lot.lotKind === "OPENING") return "Opening balance (synthetic lot)";
  if (lot.lotKind === "AMBIGUOUS") return "Ambiguous package (residual)";
  if (lot.lotKind === "UNATTRIBUTED") return "Unattributed purchase (residual)";
  if (lot.lotKind === "COMPLIMENTARY") return lot.packageName || "Complimentary credits";
  return lot.packageName || lot.transactionNumber || "Paid package";
}
