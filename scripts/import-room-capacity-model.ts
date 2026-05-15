import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, lt } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { buildDemandMixFromSessions } from "@/lib/room-capacity/analysis";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth } from "@/lib/room-capacity/dates";
import { buildPackageMixFromSales, type RawPackageSaleAggregate } from "@/lib/room-capacity/package-mix";
import type { RoomCapacitySession } from "@/lib/room-capacity/types";

interface ProjectionPayload {
  title?: string;
  forecast_start: string;
  forecast_end: string;
  metadata?: Record<string, unknown>;
  forecast_source?: Array<Record<string, unknown>>;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function normalizedHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[().?]/g, "")
    .trim();
}

function compactHeader(value: unknown): string {
  return normalizedHeader(value).replace(/[^a-z0-9ก-๙]/g, "");
}

function moneyValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "")
    .replace(/[฿,\s]/g, "")
    .replace(/[()]/g, "")
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function present(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function paidValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = normalizedHeader(value);
  return normalized === "true" || normalized === "yes" || normalized === "paid" || normalized.includes("ชำระ");
}

function findColumn(headers: unknown[], aliases: string[]): number {
  const compactAliases = aliases.map(compactHeader);
  return headers.findIndex((header) => compactAliases.includes(compactHeader(header)));
}

function findHeaderRow(rows: unknown[][]): number {
  return rows.findIndex((row) => {
    const headers = row.map(compactHeader);
    return headers.includes("transactionno") && headers.includes("totalnoofhrs") && headers.includes("noofstudent");
  });
}

function rowValue(row: unknown[], index: number): unknown {
  return index >= 0 ? row[index] : null;
}

function parseSalesRecordMonth(fileName: string): string | null {
  const match = fileName.match(/(\d{4})\s+(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function salesRecordDirForProjection(projectionPath: string): string {
  const outputIndex = projectionPath.indexOf(`${path.sep}outputs${path.sep}`);
  const datasetRoot = outputIndex >= 0 ? projectionPath.slice(0, outputIndex) : path.dirname(path.dirname(path.dirname(projectionPath)));
  return path.join(datasetRoot, "salesrecord");
}

function listSalesRecordFiles(salesDir: string): string[] {
  const files = fs
    .readdirSync(salesDir)
    .filter((file) => file.endsWith(".xlsx") && !file.startsWith("~$"))
    .sort();
  const snapshotMonths = new Set(
    files
      .filter((file) => file.toLowerCase().includes("snapshot"))
      .map(parseSalesRecordMonth)
      .filter((month): month is string => Boolean(month)),
  );

  return files.filter((file) => {
    const month = parseSalesRecordMonth(file);
    return !month || !snapshotMonths.has(month) || file.toLowerCase().includes("snapshot");
  });
}

function isResidualPackage(value: unknown): boolean {
  const normalized = normalizedHeader(value);
  return normalized.includes("deposit") || normalized.includes("ยอดคงค้าง");
}

function packageSalesFromWorkbook(filePath: string): RawPackageSaleAggregate[] {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const fileLabel = path.basename(filePath);
  const sales: RawPackageSaleAggregate[] = [];

  for (const sheetName of workbook.SheetNames) {
    const normalizedSheet = sheetName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedSheet !== "1packagesales" && normalizedSheet !== "salesrecord") continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: null,
    });
    const headerIndex = findHeaderRow(rows);
    if (headerIndex < 0) continue;

    const headers = rows[headerIndex];
    const salesTypeIndex = findColumn(headers, ["Sales Type"]);
    const packageIndex = findColumn(headers, ["Package"]);
    const hoursIndex = findColumn(headers, ["Total No. of Hrs"]);
    const studentCountIndex = findColumn(headers, ["No. of Student"]);
    const revenueIndex = findColumn(headers, ["ยอดชำระสุทธิ", "Total Price"]);
    const paidIndex = findColumn(headers, ["สถานะการชำระเงิน", "Already Paid?"]);
    const paymentDateIndex = findColumn(headers, ["วันที่ชำระเงิน", "Payment Date"]);

    for (const row of rows.slice(headerIndex + 1)) {
      if (salesTypeIndex >= 0 && !normalizedHeader(rowValue(row, salesTypeIndex)).includes("package")) continue;
      if (isResidualPackage(rowValue(row, packageIndex))) continue;

      const packageHours = moneyValue(rowValue(row, hoursIndex));
      const revenueThb = moneyValue(rowValue(row, revenueIndex));
      const studentCount = moneyValue(rowValue(row, studentCountIndex)) || 1;
      const paid = paidIndex < 0 || paidValue(rowValue(row, paidIndex)) || present(rowValue(row, paymentDateIndex));
      if (!paid || packageHours <= 0 || revenueThb <= 0) continue;

      sales.push({
        packageHours,
        revenueThb,
        studentCount,
        sourceLabel: fileLabel,
      });
    }
  }

  return sales;
}

