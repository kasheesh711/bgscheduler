import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

import { parseUnearnedRevenueWorkbook, type ParsedWorkbookContract } from "./workbook";
import type { TraceAnchor } from "./types";

const driveId = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const file = z.object({ fileId: driveId, sha256: hash, bytes: z.number().int().positive().max(30_000_000) });
export const publicationManifestSchema = z.object({
  schemaVersion: z.literal(5), runId: z.string().min(1), cutoff: date,
  sourceFingerprint: hash, revision: z.string().min(1), generatedAtBangkok: z.string().datetime({ offset: true }),
  canonicalModel: z.string(), modelVersion: z.literal("FIFO_PACKAGE_LOT_V4"),
  contract: file, audit: file, folderId: driveId, rollbackSpreadsheetId: driveId,
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  qa: z.object({ hardStatus: z.literal("PASS"), dailyCount: z.number().int().positive(),
    creditTolerance: z.literal(0.001), moneyTolerance: z.literal(1), checks: z.array(z.string()).min(1) }),
  months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), from: date, to: date,
    spreadsheetId: driveId, cells: z.number().int().positive().max(2_000_000),
    sha256: hash, overviewSheetId: z.number().int().nonnegative(),
    studentSheetId: z.number().int().nonnegative(), packageSheetId: z.number().int().nonnegative(),
  })).min(1),
});
export type PublicationManifest = z.infer<typeof publicationManifestSchema>;
export interface PublicationMetadata extends PublicationManifest {
  traces: Record<string, TraceAnchor>;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifiedFile(bytes: Buffer, expected: { bytes: number; sha256: string }): Buffer {
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error("Published file size or checksum does not match its manifest");
  }
  return bytes;
}

export function statusFields(rows: unknown[][]): Record<string, string> {
  return Object.fromEntries(rows.slice(1).filter(row => row.length >= 2).map(row => [String(row[0]), String(row[1] ?? "")]));
}

