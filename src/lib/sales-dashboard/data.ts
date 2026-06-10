import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_SALES_SOURCES } from "./default-sources";
import { buildSalesDashboardPayload } from "./analytics";
import {
  buildSalesDimensions,
  sortSlimTransactions,
  toSlimAdditionalTransaction,
  toSlimTransaction,
} from "./dimensions";
import {
  currentBangkokMonthStart,
  labelForMonth,
  monthStartFromMonthKey,
} from "./dates";
import { getGoogleTokenStatus } from "./google-oauth";
import {
  DEFAULT_PROJECTION_CALC_MULTI_SHEET,
  DEFAULT_PROJECTION_SPREADSHEET_URL,
  DEFAULT_PROJECTION_SUMMARY_SHEET,
  DEFAULT_PROJECTION_WHAT_IF_SHEET,
  parseSalesProjectionWorkbook,
} from "./projection";
import {
  DEFAULT_ADDITIONAL_SHEET,
  DEFAULT_NORMAL_SHEET,
  LEGACY_NORMAL_SHEET,
  extractSpreadsheetId,
  parseAdditionalSalesRows,
  parseNormalSalesRows,
} from "./parser";
import { fetchGoogleSheetRows, listGoogleSheetTitles } from "./sheets";
import {
  shouldAutoFinalizePreviousMonth,
  sourceShouldRefresh,
  statusAfterSuccessfulImport,
} from "./lifecycle";
import {
  acquireSalesImportRun,
  failStaleSalesDashboardImports,
  type SalesDashboardImportOutcome,
} from "./import-guard";
import type {
  ParsedAdditionalSaleRow,
  ParsedNormalSaleRow,
  ParsedSalesProjectionWorkbook,
  SalesDashboardSourceRecord,
  SalesDashboardSourceSummary,
  SalesDashboardProjectionPayload,
  SalesDashboardProjectionSourceRecord,
  SalesDashboardProjectionSourceSummary,
  SalesDimensionsPayload,
  SalesImportTrigger,
  SalesProjectionMonthRecord,
  SalesProjectionScenarioSummary,
  SlimTransaction,
} from "./types";

export const SALES_DASHBOARD_CACHE_TAG = "sales-dashboard";

interface SourceInput {
  spreadsheetUrl: string;
  sourceMonth: string;
  label?: string | null;
  normalSheetName?: string | null;
  additionalSheetName?: string | null;
  connectedEmail: string;
  actorEmail: string;
}

interface ProjectionSourceInput {
  spreadsheetUrl: string;
  summarySheetName?: string | null;
  whatIfSheetName?: string | null;
  calcMultiSheetName?: string | null;
  connectedEmail: string;
  actorEmail: string;
}

interface ImportOptions {
  triggerType: SalesImportTrigger;
  actorEmail: string;
  allowFinalized?: boolean;
  now?: Date;
}

function asSourceRecord(row: typeof schema.salesDashboardSources.$inferSelect): SalesDashboardSourceRecord {
  return row as SalesDashboardSourceRecord;
}

function asProjectionSourceRecord(row: typeof schema.salesDashboardProjectionSources.$inferSelect): SalesDashboardProjectionSourceRecord {
  return row as SalesDashboardProjectionSourceRecord;
}

function revalidateSalesDashboardCache() {
  try {
    revalidateTag(SALES_DASHBOARD_CACHE_TAG, "max");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("static generation store missing")) throw error;
  }
}

function toProjectionSummary(source: SalesDashboardProjectionSourceRecord): SalesDashboardProjectionSourceSummary {
  return {
    id: source.id,
    spreadsheetId: source.spreadsheetId,
    spreadsheetUrl: source.spreadsheetUrl,
    summarySheetName: source.summarySheetName,
    whatIfSheetName: source.whatIfSheetName,
    calcMultiSheetName: source.calcMultiSheetName,
    status: source.status,
    lastImportedAt: source.lastImportedAt?.toISOString() ?? null,
    lastImportError: source.lastImportError,
    lastProjectionMonthCount: source.lastProjectionMonthCount,
    lastTargetMonthlyRevenue: source.lastTargetMonthlyRevenue,
    connectedEmail: source.connectedEmail,
  };
}

