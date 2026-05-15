import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { buildDemandMixFromSessions } from "@/lib/room-capacity/analysis";
import { addBangkokDays, bangkokDateKey, bangkokDateStartUtc, endOfBangkokMonth } from "@/lib/room-capacity/dates";
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
    console.log(`Model run already imported: ${existing.id}`);
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

  console.log(`Imported room capacity model run ${run.id}`);
  console.log(`Forecast drivers: ${driverRows.length}`);
  console.log(`Demand mix rows: ${demandMix.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