const requiredTables = ["Model Status", "QA Checks", "Model Comparison", "CALC_Student_Period", "CALC_Account_Period", "CALC_Package_Lot_Period", "CALC_Exact_Package_Overview", "SRC_Wise_Receipt"] as const;
const tableSchema = z.array(z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))).max(100_002);
const evidenceSchema = z.object({
  url: z.string().url().refine(url => /^https:\/\/(docs|drive)\.google\.com\//.test(url), "Evidence must link to Google Drive or Sheets"),
  kind: z.enum(["published", "audit"]), spreadsheetId: z.string().optional(), sheetId: z.number().int().optional(),
  row: z.number().int().positive().optional(), a1: z.string().optional(), label: z.string().optional(),
});

export function parseValuesPublication(input: {
  manifest: unknown; contractBytes: Buffer; statusStart: unknown[][]; statusEnd: unknown[][];
}): { contract: ParsedWorkbookContract; metadata: PublicationMetadata } {
  const manifest = publicationManifestSchema.parse(input.manifest);
  const startFields = statusFields(input.statusStart);
  const endFields = statusFields(input.statusEnd);
  for (const key of ["manifest_file_id", "manifest_sha256"]) if (startFields[key] !== endFields[key]) throw new Error(`Publication marker changed during import: ${key}`);
  for (const rows of [input.statusStart, input.statusEnd]) {
    const status = statusFields(rows);
    for (const [key, expected] of Object.entries({ workbook_schema_version: "5", run_id: manifest.runId,
      published_cutoff: manifest.cutoff, source_fingerprint: manifest.sourceFingerprint,
      publication_revision: manifest.revision, canonical_model: manifest.canonicalModel,
      candidate_model_version: manifest.modelVersion, evidence_format: "VALIDATED_VALUES" })) {
      if (status[key] !== expected) throw new Error(`Publication manifest/status mismatch: ${key}`);
    }
  }
  const compressed = verifiedFile(input.contractBytes, manifest.contract);
  const decoded = gunzipSync(compressed, { maxOutputLength: 100_000_000 });
  const payload = z.object({ tables: z.record(z.string(), tableSchema), traces: z.record(z.string(), evidenceSchema) }).parse(JSON.parse(decoded.toString("utf8")));
  for (const name of requiredTables) if (!payload.tables[name]) throw new Error(`Published contract missing ${name}`);
  for (const [name, rows] of Object.entries(payload.tables)) {
    if (manifest.rowCounts[name] !== rows.length - 1) throw new Error(`Published row count mismatch: ${name}`);
  }
  let nextDay = "2026-03-01";
  for (const month of manifest.months) {
    if (month.from !== nextDay || month.from > month.to || !month.from.startsWith(month.month) || !month.to.startsWith(month.month)) throw new Error("Missing, overlapping, or out-of-order daily report coverage");
    nextDay = new Date(Date.parse(month.to + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  }
  if (manifest.months.at(-1)?.to !== manifest.cutoff || manifest.qa.dailyCount !== (Date.parse(nextDay) - Date.parse("2026-03-01")) / 86_400_000) throw new Error("Daily report coverage does not reach the published cutoff");
  const artifactStatus = statusFields(payload.tables["Model Status"]);
  const liveStatus = statusFields(input.statusStart);
  for (const [key, value] of Object.entries(artifactStatus)) {
    if (liveStatus[key] !== value) throw new Error(`Published contract/status mismatch: ${key}`);
  }
  const t = payload.tables;
  const contract = parseUnearnedRevenueWorkbook({
    statusStart: input.statusStart, statusEnd: input.statusEnd, qa: t["QA Checks"],
    periods: t["Model Comparison"], periodFormulas: [], students: t["CALC_Student_Period"], studentFormulas: [],
    accounts: t["CALC_Account_Period"], accountFormulas: [], lots: t["CALC_Package_Lot_Period"], lotFormulas: [],
    exactPackages: t["CALC_Exact_Package_Overview"], exactPackageFormulas: [], receipts: t["SRC_Wise_Receipt"],
    verifiedValues: true,
  });
  const qa = t["QA Checks"];
  const checkId = qa[0].indexOf("check_id");
  const checkStatus = qa[0].indexOf("status");
  const passed = new Set(qa.slice(1).filter(row => row[checkStatus] === "PASS").map(row => row[checkId]));
  for (const id of ["QA-MODEL-001", "QA-MODEL-002", "QA-LOT-001", "QA-LOT-002", "QA-LOT-003", "QA-LOT-004", "QA-LOT-005", "QA-LOT-006", "QA-DAILY-CREDITS", "QA-DAILY-PERIODS", "QA-DAILY-STUDENTS"]) {
    if (!passed.has(id)) throw new Error(`Required values-publication QA missing: ${id}`);
    if (!manifest.qa.checks.includes(id)) throw new Error(`Manifest QA missing: ${id}`);
  }
  // Validate every student and account, rather than accepting offsetting errors
  // that happen to leave the institute-wide total unchanged.
  const studentTotals = new Map<string, number>();
  const accountLots = new Map<string, number>();
  for (const lot of contract.lots) {
    const key = `${lot.periodEnd}:${lot.accountId}`;
    accountLots.set(key, (accountLots.get(key) ?? 0) + Number(lot.closingLiabilityThb));
  }
  for (const account of contract.accounts) {
    const key = `${account.periodEnd}:${account.studentId}`;
    studentTotals.set(key, (studentTotals.get(key) ?? 0) + Number(account.canonicalClosingLiabilityThb));
    if (Math.abs((accountLots.get(`${account.periodEnd}:${account.accountId}`) ?? 0) - Number(account.fifoClosingLiabilityThb)) > 1) throw new Error("Published account/lot balance mismatch");
  }
  for (const student of contract.students) {
    if (Math.abs((studentTotals.get(`${student.periodEnd}:${student.studentId}`) ?? 0) - Number(student.canonicalClosingLiabilityThb)) > 1) throw new Error("Published student/account balance mismatch");
  }
  return { contract, metadata: { ...manifest, traces: payload.traces } };
}