function toSummary(source: SalesDashboardSourceRecord): SalesDashboardSourceSummary {
  return {
    id: source.id,
    sourceMonth: source.sourceMonth,
    label: source.label,
    spreadsheetId: source.spreadsheetId,
    spreadsheetUrl: source.spreadsheetUrl,
    normalSheetName: source.normalSheetName,
    additionalSheetName: source.additionalSheetName,
    status: source.status,
    lastImportedAt: source.lastImportedAt?.toISOString() ?? null,
    lastImportError: source.lastImportError,
    lastNormalRowCount: source.lastNormalRowCount,
    lastAdditionalRowCount: source.lastAdditionalRowCount,
    connectedEmail: source.connectedEmail,
    archivedAt: source.archivedAt?.toISOString() ?? null,
    archivedByEmail: source.archivedByEmail,
    statusBeforeArchive: source.statusBeforeArchive,
  };
}

function sourceUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function chooseSheetName(titles: string[], preferred: string | null, fallbacks: string[]): string | null {
  if (preferred && titles.includes(preferred)) return preferred;
  return fallbacks.find((fallback) => titles.includes(fallback)) ?? null;
}

async function insertChunks<T extends Record<string, unknown>>(
  db: Database,
  table: Parameters<Database["insert"]>[0],
  rows: T[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (chunk.length > 0) await db.insert(table).values(chunk as never);
  }
}

export async function listSalesDashboardSources(
  db: Database = getDb(),
  options: { includeArchived?: boolean } = {},
): Promise<SalesDashboardSourceRecord[]> {
  const rows = options.includeArchived
    ? await db
      .select()
      .from(schema.salesDashboardSources)
      .orderBy(schema.salesDashboardSources.sourceMonth)
    : await db
      .select()
      .from(schema.salesDashboardSources)
      .where(sql`${schema.salesDashboardSources.status}::text <> 'archived'`)
      .orderBy(schema.salesDashboardSources.sourceMonth);
  return rows.map(asSourceRecord);
}

export async function upsertSalesDashboardSource(input: SourceInput, db: Database = getDb()) {
  const spreadsheetId = extractSpreadsheetId(input.spreadsheetUrl);
  const sourceMonth = monthStartFromMonthKey(input.sourceMonth.slice(0, 7));
  const label = input.label?.trim() || labelForMonth(sourceMonth);
  const now = new Date();
  const [row] = await db
    .insert(schema.salesDashboardSources)
    .values({
      sourceMonth,
      label,
      spreadsheetId,
      spreadsheetUrl: input.spreadsheetUrl.trim() || sourceUrl(spreadsheetId),
      normalSheetName: input.normalSheetName?.trim() || null,
      additionalSheetName: input.additionalSheetName?.trim() || null,
      connectedEmail: input.connectedEmail.trim().toLowerCase(),
      createdByEmail: input.actorEmail.trim().toLowerCase(),
      updatedByEmail: input.actorEmail.trim().toLowerCase(),
      status: sourceMonth === currentBangkokMonthStart(now) ? "active" : "active",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.salesDashboardSources.sourceMonth,
      targetWhere: sql`${schema.salesDashboardSources.archivedAt} IS NULL`,
      set: {
        label,
        spreadsheetId,
        spreadsheetUrl: input.spreadsheetUrl.trim() || sourceUrl(spreadsheetId),
        normalSheetName: input.normalSheetName?.trim() || null,
        additionalSheetName: input.additionalSheetName?.trim() || null,
        connectedEmail: input.connectedEmail.trim().toLowerCase(),
        updatedByEmail: input.actorEmail.trim().toLowerCase(),
        updatedAt: now,
      },
    })
    .returning();
  revalidateSalesDashboardCache();
  return asSourceRecord(row);
}

export async function seedDefaultSalesSources(actorEmail: string, connectedEmail = actorEmail, db: Database = getDb()) {
  const seeded: SalesDashboardSourceRecord[] = [];
  for (const source of DEFAULT_SALES_SOURCES) {
    seeded.push(await upsertSalesDashboardSource({
      spreadsheetUrl: sourceUrl(source.id),
      sourceMonth: source.month,
      label: source.label,
      normalSheetName: "normalSheetName" in source ? source.normalSheetName : null,
      additionalSheetName: null,
      connectedEmail,
      actorEmail,
    }, db));
  }
  return seeded;
}

export async function getActiveSalesDashboardProjectionSource(db: Database = getDb()): Promise<SalesDashboardProjectionSourceRecord | null> {
  const [row] = await db
    .select()
    .from(schema.salesDashboardProjectionSources)
    .where(eq(schema.salesDashboardProjectionSources.status, "active"))
    .limit(1);
  return row ? asProjectionSourceRecord(row) : null;
}

