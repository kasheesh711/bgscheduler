import { addDaysIso, currentBangkokDate, dayOfWeekShort } from "./dates";
import type {
  ParsedAdditionalSaleRow,
  ParsedNormalSaleRow,
  SalesAdditionalDayAggregate,
  SalesChurnListEntry,
  SalesDashboardPayload,
  SalesDashboardSourceSummary,
  SalesDayAggregate,
  SalesDayRepAggregate,
  SalesRepAggregate,
  SalesRetentionCohortEntry,
  SalesTrialCohortEntry,
} from "./types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_BANDS = [
  { start: 1, end: 5 },
  { start: 6, end: 10 },
  { start: 11, end: 15 },
  { start: 16, end: 20 },
  { start: 21, end: 25 },
  { start: 26, end: 31 },
];

function emptyDayCount(): Record<string, number> {
  return { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
}

function ensureNormalDay(map: Map<string, SalesDayAggregate>, date: string, sourceLabel: string): SalesDayAggregate {
  const existing = map.get(date);
  if (existing) return existing;
  const row: SalesDayAggregate = {
    d: date,
    m: sourceLabel,
    rev: 0,
    trial: 0,
    newS: 0,
    renew: 0,
    count: 0,
    revT: 0,
    revN: 0,
    revR: 0,
    pkgs: {},
    prgs: {},
    reps: {},
    dow: dayOfWeekShort(date),
  };
  map.set(date, row);
  return row;
}

function ensureAdditionalDay(map: Map<string, SalesAdditionalDayAggregate>, date: string, sourceLabel: string): SalesAdditionalDayAggregate {
  const existing = map.get(date);
  if (existing) return existing;
  const row = { d: date, m: sourceLabel, rev: 0, count: 0 };
  map.set(date, row);
  return row;
}

function ensureRep(day: SalesDayAggregate, rep: string): SalesDayRepAggregate {
  day.reps[rep] ??= { rev: 0, count: 0, revT: 0, revN: 0, revR: 0, cntT: 0, cntN: 0, cntR: 0 };
  return day.reps[rep];
}

function increment(map: Record<string, number>, key: string, amount = 1): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + amount;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function buildCompletionStats(normalDays: SalesDayAggregate[], now = new Date()) {
  const [todayYear, todayMonth] = currentBangkokDate(now).split("-").map(Number);
  const monthGroups = new Map<string, Array<{ dom: number; rev: number }>>();

  for (const day of normalDays) {
    const key = monthKey(day.d);
    monthGroups.set(key, [...(monthGroups.get(key) ?? []), { dom: dayOfMonth(day.d), rev: day.rev }]);
  }

  const completionSamples: Array<Record<number, number>> = [];
  const weekBandSamples: number[][] = [];

  for (const [key, days] of [...monthGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [year, month] = key.split("-").map(Number);
    if (year > todayYear || (year === todayYear && month >= todayMonth)) continue;
    const total = days.reduce((sum, day) => sum + day.rev, 0);
    if (total <= 0) continue;

    let cumulative = 0;
    const cumulativeByDay: Record<number, number> = {};
    for (const day of [...days].sort((left, right) => left.dom - right.dom)) {
      cumulative += day.rev;
      cumulativeByDay[day.dom] = cumulative / total;
    }

    let last = 0;
    const filled: Record<number, number> = {};
    for (let dom = 1; dom <= daysInMonth(key); dom += 1) {
      if (cumulativeByDay[dom] !== undefined) last = cumulativeByDay[dom];
      filled[dom] = last;
    }
    completionSamples.push(filled);

    weekBandSamples.push(WEEK_BANDS.map((band) => {
      const bandRev = days
        .filter((day) => day.dom >= band.start && day.dom <= band.end)
        .reduce((sum, day) => sum + day.rev, 0);
      return Math.round((bandRev / total) * 10_000) / 10_000;
    }));
  }

  const completionRate: Record<string, number> = {};
  for (let dom = 1; dom <= 31; dom += 1) {
    const values = completionSamples.map((sample) => sample[dom] ?? sample[Math.max(...Object.keys(sample).map(Number))] ?? 1);
    completionRate[String(dom)] = values.length > 0
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000
      : Math.round((dom / 31) * 10_000) / 10_000;
  }

  const weekBandPct = WEEK_BANDS.map((_, index) => {
    if (weekBandSamples.length === 0) return Math.round((1 / WEEK_BANDS.length) * 10_000) / 10_000;
    return Math.round((weekBandSamples.reduce((sum, sample) => sum + sample[index], 0) / weekBandSamples.length) * 10_000) / 10_000;
  });

  return { completionRate, completionMonths: completionSamples.length, weekBandPct };
}

function normalizedNick(row: Pick<ParsedNormalSaleRow, "studentNickname">): string {
  return row.studentNickname.toLowerCase().trim();
}

function isPaidEnrollment(row: ParsedNormalSaleRow): boolean {
  return row.enrollmentType === "New Student" || row.enrollmentType === "Renewal";
}

function buildTrialCohort(rows: ParsedNormalSaleRow[]): SalesTrialCohortEntry[] {
  const byNick = new Map<string, ParsedNormalSaleRow[]>();
  for (const row of rows) {
    const nick = normalizedNick(row);
    if (!nick) continue;
    byNick.set(nick, [...(byNick.get(nick) ?? []), row]);
  }

  const cohort: SalesTrialCohortEntry[] = [];
  for (const [nick, items] of byNick.entries()) {
    const sorted = [...items].sort((left, right) => left.paymentDate.localeCompare(right.paymentDate) || left.rowNumber - right.rowNumber);
    const firstTrial = sorted.find((row) => row.enrollmentType === "Trial");
    if (!firstTrial) continue;
    const converted = sorted.find((row) => row.enrollmentType === "New Student" && row.paymentDate > firstTrial.paymentDate);
    cohort.push({
      nick,
      trialDate: firstTrial.paymentDate,
      convertedDate: converted?.paymentDate ?? null,
    });
  }
  return cohort.sort((left, right) => left.trialDate.localeCompare(right.trialDate) || left.nick.localeCompare(right.nick));
}

function buildRetentionCohort(rows: ParsedNormalSaleRow[]): SalesRetentionCohortEntry[] {
  const paidRowsByNick = new Map<string, ParsedNormalSaleRow[]>();
  for (const row of rows) {
    const nick = normalizedNick(row);
    if (!nick || !isPaidEnrollment(row)) continue;
    paidRowsByNick.set(nick, [...(paidRowsByNick.get(nick) ?? []), row]);
  }

  const cohort: SalesRetentionCohortEntry[] = [];
  for (const [nick, items] of paidRowsByNick.entries()) {
    const sorted = [...items].sort((left, right) => left.paymentDate.localeCompare(right.paymentDate) || left.rowNumber - right.rowNumber);
    for (const row of sorted) {
      if (!row.validUntil) continue;
      const decisionDate = addDaysIso(row.validUntil, 14);
      const renewed = sorted.find((candidate) => candidate.paymentDate > decisionDate);
      cohort.push({
        nick,
        saleDate: row.paymentDate,
        validUntil: row.validUntil,
        decisionDate,
        renewedDate: renewed?.paymentDate ?? null,
        status: renewed ? "Retained" : "Churned",
      });
    }
  }

  return cohort.sort((left, right) => left.decisionDate.localeCompare(right.decisionDate) || left.nick.localeCompare(right.nick));
}

export function buildSalesDashboardPayload(input: {
  normalRows: ParsedNormalSaleRow[];
  additionalRows: ParsedAdditionalSaleRow[];
  sources: SalesDashboardSourceSummary[];
  token: SalesDashboardPayload["token"];
  now?: Date;
}): SalesDashboardPayload {
  const byDay = new Map<string, SalesDayAggregate>();
  const addByDay = new Map<string, SalesAdditionalDayAggregate>();
  const pkgCount: Record<string, number> = {};
  const progCount: Record<string, number> = {};
  const addPkgCount: Record<string, number> = {};
  const repRevenue: Record<string, number> = {};
  const repCount: Record<string, number> = {};
  const dayCount = emptyDayCount();
  const trialStudents: Record<string, string> = {};
  const newStudents: Record<string, string> = {};
  const renewStudents: Record<string, boolean> = {};
  let totalTxn = 0;
  let totalAddTxn = 0;

  for (const row of input.normalRows) {
    if (!row.studentNickname.trim()) continue;
    totalTxn += 1;
    const day = ensureNormalDay(byDay, row.paymentDate, row.sourceLabel);
    const enrollment = row.enrollmentType.trim();
    const amount = row.paymentAmount || 0;
    const packageName = row.packageHoursClean || row.packageHours;
    const program = row.programWiseName || row.program;
    const rep = row.salesRepresentative;
    const nick = row.studentNickname.toLowerCase().trim();

    day.rev += amount;
    day.count += 1;
    if (enrollment === "Trial") {
      day.trial += 1;
      day.revT += amount;
      if (nick && !trialStudents[nick]) trialStudents[nick] = row.paymentDate;
    }
    if (enrollment === "New Student") {
      day.newS += 1;
      day.revN += amount;
      if (nick) newStudents[nick] = row.paymentDate;
    }
    if (enrollment === "Renewal") {
      day.renew += 1;
      day.revR += amount;
      if (nick) renewStudents[nick] = true;
    }

    increment(day.pkgs, packageName);
    increment(day.prgs, program);
    increment(pkgCount, packageName);
    increment(progCount, program);
    if (rep) {
      const dayRep = ensureRep(day, rep);
      dayRep.rev += amount;
      dayRep.count += 1;
      if (enrollment === "Trial") {
        dayRep.revT += amount;
        dayRep.cntT += 1;
      }
      if (enrollment === "New Student") {
        dayRep.revN += amount;
        dayRep.cntN += 1;
      }
      if (enrollment === "Renewal") {
        dayRep.revR += amount;
        dayRep.cntR += 1;
      }
      repRevenue[rep] = (repRevenue[rep] ?? 0) + amount;
      repCount[rep] = (repCount[rep] ?? 0) + 1;
    }
    if (day.dow) dayCount[day.dow] = (dayCount[day.dow] ?? 0) + 1;
  }

  for (const row of input.additionalRows) {
    if (!row.studentNickname.trim()) continue;
    totalAddTxn += 1;
    const day = ensureAdditionalDay(addByDay, row.paymentDate, row.sourceLabel);
    day.rev += row.paymentAmount || 0;
    day.count += 1;
    increment(addPkgCount, row.packageName);
  }

  const normalDays = [...byDay.values()].sort((left, right) => left.d.localeCompare(right.d));
  const addDays = [...addByDay.values()].sort((left, right) => left.d.localeCompare(right.d));
  const trialCohort = buildTrialCohort(input.normalRows);
  const retentionCohort = buildRetentionCohort(input.normalRows);
  const repArr: SalesRepAggregate[] = Object.keys(repRevenue)
    .map((name) => ({ name, revenue: Math.round(repRevenue[name]), count: repCount[name] ?? 0 }))
    .sort((left, right) => right.revenue - left.revenue);
  const churnList: SalesChurnListEntry[] = input.normalRows
    .filter((row) => row.churnStatus === "Churned" || row.churnStatus === "Retained" || row.churnStatus === "Active")
    .map((row) => ({
      nick: row.studentNickname.toLowerCase().trim(),
      validUntil: row.validUntil ?? "",
      status: row.churnStatus as SalesChurnListEntry["status"],
    }))
    .filter((row) => row.validUntil);
  const { completionRate, completionMonths, weekBandPct } = buildCompletionStats(normalDays, input.now);
  const lastImportedAt = input.sources
    .map((source) => source.lastImportedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  return {
    normalDays,
    addDays,
    pkgCount,
    progCount,
    addPkgCount,
    repArr,
    dayCount: DAY_NAMES.reduce((map, day) => ({ ...map, [day]: dayCount[day] ?? 0 }), {}),
    totalTxn,
    totalAddTxn,
    uniqueTrials: Object.keys(trialStudents).length,
    uniqueNewStudents: Object.keys(newStudents).length,
    uniqueRenewals: Object.keys(renewStudents).length,
    churnedStudents: churnList.filter((row) => row.status === "Churned").length,
    eligibleStudents: churnList.filter((row) => row.status === "Churned" || row.status === "Retained").length,
    completionRate,
    completionMonths,
    weekBandPct,
    churnList,
    trialCohort,
    retentionCohort,
    lastUpdated: lastImportedAt,
    sources: input.sources,
    token: input.token,
  };
}