function loadPackageSales(salesDir: string): RawPackageSaleAggregate[] {
  if (!fs.existsSync(salesDir)) return [];
  return listSalesRecordFiles(salesDir).flatMap((file) => packageSalesFromWorkbook(path.join(salesDir, file)));
}

async function ensurePackageMixForRun(modelRunId: string, projectionPath: string): Promise<number> {
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.roomCapacityPackageMix.id })
    .from(schema.roomCapacityPackageMix)
    .where(eq(schema.roomCapacityPackageMix.modelRunId, modelRunId))
    .limit(1);
  if (existing) return 0;

  const salesDir = salesRecordDirForProjection(projectionPath);
  const sales = loadPackageSales(salesDir);
  const packageMix = buildPackageMixFromSales(sales);
  if (packageMix.length === 0) return 0;

  await db.insert(schema.roomCapacityPackageMix).values(
    packageMix.map((row) => ({
      modelRunId,
      packageHourBucket: row.packageHourBucket,
      packageHours: row.packageHours,
      averageRevenueThb: row.averageRevenueThb,
      share: row.share,
      observedSaleCount: row.observedSaleCount,
      observedStudentCount: row.observedStudentCount,
      sourceLabel: row.sourceLabel,
    })),
  );
  return packageMix.length;
}

async function loadActiveSnapshotSessions(startDate: string, endDate: string): Promise<RoomCapacitySession[]> {
  const db = getDb();
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);
  if (!activeSnapshot) throw new Error("No active Wise snapshot found");

  const start = bangkokDateStartUtc(startDate);
  const end = bangkokDateStartUtc(addBangkokDays(endDate, 1));
  const rows = await db
    .select({
      id: schema.futureSessionBlocks.id,
      groupId: schema.futureSessionBlocks.groupId,
      tutorDisplayName: schema.tutorIdentityGroups.displayName,
      wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId,
      wiseTeacherUserId: schema.futureSessionBlocks.wiseTeacherUserId,
      wiseSessionId: schema.futureSessionBlocks.wiseSessionId,
      wiseClassId: schema.futureSessionBlocks.wiseClassId,
      startTime: schema.futureSessionBlocks.startTime,
      endTime: schema.futureSessionBlocks.endTime,
      weekday: schema.futureSessionBlocks.weekday,
      startMinute: schema.futureSessionBlocks.startMinute,
      endMinute: schema.futureSessionBlocks.endMinute,
      wiseStatus: schema.futureSessionBlocks.wiseStatus,
      sessionType: schema.futureSessionBlocks.sessionType,
      currentWiseLocation: schema.futureSessionBlocks.location,
      studentCount: schema.futureSessionBlocks.studentCount,
      subject: schema.futureSessionBlocks.subject,
      classType: schema.futureSessionBlocks.classType,
      title: schema.futureSessionBlocks.title,
    })
    .from(schema.futureSessionBlocks)
    .innerJoin(schema.tutorIdentityGroups, eq(schema.futureSessionBlocks.groupId, schema.tutorIdentityGroups.id))
    .where(
      and(
        eq(schema.futureSessionBlocks.snapshotId, activeSnapshot.id),
        eq(schema.futureSessionBlocks.isBlocking, true),
        gte(schema.futureSessionBlocks.startTime, start),
        lt(schema.futureSessionBlocks.startTime, end),
      ),
    );

  return rows.map((row) => ({
    ...row,
    startTime: new Date(row.startTime),
    endTime: new Date(row.endTime),
    date: bangkokDateKey(new Date(row.startTime)),
    wiseTeacherUserId: row.wiseTeacherUserId ?? null,
    wiseClassId: row.wiseClassId ?? null,
    sessionType: row.sessionType ?? null,
    currentWiseLocation: row.currentWiseLocation ?? null,
    studentCount: row.studentCount ?? null,
    subject: row.subject ?? null,
    classType: row.classType ?? null,
    title: row.title ?? null,
  }));
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error("Usage: npx tsx scripts/import-room-capacity-model.ts /path/to/projection_data.json");
  }

  const absolutePath = path.resolve(sourcePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const payload = JSON.parse(raw) as ProjectionPayload;
  if (!payload.forecast_start || !payload.forecast_end) {
    throw new Error("Projection JSON must include forecast_start and forecast_end");
  }

  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.roomCapacityModelRuns.id })
    .from(schema.roomCapacityModelRuns)
    .where(eq(schema.roomCapacityModelRuns.sourceFingerprint, fingerprint))
    .limit(1);
  if (existing) {
    const insertedPackageMixRows = await ensurePackageMixForRun(existing.id, absolutePath);
    console.log(`Model run already imported: ${existing.id}`);
    if (insertedPackageMixRows > 0) console.log(`Backfilled package mix rows: ${insertedPackageMixRows}`);
    return;
  }

  const [run] = await db
    .insert(schema.roomCapacityModelRuns)
    .values({
      sourceLabel: payload.title || path.basename(absolutePath),
      sourceFingerprint: fingerprint,
      forecastStart: payload.forecast_start,
      forecastEnd: payload.forecast_end,
      metadata: {
        ...(payload.metadata ?? {}),
        sourceFile: path.basename(absolutePath),
      },
      createdBy: process.env.USER ?? null,
    })
    .returning();

  const driverRows = (payload.forecast_source ?? []).map((row) => ({
    modelRunId: run.id,
    scenario: String(row.scenario ?? "Base"),
    month: String(row.month),
    leads: numberValue(row.leads),
    leadToPaidConversion: numberValue(row.lead_to_paid_conversion),
    newPaidStudents: numberValue(row.new_paid_students),
    activeBasePriorMonth: numberValue(row.active_base_prior_month),
    projectedRevenueThb: numberValue(row.projected_revenue_thb),
    uncappedRevenueThb: numberValue(row.uncapped_revenue_thb),
    forecastConsumedHours: numberValue(row.forecast_consumed_hours),
    scheduledHours: numberValue(row.scheduled_hours),
    teacherCapacityHours: numberValue(row.teacher_capacity_hours),
    capacityUtilizationPct: numberValue(row.capacity_utilization_pct),
    capacityExceeded: booleanValue(row.capacity_exceeded),
    seasonalityIndex: numberValue(row.seasonality_index) || 1,
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.month));

  if (driverRows.length > 0) {
    await db.insert(schema.roomCapacityForecastDrivers).values(driverRows);
  }

  const demandSourceEnd = endOfBangkokMonth(payload.forecast_start);
  const sessions = await loadActiveSnapshotSessions(payload.forecast_start, demandSourceEnd);
  const demandMix = buildDemandMixFromSessions(sessions).slice(0, 120);
  if (demandMix.length > 0) {
    await db.insert(schema.roomCapacityDemandMix).values(
      demandMix.map((row) => ({
        modelRunId: run.id,
        weekday: row.weekday,
        startMinute: row.startMinute,
        durationMinutes: row.durationMinutes,
        mode: row.mode,
        studentCount: row.studentCount,
        subject: row.subject,
        classType: row.classType,
        share: row.share,
        observedSessions: row.observedSessions,
      })),
    );
  }

  const packageMixRows = await ensurePackageMixForRun(run.id, absolutePath);

  console.log(`Imported room capacity model run ${run.id}`);
  console.log(`Forecast drivers: ${driverRows.length}`);
  console.log(`Demand mix rows: ${demandMix.length}`);
  console.log(`Package mix rows: ${packageMixRows}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
