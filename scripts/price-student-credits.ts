// ----------------------------------------------------------------------------
// Prices a student's billable credits against the active payroll rate card.
// Read-only: SELECTs only, never writes, never calls Wise.
//
// Revenue uses `payroll_rate_rules.price_per_hour` — the STUDENT list price.
// Cost uses `expected_revenue_per_hour` — the TUTOR's hourly pay, which is the
// only figure the tier changes (price_per_hour is identical across BG0-BG3 for
// a given course + band, so the tutor's tier never moves the family's bill).
//
// Billing is read from `credit_control_credit_history`, NOT from
// `credit_control_sessions`: the ledger is the record of what was charged and
// is strictly more complete — a session deleted in Wise after it ran vanishes
// from the sessions table while its charge remains on the ledger.
//
// Fail-closed throughout: an unmappable course, a missing rate rule, or a
// charge with no resolvable tutor tier is reported as such and excluded from
// the totals. Nothing is priced at zero to make a table balance.
//
// Usage:
//   npx tsx scripts/price-student-credits.ts \
//     --match=Leila.Ea,Finn.Ea --from=2026-05-15 --out=/some/dir
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";
import { and, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateStartUtc } from "@/lib/room-capacity/dates";
import {
  buildRateRuleLookup,
  normalizePayrollRateCourse,
  payrollStudentBand,
  rateRuleKey,
  type PayrollStudentBand,
} from "@/lib/payroll/rate-card";
import type { PayrollTier } from "@/lib/payroll/types";

loadEnvConfig(process.cwd());

/** Statuses that produce a charge we intend to bill. */
const BILLABLE_STATUSES = ["ENDED", "MISSED"];

interface RevenueLine {
  student: string;
  wiseSubject: string;
  courseKey: string;
  credits: number;
  pricePerHour: number | null;
  amount: number | null;
  issue: string | null;
}

interface CostLine {
  student: string;
  teacher: string;
  tier: string;
  courseKey: string;
  credits: number;
  ratePerHour: number | null;
  amount: number | null;
  issue: string | null;
}