export async function upsertSalesDashboardProjectionSource(input: ProjectionSourceInput, db: Database = getDb()) {
  const spreadsheetId = extractSpreadsheetId(input.spreadsheetUrl);
  const now = new Date();
  const existing = await getActiveSalesDashboardProjectionSource(db);
  const values = {
    spreadsheetId,
    spreadsheetUrl: input.spreadsheetUrl.trim() || sourceUrl(spreadsheetId),
    summarySheetName: input.summarySheetName?.trim() || DEFAULT_PROJECTION_SUMMARY_SHEET,
    whatIfSheetName: input.whatIfSheetName?.trim() || DEFAULT_PROJECTION_WHAT_IF_SHEET,
    calcMultiSheetName: input.calcMultiSheetName?.trim() || DEFAULT_PROJECTION_CALC_MULTI_SHEET,
    connectedEmail: input.connectedEmail.trim().toLowerCase(),
    updatedByEmail: input.actorEmail.trim().toLowerCase(),
    updatedAt: now,
  };

  const [row] = existing
    ? await db
      .update(schema.salesDashboardProjectionSources)
      .set({
        ...values,
        lastImportError: null,
      })
      .where(eq(schema.salesDashboardProjectionSources.id, existing.id))
      .returning()
    : await db
      .insert(schema.salesDashboardProjectionSources)
      .values({
        ...values,
        status: "active",
        createdByEmail: input.actorEmail.trim().toLowerCase(),
      })
      .returning();

  revalidateSalesDashboardCache();
  return asProjectionSourceRecord(row);
}

export async function seedDefaultSalesDashboardProjectionSource(actorEmail: string, connectedEmail = actorEmail, db: Database = getDb()) {
  return upsertSalesDashboardProjectionSource({
    spreadsheetUrl: DEFAULT_PROJECTION_SPREADSHEET_URL,
    summarySheetName: DEFAULT_PROJECTION_SUMMARY_SHEET,
    whatIfSheetName: DEFAULT_PROJECTION_WHAT_IF_SHEET,
    calcMultiSheetName: DEFAULT_PROJECTION_CALC_MULTI_SHEET,
    connectedEmail,
    actorEmail,
  }, db);
}

export async function updateSalesDashboardSourceStatus(
  id: string,
  status: "active" | "finalized" | "reopened",
  actorEmail: string,
  db: Database = getDb(),
) {
  const now = new Date();
  const source = await getSource(id, db);
  if (!source) return null;
  if (source.status === "archived") {
    if (status !== "active") {
      throw new Error("Restore archived source before changing its status.");
    }
    return restoreSalesDashboardSource(id, actorEmail, db);
  }

  const [row] = await db
    .update(schema.salesDashboardSources)
    .set({
      status,
      finalizedAt: status === "finalized" ? now : null,
      reopenedAt: status === "reopened" ? now : null,
      archivedAt: null,
      archivedByEmail: null,
      statusBeforeArchive: null,
      updatedAt: now,
      updatedByEmail: actorEmail,
    })
    .where(eq(schema.salesDashboardSources.id, id))
    .returning();
  revalidateSalesDashboardCache();
  return row ? asSourceRecord(row) : null;
}

export async function archiveSalesDashboardSource(
  id: string,
  actorEmail: string,
  db: Database = getDb(),
): Promise<SalesDashboardSourceRecord | null> {
  const source = await getSource(id, db);
  if (!source) return null;
  if (source.status === "archived") return source;
  if (source.status === "refreshing") {
    throw new Error("Source is refreshing. Wait for the import to finish before archiving it.");
  }

  const now = new Date();
  const [row] = await db
    .update(schema.salesDashboardSources)
    .set({
      status: "archived",
      archivedAt: now,
      archivedByEmail: actorEmail,
      statusBeforeArchive: source.status,
      updatedAt: now,
      updatedByEmail: actorEmail,
    })
    .where(eq(schema.salesDashboardSources.id, id))
    .returning();
  revalidateSalesDashboardCache();
  return row ? asSourceRecord(row) : null;
}

