import { computeLiveStatus, findConversion, normalizeRepKey, normalizeStudentKey } from "./cohorts";
import { currentBangkokDate } from "./dates";
import { PACKAGE_BANDS, parsePackageHours } from "./package-hours";
import type {
  AdditionalMixMonthAgg,
  PackageMonthAgg,
  ParsedAdditionalSaleRow,
  ParsedNormalSaleRow,
  ProgramMonthAgg,
  RepFunnel,
  RepMonthAgg,
  SalesDashboardProjectionPayload,
  SalesDimensionsPayload,
  SlimTransaction,
  StudentDirectoryEntry,
} from "./types";

// ————————————————————————————————————————————————————————————————————————————
// Pure month-grain dimension builder for the tabbed workspace. No DB imports —
// unit-testable like gm-insights.ts. The landing payload (analytics.ts) is
// untouched; this feeds the lazily fetched /dimensions endpoint.
// ————————————————————————————————————————————————————————————————————————————

const DAY_MS = 86_400_000;
const TOP_LIMIT = 5;

export interface BuildSalesDimensionsInput {
  normalRows: ParsedNormalSaleRow[];
  additionalRows: ParsedAdditionalSaleRow[];
  projection: Pick<SalesDashboardProjectionPayload, "targetMonthlyRevenue" | "targetSource"> | null;
  today?: Date;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function programLabel(row: Pick<ParsedNormalSaleRow, "program" | "programWiseName">): string {
  return row.programWiseName || row.program;
}

function daysBetweenIso(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Tracks display-name variants for a normalized key; resolves to the most frequent. */
class VariantTally {
  private counts = new Map<string, number>();

  add(rawValue: string): void {
    const variant = collapseWhitespace(rawValue);
    if (!variant) return;
    this.counts.set(variant, (this.counts.get(variant) ?? 0) + 1);
  }

  canonical(): string {
    let best = "";
    let bestCount = -1;
    for (const [variant, count] of [...this.counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (count > bestCount) {
        best = variant;
        bestCount = count;
      }
    }
    return best;
  }

  variants(): string[] {
    return [...this.counts.keys()].sort((left, right) => left.localeCompare(right));
  }
}

function topWithOther(entries: Map<string, number>, limit = TOP_LIMIT): { name: string; rev: number }[] {
  const sorted = [...entries.entries()]
    .map(([name, rev]) => ({ name, rev }))
    .sort((left, right) => right.rev - left.rev || left.name.localeCompare(right.name));
  if (sorted.length <= limit) return sorted;
  const top = sorted.slice(0, limit);
  const otherRev = sorted.slice(limit).reduce((sum, entry) => sum + entry.rev, 0);
  return [...top, { name: "Other", rev: otherRev }];
}

/**
 * Build the month-grain dimensions payload consumed by the Reps / Programs /
 * Packages / Students tabs.
 *
 * 1. Rows with blank nicknames are skipped (mirrors buildSalesDashboardPayload).
 * 2. Rep and student grains use normalizeRepKey / normalizeStudentKey so drill
 *    keys always match transaction filtering.
 * 3. Additional-revenue rows feed only additionalMix and the student
 *    directory — they are excluded from rep/program/package groupings.
 * 4. Student status is recomputed live (validUntil+14d), never the stored
 *    churn_status.
 * 5. Unparseable package values land in "Other" and are counted via
 *    unparsedPackageCount; their revenue is never dropped.
 */
export function buildSalesDimensions(input: BuildSalesDimensionsInput): SalesDimensionsPayload {
  const today = input.today ?? new Date();
  const todayIso = currentBangkokDate(today);
  const normalRows = input.normalRows
    .filter((row) => row.studentNickname.trim())
    .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate) || left.rowNumber - right.rowNumber);
  const additionalRows = input.additionalRows
    .filter((row) => row.studentNickname.trim())
    .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate) || left.rowNumber - right.rowNumber);

  const months = new Set<string>();
  const repAggs = new Map<string, RepMonthAgg>();
  const repDisplay = new Map<string, VariantTally>();
  const programAggs = new Map<string, ProgramMonthAgg & { studentKeys: Set<string> }>();
  const packageCells = new Map<string, {
    packageBand: string;
    month: string;
    rev: number;
    count: number;
    hoursSold: number;
    hoursRows: number;
    labelTally: VariantTally;
    hoursCounts: Map<number, number>;
  }>();
  const additionalMixMap = new Map<string, AdditionalMixMonthAgg>();
  const students = new Map<string, {
    nameTally: VariantTally;
    firstSeen: string;
    lastPaymentDate: string;
    totalRevenue: number;
    txnCount: number;
    addTxnCount: number;
    programs: Set<string>;
    repKeys: Set<string>;
    normalRows: ParsedNormalSaleRow[];
  }>();
  let unparsedPackageCount = 0;

  function ensureStudent(key: string, row: { studentNickname: string; paymentDate: string }) {
    const existing = students.get(key);
    if (existing) {
      existing.nameTally.add(row.studentNickname);
      if (row.paymentDate < existing.firstSeen) existing.firstSeen = row.paymentDate;
      if (row.paymentDate > existing.lastPaymentDate) existing.lastPaymentDate = row.paymentDate;
      return existing;
    }
    const created = {
      nameTally: new VariantTally(),
      firstSeen: row.paymentDate,
      lastPaymentDate: row.paymentDate,
      totalRevenue: 0,
      txnCount: 0,
      addTxnCount: 0,
      programs: new Set<string>(),
      repKeys: new Set<string>(),
      normalRows: [] as ParsedNormalSaleRow[],
    };
    created.nameTally.add(row.studentNickname);
    students.set(key, created);
    return created;
  }

  for (const row of normalRows) {
    const month = monthStart(row.paymentDate);
    months.add(month);
    const amount = row.paymentAmount || 0;
    const enrollment = row.enrollmentType.trim();
    const program = programLabel(row);
    const parsedPackage = parsePackageHours(row.packageHoursClean || row.packageHours);
    if (parsedPackage.band === "Other") unparsedPackageCount += 1;

    // Rep month grain (normalized key; blank reps are skipped, as in repArr).
    const repKey = normalizeRepKey(row.salesRepresentative);
    if (repKey) {
      let tally = repDisplay.get(repKey);
      if (!tally) {
        tally = new VariantTally();
        repDisplay.set(repKey, tally);
      }
      tally.add(row.salesRepresentative);

      const aggKey = `${repKey}|${month}`;
      const agg = repAggs.get(aggKey) ?? {
        rep: repKey, month, rev: 0, count: 0, revT: 0, revN: 0, revR: 0, cntT: 0, cntN: 0, cntR: 0,
      };
      agg.rev += amount;
      agg.count += 1;
      if (enrollment === "Trial") { agg.revT += amount; agg.cntT += 1; }
      if (enrollment === "New Student") { agg.revN += amount; agg.cntN += 1; }
      if (enrollment === "Renewal") { agg.revR += amount; agg.cntR += 1; }
      repAggs.set(aggKey, agg);
    }

    // Program month grain.
    const programKey = `${program}|${month}`;
    const programAgg = programAggs.get(programKey) ?? {
      program, month, rev: 0, count: 0, students: 0, revT: 0, revN: 0, revR: 0, studentKeys: new Set<string>(),
    };
    programAgg.rev += amount;
    programAgg.count += 1;
    if (enrollment === "Trial") programAgg.revT += amount;
    if (enrollment === "New Student") programAgg.revN += amount;
    if (enrollment === "Renewal") programAgg.revR += amount;
    programAgg.studentKeys.add(normalizeStudentKey(row.studentNickname));
    programAggs.set(programKey, programAgg);

    // Package band month grain.
    const packageKey = `${parsedPackage.band}|${month}`;
    const cell = packageCells.get(packageKey) ?? {
      packageBand: parsedPackage.band,
      month,
      rev: 0,
      count: 0,
      hoursSold: 0,
      hoursRows: 0,
      labelTally: new VariantTally(),
      hoursCounts: new Map<number, number>(),
    };
    cell.rev += amount;
    cell.count += 1;
    cell.labelTally.add(parsedPackage.label);
    if (parsedPackage.hours !== null) {
      cell.hoursSold += parsedPackage.hours;
      cell.hoursRows += 1;
      cell.hoursCounts.set(parsedPackage.hours, (cell.hoursCounts.get(parsedPackage.hours) ?? 0) + 1);
    }
    packageCells.set(packageKey, cell);

    // Student directory.
    const studentKey = normalizeStudentKey(row.studentNickname);
    const student = ensureStudent(studentKey, row);
    student.totalRevenue += amount;
    student.txnCount += 1;
    if (program) student.programs.add(program);
    if (repKey) student.repKeys.add(repKey);
    student.normalRows.push(row);
  }

  for (const row of additionalRows) {
    const month = monthStart(row.paymentDate);
    months.add(month);
    const amount = row.paymentAmount || 0;

    const mixKey = `${month}|${row.salesType}`;
    const mix = additionalMixMap.get(mixKey) ?? { month, salesType: row.salesType, rev: 0, count: 0 };
    mix.rev += amount;
    mix.count += 1;
    additionalMixMap.set(mixKey, mix);

    const student = ensureStudent(normalizeStudentKey(row.studentNickname), row);
    student.totalRevenue += amount;
    student.addTxnCount += 1;
  }

  // Rep funnels — whole-history; trial conversion credited to the rep on the
  // student's first Trial row.
  const funnelByRep = new Map<string, { trialsHandled: number; trialsConverted: number; daysToConvert: number[] }>();
  for (const student of students.values()) {
    const sorted = student.normalRows;
    const firstTrial = sorted.find((row) => row.enrollmentType === "Trial");
    if (!firstTrial) continue;
    const creditedRep = normalizeRepKey(firstTrial.salesRepresentative);
    if (!creditedRep) continue;
    const funnel = funnelByRep.get(creditedRep) ?? { trialsHandled: 0, trialsConverted: 0, daysToConvert: [] };
    funnel.trialsHandled += 1;
    const conversion = findConversion(sorted, firstTrial.paymentDate);
    if (conversion) {
      funnel.trialsConverted += 1;
      funnel.daysToConvert.push(daysBetweenIso(firstTrial.paymentDate, conversion.paymentDate));
    }
    funnelByRep.set(creditedRep, funnel);
  }

  const revenueByRepProgram = new Map<string, Map<string, number>>();
  const revenueByRepBand = new Map<string, Map<string, number>>();
  for (const row of normalRows) {
    const repKey = normalizeRepKey(row.salesRepresentative);
    if (!repKey) continue;
    const amount = row.paymentAmount || 0;
    const program = programLabel(row) || "Unspecified";
    const band = parsePackageHours(row.packageHoursClean || row.packageHours).band;
    const programs = revenueByRepProgram.get(repKey) ?? new Map<string, number>();
    programs.set(program, (programs.get(program) ?? 0) + amount);
    revenueByRepProgram.set(repKey, programs);
    const bands = revenueByRepBand.get(repKey) ?? new Map<string, number>();
    bands.set(band, (bands.get(band) ?? 0) + amount);
    revenueByRepBand.set(repKey, bands);
  }

  const repDisplayName = (repKey: string): string => repDisplay.get(repKey)?.canonical() || repKey;

  const repFunnels: RepFunnel[] = [...repDisplay.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((repKey) => {
      const funnel = funnelByRep.get(repKey) ?? { trialsHandled: 0, trialsConverted: 0, daysToConvert: [] };
      return {
        rep: repDisplayName(repKey),
        trialsHandled: funnel.trialsHandled,
        trialsConverted: funnel.trialsConverted,
        medianDaysToConvert: median(funnel.daysToConvert),
        topPrograms: topWithOther(revenueByRepProgram.get(repKey) ?? new Map()),
        topPackages: topWithOther(revenueByRepBand.get(repKey) ?? new Map()).map(({ name, rev }) => ({ band: name, rev })),
      };
    });

  const reps: RepMonthAgg[] = [...repAggs.values()]
    .map((agg) => ({ ...agg, rep: repDisplayName(agg.rep) }))
    .sort((left, right) => left.rep.localeCompare(right.rep) || left.month.localeCompare(right.month));

  const programs: ProgramMonthAgg[] = [...programAggs.values()]
    .map(({ studentKeys, ...agg }) => ({ ...agg, students: studentKeys.size }))
    .sort((left, right) => left.program.localeCompare(right.program) || left.month.localeCompare(right.month));

  const bandOrder = new Map<string, number>(PACKAGE_BANDS.map((band, index) => [band, index]));
  const packages: PackageMonthAgg[] = [...packageCells.values()]
    .map((cell) => {
      let canonicalHours: number | null = null;
      let bestCount = -1;
      for (const [hours, count] of [...cell.hoursCounts.entries()].sort(([left], [right]) => left - right)) {
        if (count > bestCount) {
          canonicalHours = hours;
          bestCount = count;
        }
      }
      return {
        packageBand: cell.packageBand,
        packageLabel: cell.labelTally.canonical(),
        hours: canonicalHours,
        month: cell.month,
        rev: cell.rev,
        count: cell.count,
        totalHoursSold: cell.hoursRows > 0 ? cell.hoursSold : null,
      };
    })
    .sort((left, right) =>
      (bandOrder.get(left.packageBand) ?? 99) - (bandOrder.get(right.packageBand) ?? 99)
      || left.month.localeCompare(right.month));

  const additionalMix = [...additionalMixMap.values()]
    .sort((left, right) => left.month.localeCompare(right.month) || left.salesType.localeCompare(right.salesType));

  const studentEntries: StudentDirectoryEntry[] = [...students.entries()]
    .map(([key, student]) => {
      const live = student.normalRows.length > 0
        ? computeLiveStatus(student.normalRows, todayIso)
        : { status: "Pending" as const, latestValidUntil: null, decisionDate: null };
      return {
        key,
        displayName: student.nameTally.canonical(),
        displayNameVariants: student.nameTally.variants(),
        firstSeen: student.firstSeen,
        lastPaymentDate: student.lastPaymentDate,
        totalRevenue: student.totalRevenue,
        txnCount: student.txnCount,
        addTxnCount: student.addTxnCount,
        programs: [...student.programs].sort((left, right) => left.localeCompare(right)),
        reps: [...student.repKeys].map(repDisplayName).sort((left, right) => left.localeCompare(right)),
        latestValidUntil: live.latestValidUntil,
        status: live.status,
        decisionDate: live.decisionDate,
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.key.localeCompare(right.key));

  return {
    months: [...months].sort((left, right) => left.localeCompare(right)),
    reps,
    repFunnels,
    programs,
    packages,
    additionalMix,
    students: studentEntries,
    targetMonthlyRevenue: input.projection?.targetSource === "projection"
      ? input.projection.targetMonthlyRevenue
      : null,
    unparsedPackageCount,
    generatedAt: today.toISOString(),
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Slim transaction serialization + filtering. toSlimTransaction NEVER
// serializes the `raw` jsonb column (PII guard) — enforced by unit test.
// ————————————————————————————————————————————————————————————————————————————

export function toSlimTransaction(row: ParsedNormalSaleRow): SlimTransaction {
  const parsedPackage = parsePackageHours(row.packageHoursClean || row.packageHours);
  return {
    date: row.paymentDate,
    student: collapseWhitespace(row.studentNickname),
    studentKey: normalizeStudentKey(row.studentNickname),
    rep: collapseWhitespace(row.salesRepresentative),
    program: programLabel(row),
    packageLabel: parsedPackage.label,
    band: parsedPackage.band,
    hours: parsedPackage.hours,
    amount: row.paymentAmount,
    enrollmentType: row.enrollmentType,
    validUntil: row.validUntil,
    sourceMonth: row.sourceMonth,
    numberOfStudents: row.numberOfStudents,
    kind: "normal",
  };
}

export function toSlimAdditionalTransaction(row: ParsedAdditionalSaleRow): SlimTransaction {
  return {
    date: row.paymentDate,
    student: collapseWhitespace(row.studentNickname),
    studentKey: normalizeStudentKey(row.studentNickname),
    rep: "",
    program: "",
    packageLabel: collapseWhitespace(row.packageName),
    band: "",
    hours: null,
    amount: row.paymentAmount,
    enrollmentType: "",
    validUntil: null,
    sourceMonth: row.sourceMonth,
    numberOfStudents: null,
    kind: "additional",
    salesType: row.salesType,
  };
}

export interface SlimTransactionFilters {
  rep?: string;
  program?: string;
  band?: string;
  student?: string;
  from?: string;
  to?: string;
}

/**
 * In-memory filter over the slim-transaction materialization. Rep and student
 * filters apply the same normalize* keys used during aggregation so drill keys
 * always match. Rep/program/band filters never match additional rows (those
 * are excluded from rep/program/package groupings).
 */
export function filterSlimTransactions(rows: SlimTransaction[], filters: SlimTransactionFilters): SlimTransaction[] {
  const repKey = filters.rep !== undefined ? normalizeRepKey(filters.rep) : null;
  const studentKey = filters.student !== undefined ? normalizeStudentKey(filters.student) : null;
  return rows.filter((row) => {
    if (repKey !== null && (row.kind !== "normal" || normalizeRepKey(row.rep) !== repKey)) return false;
    if (filters.program !== undefined && (row.kind !== "normal" || row.program !== filters.program)) return false;
    if (filters.band !== undefined && (row.kind !== "normal" || row.band !== filters.band)) return false;
    if (studentKey !== null && row.studentKey !== studentKey) return false;
    if (filters.from !== undefined && row.date < filters.from) return false;
    if (filters.to !== undefined && row.date > filters.to) return false;
    return true;
  });
}

/** Stable ordering for the transactions endpoint: newest first. */
export function sortSlimTransactions(rows: SlimTransaction[]): SlimTransaction[] {
  return [...rows].sort((left, right) =>
    right.date.localeCompare(left.date)
    || left.kind.localeCompare(right.kind)
    || left.studentKey.localeCompare(right.studentKey)
    || right.amount - left.amount);
}