/** Reads a `--flag=value` CLI arg, returning `fallback` when absent. */
function parseArgValue(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

/** The bracketed nickname code inside a Wise student name. */
function studentCode(studentName: string): string {
  return /\(([^)]+)\)/.exec(studentName)?.[1]?.trim() ?? studentName;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function baht(value: number | null): string {
  return value === null ? "—" : `฿${value.toLocaleString("en-US")}`;
}

function markdownTable(header: string[], rows: (string | number)[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`),
  ].join("\n");
}

function toCsv(header: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(escape).join(",")).join("\n") + "\n";
}

async function main() {
  const matchArg = parseArgValue("match", "");
  const fromArg = parseArgValue("from", "");
  const outDir = parseArgValue("out", path.join(process.cwd(), "tmp"));

  if (!matchArg || !fromArg) {
    throw new Error("Both --match=<a,b> and --from=YYYY-MM-DD are required.");
  }
  const matches = matchArg.split(",").map((value) => value.trim()).filter(Boolean);
  const fromInstant = bangkokDateStartUtc(fromArg);
  const db: Database = getDb();

  // -- Rate card -------------------------------------------------------------
  const [version] = await db
    .select({
      id: schema.payrollRateCardVersions.id,
      versionName: schema.payrollRateCardVersions.versionName,
      effectiveMonth: schema.payrollRateCardVersions.effectiveMonth,
    })
    .from(schema.payrollRateCardVersions)
    .where(eq(schema.payrollRateCardVersions.active, true))
    .limit(1);

  if (!version) throw new Error("No active payroll rate card version.");

  const rules = await db
    .select()
    .from(schema.payrollRateRules)
    .where(eq(schema.payrollRateRules.versionId, version.id));

  const ruleLookup = buildRateRuleLookup(rules);

  // price_per_hour is tier-invariant, so index it by (band, course) alone and
  // assert that invariant rather than assuming it.
  const priceByBandCourse = new Map<string, { price: number | null; distinct: Set<number | null> }>();
  for (const rule of rules) {
    const key = `${rule.studentBand}|${rule.normalizedCourseKey}`;
    const entry = priceByBandCourse.get(key) ?? { price: rule.pricePerHour, distinct: new Set() };
    entry.distinct.add(rule.pricePerHour);
    entry.price = rule.pricePerHour;
    priceByBandCourse.set(key, entry);
  }

  console.log("# Credit pricing");
  console.log(`Rate card : ${version.versionName} (effective ${version.effectiveMonth}, ${rules.length} rules)`);
  console.log(`Window    : ${fromArg} 00:00 Asia/Bangkok → now`);
  console.log("");

  // -- Students --------------------------------------------------------------
  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id, generatedAt: schema.creditControlSnapshots.generatedAt })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);
  if (!snapshot) throw new Error("No active credit-control snapshot.");

  const students = await db
    .select({
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentName: schema.creditControlStudents.studentName,
    })
    .from(schema.creditControlStudents)
    .where(and(
      eq(schema.creditControlStudents.snapshotId, snapshot.id),
      or(...matches.map((term) => ilike(schema.creditControlStudents.studentName, `%${term}%`))),
    ));

  if (students.length === 0) throw new Error(`No students matched ${matches.join(", ")}.`);
  const studentIds = students.map((student) => student.wiseStudentId);
  const nameById = new Map(students.map((s) => [s.wiseStudentId, s.studentName]));

  console.log(`Snapshot  : ${snapshot.id} (${snapshot.generatedAt.toISOString()})`);
  console.log(`Students  : ${students.map((s) => s.studentName).join(" · ")}`);
  console.log("");

  // -- Billable charges, from the ledger ------------------------------------
  const charges = await db
    .select({
      wiseStudentId: schema.creditControlCreditHistory.wiseStudentId,
      credit: schema.creditControlCreditHistory.credit,
      meetingStatus: schema.creditControlCreditHistory.meetingStatus,
      subject: sql<string>`${schema.creditControlCreditHistory.raw} -> 'classroom' ->> 'subject'`,
    })
    .from(schema.creditControlCreditHistory)
    .where(and(
      eq(schema.creditControlCreditHistory.snapshotId, snapshot.id),
      inArray(schema.creditControlCreditHistory.wiseStudentId, studentIds),
      gte(schema.creditControlCreditHistory.createdAtWise, fromInstant),
      inArray(schema.creditControlCreditHistory.meetingStatus, BILLABLE_STATUSES),
    ));

  // Every package in play is ONE_TO_ONE, but derive the band rather than assume.
  const packages = await db
    .select({
      wiseStudentId: schema.creditControlPackages.wiseStudentId,
      subject: schema.creditControlPackages.subject,
      classType: schema.creditControlPackages.classType,
    })
    .from(schema.creditControlPackages)
    .where(and(
      eq(schema.creditControlPackages.snapshotId, snapshot.id),
      inArray(schema.creditControlPackages.wiseStudentId, studentIds),
    ));

  const bandBySubject = new Map<string, PayrollStudentBand>();
  for (const pkg of packages) {
    bandBySubject.set(
      `${pkg.wiseStudentId}|${pkg.subject}`,
      payrollStudentBand(pkg.classType === "ONE_TO_ONE" ? 1 : null),
    );
  }

  const revenueByKey = new Map<string, RevenueLine>();
  for (const charge of charges) {
    if (charge.credit <= 0) continue;
    const student = studentCode(nameById.get(charge.wiseStudentId) ?? charge.wiseStudentId);
    const wiseSubject = charge.subject ?? "";
    const courseKey = normalizePayrollRateCourse(wiseSubject);
    const band = bandBySubject.get(`${charge.wiseStudentId}|${wiseSubject}`) ?? "1";
    const key = `${student}|${wiseSubject}`;

    const existing = revenueByKey.get(key);
    if (existing) {
      existing.credits = round2(existing.credits + charge.credit);
      existing.amount = existing.pricePerHour === null ? null : round2(existing.credits * existing.pricePerHour);
      continue;
    }

    const priceEntry = courseKey ? priceByBandCourse.get(`${band}|${courseKey}`) : undefined;
    const price = priceEntry?.price ?? null;
    let issue: string | null = null;
    if (!courseKey) issue = "UNMAPPED_COURSE";
    else if (!priceEntry) issue = "MISSING_RATE_RULE";
    else if (price === null) issue = "NULL_PRICE_PER_HOUR";
    else if (priceEntry.distinct.size > 1) issue = "PRICE_VARIES_BY_TIER";

    revenueByKey.set(key, {
      student,
      wiseSubject,
      courseKey: courseKey ?? "(unmapped)",
      credits: round2(charge.credit),
      pricePerHour: price,
      amount: price === null ? null : round2(charge.credit * price),
      issue,
    });
  }

  const revenue = [...revenueByKey.values()].sort(
    (a, b) => a.student.localeCompare(b.student) || a.wiseSubject.localeCompare(b.wiseSubject),
  );

  console.log("## Revenue — student list price");
  console.log(markdownTable(
    ["Student", "Wise subject", "Course key", "Credits", "฿/h", "Amount", "Issue"],
    revenue.map((line) => [
      line.student, line.wiseSubject, line.courseKey, line.credits,
      baht(line.pricePerHour), baht(line.amount), line.issue ?? "",
    ]),
  ));
  console.log("");

  // -- Tutor cost ------------------------------------------------------------
  const [latestTierMonth] = await db
    .select({ month: sql<string>`max(${schema.payrollTeacherTiers.payrollMonth})` })
    .from(schema.payrollTeacherTiers);
  const tierMonth = latestTierMonth?.month ?? null;
  if (!tierMonth) throw new Error("No payroll_teacher_tiers rows — cost cannot be computed.");

  const costRows = await db
    .select({
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      teacherName: schema.creditControlSessions.teacherName,
      subject: schema.creditControlSessions.subject,
      credit: schema.creditControlSessions.creditApplied,
      tier: schema.payrollTeacherTiers.normalizedTier,
    })
    .from(schema.creditControlSessions)
    .leftJoin(
      schema.payrollTeacherTiers,
      and(
        eq(schema.payrollTeacherTiers.wiseUserId, schema.creditControlSessions.wiseTeacherUserId),
        eq(schema.payrollTeacherTiers.payrollMonth, tierMonth),
      ),
    )
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshot.id),
      inArray(schema.creditControlSessions.wiseStudentId, studentIds),
      gte(schema.creditControlSessions.scheduledStartTime, fromInstant),
      inArray(schema.creditControlSessions.meetingStatus, BILLABLE_STATUSES),
    ));

  const costByKey = new Map<string, CostLine>();
  for (const row of costRows) {
    if (row.credit <= 0) continue;
    const student = studentCode(nameById.get(row.wiseStudentId) ?? row.wiseStudentId);
    const teacher = row.teacherName?.trim() || "TEACHER_TBC";
    const tier = (row.tier as PayrollTier | null) ?? null;
    const courseKey = normalizePayrollRateCourse(row.subject);
    const band = bandBySubject.get(`${row.wiseStudentId}|${row.subject}`) ?? "1";
    const key = `${student}|${teacher}|${row.subject}`;

    const existing = costByKey.get(key);
    if (existing) {
      existing.credits = round2(existing.credits + row.credit);
      existing.amount = existing.ratePerHour === null ? null : round2(existing.credits * existing.ratePerHour);
      continue;
    }

    let issue: string | null = null;
    let rate: number | null = null;
    if (!tier || tier === "Unassigned") issue = "TIER_UNRESOLVED";
    else if (!courseKey) issue = "UNMAPPED_COURSE";
    else {
      const rule = ruleLookup.get(rateRuleKey({ studentBand: band, normalizedCourseKey: courseKey, tierKey: tier }));
      if (!rule) issue = "MISSING_RATE_RULE";
      else rate = rule.expectedRevenuePerHour;
    }

    costByKey.set(key, {
      student, teacher, tier: tier ?? "TIER_UNRESOLVED",
      courseKey: courseKey ?? "(unmapped)",
      credits: round2(row.credit),
      ratePerHour: rate,
      amount: rate === null ? null : round2(row.credit * rate),
      issue,
    });
  }

  const cost = [...costByKey.values()].sort(
    (a, b) => a.student.localeCompare(b.student) || b.credits - a.credits,
  );

  console.log(`## Tutor cost basis (tier snapshot ${tierMonth})`);
  console.log(markdownTable(
    ["Student", "Tutor", "Tier", "Course key", "Credits", "฿/h", "Amount", "Issue"],
    cost.map((line) => [
      line.student, line.teacher, line.tier, line.courseKey, line.credits,
      baht(line.ratePerHour), baht(line.amount), line.issue ?? "",
    ]),
  ));
  console.log("");

  // -- Totals ----------------------------------------------------------------
  const totals = students.map((student) => {
    const label = studentCode(student.studentName);
    const rev = revenue.filter((line) => line.student === label);
    const cst = cost.filter((line) => line.student === label);
    const billedCredits = round2(rev.reduce((sum, line) => sum + line.credits, 0));
    const revenueTotal = round2(rev.reduce((sum, line) => sum + (line.amount ?? 0), 0));
    const costedCredits = round2(cst.filter((l) => l.amount !== null).reduce((s, l) => s + l.credits, 0));
    const costTotal = round2(cst.reduce((sum, line) => sum + (line.amount ?? 0), 0));
    return { label, billedCredits, revenueTotal, costedCredits, costTotal,
             margin: round2(revenueTotal - costTotal),
             uncosted: round2(billedCredits - costedCredits) };
  });

  console.log("## Totals");
  console.log(markdownTable(
    ["Student", "Billed credits", "Revenue", "Tutor cost", "Gross margin", "Credits w/o cost"],
    totals.map((t) => [
      t.label, t.billedCredits, baht(t.revenueTotal), baht(t.costTotal), baht(t.margin),
      t.uncosted > 0 ? t.uncosted : "0",
    ]),
  ));
  console.log("");
  console.log(`GRAND TOTAL revenue: ${baht(round2(totals.reduce((s, t) => s + t.revenueTotal, 0)))}`);
  console.log(`GRAND TOTAL cost   : ${baht(round2(totals.reduce((s, t) => s + t.costTotal, 0)))}`);
  console.log(`Billed credits     : ${round2(totals.reduce((s, t) => s + t.billedCredits, 0))}`);
  console.log("");

  // -- CSV -------------------------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "eastwood-pricing.csv");
  writeFileSync(target, toCsv(
    ["Section", "Student", "Party", "Tier", "Wise subject", "Course key", "Credits", "RatePerHour", "Amount", "Issue"],
    [
      ...revenue.map((l) => ["revenue", l.student, "student", "", l.wiseSubject, l.courseKey, l.credits, l.pricePerHour ?? "", l.amount ?? "", l.issue ?? ""]),
      ...cost.map((l) => ["cost", l.student, l.teacher, l.tier, "", l.courseKey, l.credits, l.ratePerHour ?? "", l.amount ?? "", l.issue ?? ""]),
    ],
  ), "utf8");
  console.log(`Wrote ${target}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