export async function restoreSalesDashboardSource(
  id: string,
  actorEmail: string,
  db: Database = getDb(),
): Promise<SalesDashboardSourceRecord | null> {
  const source = await getSource(id, db);
  if (!source) return null;
  if (source.status !== "archived") return source;

  const [existingMonthSource] = await db
    .select({ id: schema.salesDashboardSources.id })
    .from(schema.salesDashboardSources)
    .where(and(
      eq(schema.salesDashboardSources.sourceMonth, source.sourceMonth),
      ne(schema.salesDashboardSources.id, source.id),
      sql`${schema.salesDashboardSources.archivedAt} IS NULL`,
    ))
    .limit(1);
  if (existingMonthSource) {
    throw new Error("Another active source already exists for this month. Archive it before restoring this source.");
  }

  const now = new Date();
  const restoredStatus = source.statusBeforeArchive && !["archived", "refreshing"].includes(source.statusBeforeArchive)
    ? source.statusBeforeArchive
    : "active";
  const [row] = await db
    .update(schema.salesDashboardSources)
    .set({
      status: restoredStatus,
      archivedAt: null,
      archivedByEmail: null,
      statusBeforeArchive: null,
      updatedAt: now,
      updatedByEmail: actorEmail,
    })
    .where(eq(schema.salesDashboardSources.id, id))
    .returning();
  revalidateSalesDashboardCache();
  return row ? asSourceRecord(row) : null;
}

async function getSource(id: string, db: Database): Promise<SalesDashboardSourceRecord | null> {
  const [source] = await db
    .select()
    .from(schema.salesDashboardSources)
    .where(eq(schema.salesDashboardSources.id, id))
    .limit(1);
  return source ? asSourceRecord(source) : null;
}

async function getSourceOrThrow(sourceId: string, db: Database): Promise<SalesDashboardSourceRecord> {
  const source = await getSource(sourceId, db);
  if (!source) throw new Error("Sales dashboard source not found");
  if (source.status === "archived") throw new Error("Sales dashboard source is archived. Restore it before importing.");
  return source;
}

export async function importSalesDashboardSource(
  sourceId: string,
  options: ImportOptions,
  db: Database = getDb(),
): Promise<SalesDashboardImportOutcome> {
  let source = await getSourceOrThrow(sourceId, db);
  const now = options.now ?? new Date();
  const staleRunningImportsFailed = await failStaleSalesDashboardImports(db, source.id, now);
  if (staleRunningImportsFailed > 0) {
    source = await getSourceOrThrow(sourceId, db);
  }

  if (source.status === "finalized" && !options.allowFinalized) {
    throw new Error("Source is finalized. Reopen or confirm manual refresh first.");
  }
  const previousStatus = source.status === "refreshing" ? "active" : source.status;

  const guard = await acquireSalesImportRun(db, {
    sourceId: source.id,
    sourceLabel: source.label,
    previousStatus,
    triggerType: options.triggerType,
    actorEmail: options.actorEmail,
    now,
    staleRunningImportsFailed,
  });

  if (guard.skipped) {
    return guard;
  }

  if (source.status === "finalized" && !options.allowFinalized) {
    await db
      .update(schema.salesDashboardImportRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorSummary: "Source is finalized. Reopen or confirm manual refresh first.",
      })
      .where(eq(schema.salesDashboardImportRuns.id, guard.runId));
    throw new Error("Source is finalized. Reopen or confirm manual refresh first.");
  }

  const run = { id: guard.runId };

  await db
    .update(schema.salesDashboardSources)
    .set({ status: "refreshing", lastImportError: null, updatedAt: now })
    .where(eq(schema.salesDashboardSources.id, source.id));

  try {
    const titles = await listGoogleSheetTitles(source.connectedEmail, source.spreadsheetId);
    const resolvedNormalSheet = chooseSheetName(
      titles,
      source.normalSheetName,
      [DEFAULT_NORMAL_SHEET, LEGACY_NORMAL_SHEET],
    );
    if (!resolvedNormalSheet) throw new Error("No normal sales sheet found");
    const resolvedAdditionalSheet = chooseSheetName(titles, source.additionalSheetName, [DEFAULT_ADDITIONAL_SHEET]);

    const [normalRowsRaw, additionalRowsRaw] = await Promise.all([
      fetchGoogleSheetRows(source.connectedEmail, source.spreadsheetId, resolvedNormalSheet),
      resolvedAdditionalSheet
        ? fetchGoogleSheetRows(source.connectedEmail, source.spreadsheetId, resolvedAdditionalSheet)
        : Promise.resolve([]),
    ]);

    const parseContext = { sourceMonth: source.sourceMonth, sourceLabel: source.label, today: now };
    const normalRows = parseNormalSalesRows(normalRowsRaw, parseContext);
    const additionalRows = parseAdditionalSalesRows(additionalRowsRaw, parseContext);

    await insertChunks(db, schema.salesDashboardNormalRows, normalRows.map((row) => ({
      sourceId: source.id,
      importRunId: run.id,
      sourceMonth: row.sourceMonth,
      rowNumber: row.rowNumber,
      studentNickname: row.studentNickname,
      program: row.program,
      packageHours: row.packageHours,
      numberOfStudents: row.numberOfStudents,
      paymentAmount: row.paymentAmount,
      salesRepresentative: row.salesRepresentative,
      paymentDate: row.paymentDate,
      enrollmentType: row.enrollmentType,
      programWiseName: row.programWiseName,
      packageHoursClean: row.packageHoursClean,
      validUntil: row.validUntil,
      churnStatus: row.churnStatus,
      raw: row.raw,
    })));
    await insertChunks(db, schema.salesDashboardAdditionalRows, additionalRows.map((row) => ({
      sourceId: source.id,
      importRunId: run.id,
      sourceMonth: row.sourceMonth,
      rowNumber: row.rowNumber,
      studentNickname: row.studentNickname,
      salesType: row.salesType,
      packageName: row.packageName,
      paymentAmount: row.paymentAmount,
      paymentDate: row.paymentDate,
      raw: row.raw,
    })));

    const finalStatus = statusAfterSuccessfulImport(source.sourceMonth, previousStatus, now);
    await db
      .update(schema.salesDashboardImportRuns)
      .set({
        status: "success",
        finishedAt: new Date(),
        normalRowCount: normalRows.length,
        additionalRowCount: additionalRows.length,
        metadata: {
          normalSheetName: resolvedNormalSheet,
          additionalSheetName: resolvedAdditionalSheet,
          availableSheetNames: titles,
        },
      })
      .where(eq(schema.salesDashboardImportRuns.id, run.id));
    await db
      .update(schema.salesDashboardSources)
      .set({
        status: finalStatus,
        lastSuccessfulImportRunId: run.id,
        lastImportedAt: new Date(),
        lastImportError: null,
        lastNormalRowCount: normalRows.length,
        lastAdditionalRowCount: additionalRows.length,
        finalizedAt: finalStatus === "finalized" ? new Date() : source.finalizedAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.salesDashboardSources.id, source.id));
    revalidateSalesDashboardCache();
    return {
      sourceId: source.id,
      runId: run.id,
      normalRows: normalRows.length,
      additionalRows: additionalRows.length,
      staleRunningImportsFailed: guard.staleRunningImportsFailed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales dashboard import failed";
    await db
      .update(schema.salesDashboardImportRuns)
      .set({ status: "failed", finishedAt: new Date(), errorSummary: message })
      .where(eq(schema.salesDashboardImportRuns.id, run.id));
    await db
      .update(schema.salesDashboardSources)
      .set({ status: previousStatus, lastImportError: message, updatedAt: new Date() })
      .where(eq(schema.salesDashboardSources.id, source.id));
    throw error;
  }
}

