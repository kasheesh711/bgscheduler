import type { RoomCapacityPackageMixRow } from "./types";

export interface RawPackageSaleAggregate {
  packageHours: number;
  revenueThb: number;
  studentCount?: number | null;
  sourceLabel?: string | null;
}

interface PackageBucketAccumulator {
  packageHourBucket: string;
  observedSaleCount: number;
  observedStudentCount: number;
  totalStudentHours: number;
  totalRevenueThb: number;
  sourceLabels: Set<string>;
}

function finitePositive(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function packageHourBucket(hours: number): string {
  const rounded = Math.max(0.5, Math.round(hours * 2) / 2);
  return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
}

export function buildPackageMixFromSales(
  sales: RawPackageSaleAggregate[],
  fallbackSourceLabel = "salesrecord paid package sales",
): RoomCapacityPackageMixRow[] {
  const buckets = new Map<string, PackageBucketAccumulator>();

  for (const sale of sales) {
    const totalHours = finitePositive(sale.packageHours);
    const totalRevenue = finitePositive(sale.revenueThb);
    if (totalHours <= 0 || totalRevenue <= 0) continue;

    const studentCount = Math.max(1, Math.round(finitePositive(sale.studentCount) || 1));
    const perStudentHours = totalHours / studentCount;
    const perStudentRevenue = totalRevenue / studentCount;
    const bucket = packageHourBucket(perStudentHours);
    const existing = buckets.get(bucket) ?? {
      packageHourBucket: bucket,
      observedSaleCount: 0,
      observedStudentCount: 0,
      totalStudentHours: 0,
      totalRevenueThb: 0,
      sourceLabels: new Set<string>(),
    };

    existing.observedSaleCount += 1;
    existing.observedStudentCount += studentCount;
    existing.totalStudentHours += perStudentHours * studentCount;
    existing.totalRevenueThb += perStudentRevenue * studentCount;
    if (sale.sourceLabel) existing.sourceLabels.add(sale.sourceLabel);
    buckets.set(bucket, existing);
  }

  const totalStudents = [...buckets.values()].reduce((sum, bucket) => sum + bucket.observedStudentCount, 0);
  if (totalStudents <= 0) return [];

  return [...buckets.values()]
    .map((bucket) => ({
      packageHourBucket: bucket.packageHourBucket,
      packageHours: bucket.totalStudentHours / bucket.observedStudentCount,
      averageRevenueThb: bucket.totalRevenueThb / bucket.observedStudentCount,
      share: bucket.observedStudentCount / totalStudents,
      observedSaleCount: bucket.observedSaleCount,
      observedStudentCount: bucket.observedStudentCount,
      sourceLabel: [...bucket.sourceLabels].sort().join(", ") || fallbackSourceLabel,
    }))
    .sort((left, right) => right.share - left.share || left.packageHours - right.packageHours);
}