export async function importRefreshableSalesSources(
  options: ImportOptions,
  db: Database = getDb(),
) {
  const sources = await listSalesDashboardSources(db);
  const now = options.now ?? new Date();
  const results = [];

  for (const source of sources) {
    if (shouldAutoFinalizePreviousMonth(source, now)) {
      await updateSalesDashboardSourceStatus(source.id, "finalized", options.actorEmail, db);
      continue;
    }
    if (!sourceShouldRefresh(source, now)) continue;
    results.push(await importSalesDashboardSource(source.id, { ...options, now }, db));
  }

  return results;
}

export async function importAllSalesSources(
  actorEmail: string,
  db: Database = getDb(),
) {
  const sources = await listSalesDashboardSources(db);
  const results = [];
  for (const source of sources) {
    results.push(await importSalesDashboardSource(source.id, {
      triggerType: "backfill",
      actorEmail,
      allowFinalized: true,
    }, db));
  }
  return results;
}

function requireProjectionSheet(titles: string[], sheetName: string, purpose: string): string {
  if (titles.includes(sheetName)) return sheetName;
  throw new Error(`Projection workbook is missing ${purpose} sheet "${sheetName}"`);
}

async function fetchProjectionWorkbook(source: SalesDashboardProjectionSourceRecord): Promise<ParsedSalesProjectionWorkbook> {
  const titles = await listGoogleSheetTitles(source.connectedEmail, source.spreadsheetId);
  const summarySheetName = requireProjectionSheet(titles, source.summarySheetName, "Summary");
  const whatIfSheetName = requireProjectionSheet(titles, source.whatIfSheetName, "What_If");
  const calcMultiSheetName = requireProjectionSheet(titles, source.calcMultiSheetName, "Calc_Multi");

  const [summaryRows, whatIfRows, calcMultiRows] = await Promise.all([
    fetchGoogleSheetRows(source.connectedEmail, source.spreadsheetId, summarySheetName),
    fetchGoogleSheetRows(source.connectedEmail, source.spreadsheetId, whatIfSheetName),
    fetchGoogleSheetRows(source.connectedEmail, source.spreadsheetId, calcMultiSheetName),
  ]);

  const parsed = parseSalesProjectionWorkbook({ summaryRows, whatIfRows, calcMultiRows });
  return {
    ...parsed,
    metadata: {
      ...parsed.metadata,
      summarySheetName,
      whatIfSheetName,
      calcMultiSheetName,
      availableSheetNames: titles,
    },
  };
}

export async function importSalesDashboardProjectionSource(
  sourceId: string,
  options: ImportOptions,
  db: Database = getDb(),
) {
  const source = await getActiveSalesDashboardProjectionSource(db);
  if (!source || source.id !== sourceId) throw new Error("Sales dashboard projection source not found");
  const now = options.now ?? new Date();
  const [run] = await db
    .insert(schema.salesDashboardProjectionImportRuns)
    .values({
      sourceId: source.id,
      status: "running",
      triggerType: options.triggerType,
      actorEmail: options.actorEmail,
      startedAt: now,
    })
    .returning();

  await db
    .update(schema.salesDashboardProjectionSources)
    .set({ lastImportError: null, updatedAt: now, updatedByEmail: options.actorEmail })
    .where(eq(schema.salesDashboardProjectionSources.id, source.id));

  try {
    const parsed = await fetchProjectionWorkbook(source);
    await insertChunks(db, schema.salesDashboardProjectionMonths, parsed.months.map((row) => ({
      sourceId: source.id,
      importRunId: run.id,
      scenario: row.scenario,
      projectionMonth: row.projectionMonth,
      monthLabel: row.monthLabel,
      monthKind: row.monthKind,
      totalNetRevenue: row.totalNetRevenue,
      renewalRevenue: row.renewalRevenue,
      newStudentRevenue: row.newStudentRevenue,
      trialRevenue: row.trialRevenue,
      activeStudents: row.activeStudents,
      trialBookings: row.trialBookings,
      newStudents: row.newStudents,
      packRenewals: row.packRenewals,
      renewalHours: row.renewalHours,
      newStudentHours: row.newStudentHours,
      trialHours: row.trialHours,
      totalHours: row.totalHours,
      roomCapacity: row.roomCapacity,
      roomUtilization: row.roomUtilization,
    })));

    const finishedAt = new Date();
    await db
      .update(schema.salesDashboardProjectionImportRuns)
      .set({
        status: "success",
        finishedAt,
        monthRowCount: parsed.months.length,
        targetMonthlyRevenue: parsed.targetMonthlyRevenue,
        metadata: parsed.metadata,
      })
      .where(eq(schema.salesDashboardProjectionImportRuns.id, run.id));
    await db
      .update(schema.salesDashboardProjectionSources)
      .set({
        lastSuccessfulImportRunId: run.id,
        lastImportedAt: finishedAt,
        lastImportError: null,
        lastProjectionMonthCount: parsed.months.length,
        lastTargetMonthlyRevenue: parsed.targetMonthlyRevenue,
        updatedAt: finishedAt,
        updatedByEmail: options.actorEmail,
      })
      .where(eq(schema.salesDashboardProjectionSources.id, source.id));

    revalidateSalesDashboardCache();
    return {
      sourceId: source.id,
      runId: run.id,
      projectionMonths: parsed.months.length,
      targetMonthlyRevenue: parsed.targetMonthlyRevenue,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales dashboard projection import failed";
    await db
      .update(schema.salesDashboardProjectionImportRuns)
      .set({ status: "failed", finishedAt: new Date(), errorSummary: message })
      .where(eq(schema.salesDashboardProjectionImportRuns.id, run.id));
    await db
      .update(schema.salesDashboardProjectionSources)
      .set({ lastImportError: message, updatedAt: new Date(), updatedByEmail: options.actorEmail })
      .where(eq(schema.salesDashboardProjectionSources.id, source.id));
    revalidateSalesDashboardCache();
    throw error;
  }
}

export async function importActiveSalesDashboardProjectionSource(
  options: ImportOptions,
  db: Database = getDb(),
) {
  const source = await getActiveSalesDashboardProjectionSource(db);
  if (!source) return null;
  return importSalesDashboardProjectionSource(source.id, options, db);
}

function normalRowFromDb(
  row: typeof schema.salesDashboardNormalRows.$inferSelect,
  source: SalesDashboardSourceRecord,
): ParsedNormalSaleRow {
  return {
    sourceMonth: row.sourceMonth,
    sourceLabel: source.label,
    rowNumber: row.rowNumber,
    studentNickname: row.studentNickname,
    program: row.program,
    packageHours: row.packageHours,
    numberOfStudents: row.numberOfStudents,
    paymentAmount: row.paymentAmount,
    salesRepresentative: row.salesRepresentative,
    paymentDate: row.paymentDate,
    enrollmentType: row.enrollmentType,
    programWiseName: row.programWiseName,
    packageHoursClean: row.packageHoursClean,
    validUntil: row.validUntil,
    churnStatus: row.churnStatus,
    raw: row.raw,
  };
}

function additionalRowFromDb(
  row: typeof schema.salesDashboardAdditionalRows.$inferSelect,
  source: SalesDashboardSourceRecord,
): ParsedAdditionalSaleRow {
  return {
    sourceMonth: row.sourceMonth,
    sourceLabel: source.label,
    rowNumber: row.rowNumber,
    studentNickname: row.studentNickname,
    salesType: row.salesType,
    packageName: row.packageName,
    paymentAmount: row.paymentAmount,
    paymentDate: row.paymentDate,
    raw: row.raw,
  };
}

function projectionMonthFromDb(row: typeof schema.salesDashboardProjectionMonths.$inferSelect): SalesProjectionMonthRecord {
  return {
    scenario: row.scenario as SalesProjectionMonthRecord["scenario"],
    projectionMonth: row.projectionMonth,
    monthLabel: row.monthLabel,
    monthKind: row.monthKind === "actual" ? "actual" : "forecast",
    totalNetRevenue: row.totalNetRevenue,
    renewalRevenue: row.renewalRevenue,
    newStudentRevenue: row.newStudentRevenue,
    trialRevenue: row.trialRevenue,
    activeStudents: row.activeStudents,
    trialBookings: row.trialBookings,
    newStudents: row.newStudents,
    packRenewals: row.packRenewals,
    renewalHours: row.renewalHours,
    newStudentHours: row.newStudentHours,
    trialHours: row.trialHours,
    totalHours: row.totalHours,
    roomCapacity: row.roomCapacity,
    roomUtilization: row.roomUtilization,
  };
}

function scenarioSummariesFromMetadata(metadata: Record<string, unknown>): SalesProjectionScenarioSummary[] {
  const value = metadata.scenarioSummaries;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SalesProjectionScenarioSummary => {
    if (!item || typeof item !== "object") return false;
    const scenario = (item as { scenario?: unknown }).scenario;
    return scenario === "Bear" || scenario === "Base" || scenario === "Bull";
  });
}

async function getSalesDashboardProjectionPayload(db: Database): Promise<SalesDashboardProjectionPayload> {
  const source = await getActiveSalesDashboardProjectionSource(db);
  if (!source) {
    return {
      source: null,
      targetMonthlyRevenue: null,
      targetSource: "fallback",
      scenarioSummaries: [],
      months: [],
      lastImportedAt: null,
      lastImportError: null,
    };
  }

  const runId = source.lastSuccessfulImportRunId;
  const [latestRun, monthRows] = await Promise.all([
    runId
      ? db
        .select()
        .from(schema.salesDashboardProjectionImportRuns)
        .where(eq(schema.salesDashboardProjectionImportRuns.id, runId))
        .limit(1)
      : Promise.resolve([]),
    runId
      ? db
        .select()
        .from(schema.salesDashboardProjectionMonths)
        .where(eq(schema.salesDashboardProjectionMonths.importRunId, runId))
        .orderBy(schema.salesDashboardProjectionMonths.projectionMonth, schema.salesDashboardProjectionMonths.scenario)
      : Promise.resolve([]),
  ]);
  const run = latestRun[0];

  return {
    source: toProjectionSummary(source),
    targetMonthlyRevenue: run?.targetMonthlyRevenue ?? source.lastTargetMonthlyRevenue,
    targetSource: run?.targetMonthlyRevenue || source.lastTargetMonthlyRevenue ? "projection" : "fallback",
    scenarioSummaries: scenarioSummariesFromMetadata(run?.metadata ?? {}),
    months: monthRows.map(projectionMonthFromDb),
    lastImportedAt: source.lastImportedAt?.toISOString() ?? null,
    lastImportError: source.lastImportError,
  };
}

export interface LiveRowData {
  /** All sources, including archived (the landing payload lists them). */
  sources: SalesDashboardSourceRecord[];
  /** Run-id-scoped rows from the active sources' last successful imports. */
  normalRows: ParsedNormalSaleRow[];
  additionalRows: ParsedAdditionalSaleRow[];
}

/**
 * One DB pass loading the live (run-id-scoped) row materialization shared by
 * the landing payload, the dimensions payload, and the slim-transactions
 * endpoint. Rows are scoped to each active source's lastSuccessfulImportRunId
 * so partially imported runs never leak.
 */
export async function loadLiveRowData(db: Database = getDb()): Promise<LiveRowData> {
  const sources = await listSalesDashboardSources(db, { includeArchived: true });
  const activeSources = sources.filter((source) => source.status !== "archived");
  const activeRunIds = activeSources
    .map((source) => source.lastSuccessfulImportRunId)
    .filter((id): id is string => Boolean(id));
  const sourceByRun = new Map(activeSources.map((source) => [source.lastSuccessfulImportRunId, source]));

  const [normalRows, additionalRows] = await Promise.all([
    activeRunIds.length > 0
      ? db.select().from(schema.salesDashboardNormalRows).where(inArray(schema.salesDashboardNormalRows.importRunId, activeRunIds))
      : Promise.resolve([]),
    activeRunIds.length > 0
      ? db.select().from(schema.salesDashboardAdditionalRows).where(inArray(schema.salesDashboardAdditionalRows.importRunId, activeRunIds))
      : Promise.resolve([]),
  ]);

  return {
    sources,
    normalRows: normalRows
      .map((row) => {
        const source = sourceByRun.get(row.importRunId);
        return source ? normalRowFromDb(row, source) : null;
      })
      .filter((row): row is ParsedNormalSaleRow => Boolean(row)),
    additionalRows: additionalRows
      .map((row) => {
        const source = sourceByRun.get(row.importRunId);
        return source ? additionalRowFromDb(row, source) : null;
      })
      .filter((row): row is ParsedAdditionalSaleRow => Boolean(row)),
  };
}

async function getSalesDashboardPayloadUncached(email: string | null | undefined, db: Database = getDb()) {
  const [{ sources, normalRows, additionalRows }, token, projection] = await Promise.all([
    loadLiveRowData(db),
    getGoogleTokenStatus(email, db),
    getSalesDashboardProjectionPayload(db),
  ]);

  return buildSalesDashboardPayload({
    normalRows,
    additionalRows,
    sources: sources.map(toSummary),
    projection,
    token,
  });
}

export async function getSalesDashboardPayload(email: string | null | undefined) {
  "use cache";
  cacheTag(SALES_DASHBOARD_CACHE_TAG);
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  return getSalesDashboardPayloadUncached(email);
}

/**
 * Cached slim-transaction materialization for /api/sales-dashboard/transactions.
 * Serialized exclusively through toSlimTransaction — the raw jsonb column is
 * never exposed. Invalidated by the existing revalidateTag calls on
 * import/source mutations.
 */
export async function getLiveSlimRows(): Promise<SlimTransaction[]> {
  "use cache";
  cacheTag(SALES_DASHBOARD_CACHE_TAG);
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  const { normalRows, additionalRows } = await loadLiveRowData();
  return sortSlimTransactions([
    ...normalRows.map(toSlimTransaction),
    ...additionalRows.map(toSlimAdditionalTransaction),
  ]);
}

/**
 * Cached month-grain dimensions payload for /api/sales-dashboard/dimensions.
 * The landing payload (getSalesDashboardPayload) stays byte-identical; the
 * tabbed workspace fetches this lazily on first non-Overview activation.
 */
export async function getSalesDimensionsPayload(): Promise<SalesDimensionsPayload> {
  "use cache";
  cacheTag(SALES_DASHBOARD_CACHE_TAG);
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  const db = getDb();
  const [{ normalRows, additionalRows }, projection] = await Promise.all([
    loadLiveRowData(db),
    getSalesDashboardProjectionPayload(db),
  ]);
  return buildSalesDimensions({
    normalRows,
    additionalRows,
    projection: {
      targetMonthlyRevenue: projection.targetMonthlyRevenue,
      targetSource: projection.targetSource,
    },
  });
}

export async function listRecentSalesDashboardImportRuns(db: Database = getDb()) {
  return db
    .select()
    .from(schema.salesDashboardImportRuns)
    .orderBy(desc(schema.salesDashboardImportRuns.startedAt))
    .limit(20);
}
