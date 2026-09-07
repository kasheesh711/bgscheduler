import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { parseValuesPublication, publicationManifestSchema, sha256, statusFields, verifiedFile, type PublicationManifest } from "../publication";
import type { TraceAnchor } from "../types";
import { PublicationGoogle, enteredCell, formatRequests, type SheetMetadata } from "./google";
import { allocatedCells, buildReportTabs, filterId, HEAD_ROWS, MAIN_CELL_BUDGET, MAIN_IDS, MONTH_IDS, monthDigest, reportUrl, splitMonth, type MonthData, type ReportBundle, type ReportTab } from "./layout";

const CONTROL_ID = 797927364;
const STATUS_ID = 2000001001;
const baselineColumns = ["account_id", "opening_date", "opening_credit_balance", "opening_paid_credits", "opening_rate_thb", "opening_liability_thb", "bootstrap_run_id", "source_fingerprint", "created_at_bangkok"];
interface PreparedState {
  bundleHash: string; folderId: string; months: PublicationManifest["months"];
  audit?: PublicationManifest["audit"]; contract?: PublicationManifest["contract"];
  manifest?: PublicationManifest; manifestFileId?: string; manifestHash?: string;
}
const driveUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;
const scalarRows = (fields: Record<string, string | number>) => [["field", "value", "notes"], ...Object.entries(fields).map(([key, value]) => [key, value, ""])];
export function validateDailyBundle(bundle: ReportBundle) {
  if (bundle.schemaVersion !== 5 || bundle.status.canonical_model !== "LEGACY_ACCOUNT_RATE") throw new Error("V5 daily publication requires the approved LEGACY_ACCOUNT_RATE model");
  let expected = "2026-03-01";
  let days = 0;
  for (const [month, data] of Object.entries(bundle.reports.months).sort(([a], [b]) => a.localeCompare(b))) {
    const components = new Map<string, number>();
    const students = new Map<string, number>();
    const totals = new Map<string, number>();
    const lotKeys = new Set<string>();
    for (const row of data.packages) {
      const lotKey = `${row.date}:${row.lot_id}`;
      if (lotKeys.has(lotKey) || !Number.isFinite(row.liability_thb) || !row.date.startsWith(month)) throw new Error("Invalid or duplicate daily package");
      lotKeys.add(lotKey);
      const key = `${row.date}:${row.student_id}`;
      components.set(key, (components.get(key) ?? 0) + row.liability_thb);
    }
    for (const row of data.students) {
      const key = `${row.date}:${row.student_id}`;
      if (students.has(key) || !Number.isFinite(row.liability_thb) || row.liability_thb < 0 || !row.date.startsWith(month)) throw new Error("Invalid or duplicate daily student");
      students.set(key, row.liability_thb);
      if (Math.abs(row.liability_thb - (components.get(key) ?? 0)) > 1) throw new Error(`Daily student/package mismatch: ${key}`);
      totals.set(row.date, (totals.get(row.date) ?? 0) + row.liability_thb);
    }
    for (const key of components.keys()) if (!students.has(key)) throw new Error("Orphan daily package");
    const dates = new Set<string>();
    for (const day of data.finance) {
      if (day.date !== expected || !day.date.startsWith(month) || !Number.isFinite(day.liability_thb) || Math.abs(day.liability_thb - (totals.get(day.date) ?? 0)) > 1) throw new Error(`Daily total/date mismatch: ${day.date}`);
      if (day.student_count !== data.students.filter(row => row.date === day.date).length) throw new Error("Daily student count mismatch");
      const overview = bundle.reports.finance[days];
      if (!overview || JSON.stringify(overview) !== JSON.stringify(day)) throw new Error("Overview disagrees with daily report");
      expected = new Date(Date.parse(expected) + 86_400_000).toISOString().slice(0, 10); days++; dates.add(day.date);
    }
    for (const row of data.students) if (!dates.has(row.date)) throw new Error("Orphan daily student date");
  }
  if (bundle.reports.finance.length !== days || bundle.reports.finance.at(-1)?.date !== bundle.status.published_cutoff) throw new Error("Incomplete daily history");
}
export function dateFilterRequests(tabs: ReportTab[], data: MonthData): unknown[] {
  return tabs.slice(1).flatMap((tab, i) => data.finance.map(day => ({ addFilterView: { filter: {
    filterViewId: filterId(day.date, i === 1), title: `${day.date} — ${tab.title}`,
    range: { sheetId: tab.sheetId, startRowIndex: HEAD_ROWS - 1, endRowIndex: tab.rows.length, startColumnIndex: 0, endColumnIndex: tab.widths.length },
    criteria: { "0": { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: day.date }] } } },
  } } })));
}
export function capacityPlan(metadata: SheetMetadata, tabs: ReportTab[]) {
  const cells = tabs.reduce((sum, tab) => sum + tab.rows.length * tab.widths.length, 0);
  const current = metadata.sheets.reduce((sum, sheet) => sum + sheet.properties.gridProperties.rowCount * sheet.properties.gridProperties.columnCount, 0);
  const control = metadata.sheets.find(sheet => sheet.properties.sheetId === CONTROL_ID)?.properties;
  if (!control || control.title !== "Package Control") throw new Error("Original Package Control tab is missing");
  const finalCells = cells + control.gridProperties.rowCount * control.gridProperties.columnCount + 600;
  // Includes the compact temporary tabs and the destination grids before old
  // tabs are removed inside the final atomic request.
  const peakCells = current + 2 * cells;
  if (finalCells >= MAIN_CELL_BUDGET || peakCells >= 10_000_000) throw new Error(`Publication capacity exceeded: final=${finalCells}, temporary peak=${peakCells}`);
  return { finalCells, peakCells };
}
export function buildCommitRequests(metadata: SheetMetadata, tabs: ReportTab[], stages: number[], status: unknown[][], control: unknown[][], pending: Array<Record<string, unknown>>, owner: string): unknown[] {
  capacityPlan(metadata, tabs);
  const requests: unknown[] = [];
  const existing = new Map(metadata.sheets.map(sheet => [sheet.properties.sheetId, sheet]));
  for (const [index, tab] of tabs.entries()) {
    const prior = existing.get(tab.sheetId);
    if (prior && prior.properties.title !== tab.title) throw new Error("Reserved finance sheet ID is already in use");
    const properties = { sheetId: tab.sheetId, title: tab.title, hidden: false, gridProperties: { rowCount: tab.rows.length, columnCount: tab.widths.length, frozenRowCount: HEAD_ROWS, hideGridlines: true } };
    requests.push(prior ? { updateSheetProperties: { properties, fields: "hidden,title,gridProperties" } } : { addSheet: { properties } });
    for (const protection of prior?.protectedRanges ?? []) requests.push({ deleteProtectedRange: { protectedRangeId: protection.protectedRangeId } });
    requests.push({ copyPaste: { source: { sheetId: stages[index], startRowIndex: 0, endRowIndex: tab.rows.length, startColumnIndex: 0, endColumnIndex: tab.widths.length }, destination: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: tab.rows.length, startColumnIndex: 0, endColumnIndex: tab.widths.length }, pasteType: "PASTE_NORMAL" } });
    requests.push(...formatRequests(tab, owner));
  }
  const keep = new Set<number>([...MAIN_IDS, CONTROL_ID, STATUS_ID]);
  for (const sheet of metadata.sheets) if (!keep.has(sheet.properties.sheetId)) requests.push({ deleteSheet: { sheetId: sheet.properties.sheetId } });
  for (const id of stages) if (!existing.has(id)) requests.push({ deleteSheet: { sheetId: id } });
  for (const [index, id] of MAIN_IDS.entries()) requests.push({ updateSheetProperties: { properties: { sheetId: id, index }, fields: "index" } });
  for (const id of [CONTROL_ID, STATUS_ID]) requests.push({ updateSheetProperties: { properties: { sheetId: id, hidden: true }, fields: "hidden" } });
  requests.push({ updateSheetProperties: { properties: { sheetId: STATUS_ID, gridProperties: { rowCount: 200, columnCount: 3 } }, fields: "gridProperties(rowCount,columnCount)" } });
  requests.push({ updateCells: { range: { sheetId: STATUS_ID, startRowIndex: 0, endRowIndex: 200, startColumnIndex: 0, endColumnIndex: 3 }, rows: status.map(row => ({ values: row.map(value => enteredCell(value as string | number)) })), fields: "userEnteredValue" } });
  const ids = new Set(control.slice(1).map(row => String(row[10] ?? "")).filter(Boolean));
  const additions = pending.filter(row => !ids.has(String(row.account_id)));
  let last = 0;
  control.forEach((row, index) => { if (row[10]) last = index; });
  if (last + additions.length >= 20_000) throw new Error("Opening baseline capacity exceeded");
  if (additions.length) requests.push({ updateCells: { start: { sheetId: CONTROL_ID, rowIndex: last + 1, columnIndex: 10 }, rows: additions.map(row => ({ values: baselineColumns.map(key => enteredCell(row[key] as string | number)) })), fields: "userEnteredValue" } });
  return requests;
}
function keyedTraces(tables: ReportBundle["tables"], logical: Record<string, TraceAnchor>, auditId: string): Record<string, TraceAnchor> {
  const result: Record<string, TraceAnchor> = {};
  for (const name of ["Model Comparison", "CALC_Student_Period", "CALC_Account_Period", "CALC_Package_Lot_Period", "CALC_Exact_Package_Overview", "SRC_Wise_Receipt"]) {
    const [headers, ...rows] = tables[name];
    rows.forEach((row, i) => {
      const value = (key: string) => String(row[headers.indexOf(key)] ?? "");
      const logicalKey = name === "Model Comparison" ? `period:${value("period_end")}` : name === "CALC_Student_Period" ? `student:${value("period_end")}:${value("student_id")}` : name === "CALC_Package_Lot_Period" ? `lot:${value("period_end")}:${value("lot_id")}` : "";
      const key = `${name}:${i + 2}`;
      result[key] = logical[logicalKey] ?? { kind: "audit", url: driveUrl(auditId), label: `Published evidence: ${key}` };
    });
  }
  return result;
}
export async function publishBundle(input: { google: PublicationGoogle; bundle: ReportBundle; bundleHash: string; spreadsheetId: string; rollbackId: string; statePath: string; folderId?: string; commit: boolean }) {
  const { google, bundle, spreadsheetId, statePath } = input;
  validateDailyBundle(bundle);
  const statusRange = "'Model Status'!A1:C200";
  const initialRows = await google.values(spreadsheetId, statusRange);
  const initial = statusFields(initialRows);
  if (initial.workbook_schema_version === "5" && initial.source_fingerprint === bundle.status.source_fingerprint && initial.published_cutoff === bundle.status.published_cutoff) {
    const manifestBytes = await google.bytes(initial.manifest_file_id, 2_000_000);
    if (sha256(manifestBytes) !== initial.manifest_sha256) throw new Error("Current manifest checksum mismatch");
    const manifest = publicationManifestSchema.parse(JSON.parse(manifestBytes.toString()));
    parseValuesPublication({ manifest, contractBytes: await google.bytes(manifest.contract.fileId), statusStart: initialRows, statusEnd: await google.values(spreadsheetId, statusRange) });
    return { status: "unchanged", runId: initial.run_id, cutoff: initial.published_cutoff, reviewChanged: false };
  }
  const assertUnchanged = async () => {
    const [liveRows, control] = await Promise.all([google.values(spreadsheetId, statusRange), google.values(spreadsheetId, "'Package Control'!A1:S20000")]);
    const live = statusFields(liveRows);
    for (const key of ["run_id", "published_cutoff", "publication_revision", "source_fingerprint"]) if (live[key] !== bundle.previousStatus[key]) throw new Error(`Workbook changed after source extraction: ${key}`);
    if (sha256(JSON.stringify(control)) !== bundle.controlValuesHash) throw new Error("Finance controls changed during publication; rebuild the bundle");
    return control;
  };
  await assertUnchanged();
  let prior: PublicationManifest | undefined;
  if (initial.workbook_schema_version === "5") {
    const bytes = await google.bytes(initial.manifest_file_id, 2_000_000);
    if (sha256(bytes) !== initial.manifest_sha256) throw new Error("Previous manifest checksum mismatch");
    prior = publicationManifestSchema.parse(JSON.parse(bytes.toString()));
    const priorAudit = JSON.parse(gunzipSync(verifiedFile(await google.bytes(prior.audit.fileId), prior.audit), { maxOutputLength: 400_000_000 }).toString());
    const currentCounts = new Map(bundle.audit.sources.manifest.map(row => [`${row.drive_file_id}:${row.source_sheet}`, Number(row.extracted_row_count)]));
    for (const row of priorAudit.sources.manifest) if (["accounting_credit_event_ledger", "accounting_credit_balance_control", "rate_support"].includes(row.source_role) && (currentCounts.get(`${row.drive_file_id}:${row.source_sheet}`) ?? -1) < Number(row.extracted_row_count)) throw new Error("Source rows disappeared since the last immutable revision");
  }
  let state: PreparedState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { bundleHash: input.bundleHash, folderId: input.folderId ?? await google.ensureFolder(), months: [] };
  if (state.bundleHash !== input.bundleHash) throw new Error("Prepared state belongs to a different bundle");
  await google.share(state.folderId, !input.commit);
  const save = () => { writeFileSync(statePath + ".tmp", JSON.stringify(state), { mode: 0o600 }); renameSync(statePath + ".tmp", statePath); };
  save();
  if (!state.audit) {
    const audit = gzipSync(JSON.stringify({ ...bundle.audit, dailyReports: bundle.reports, publishedTables: bundle.tables, status: bundle.status }), { level: 9 });
    if (audit.length > 30_000_000) throw new Error("Audit exceeds publication file budget");
    const uploaded = await google.upload(state.folderId, `${bundle.status.published_cutoff} ${bundle.status.run_id} audit.json.gz`, audit);
    state.audit = { fileId: uploaded.id, bytes: audit.length, sha256: sha256(audit) }; save();
  }
  verifiedFile(await google.bytes(state.audit.fileId), state.audit);
  const logical: Record<string, TraceAnchor> = {};
  const months: PublicationManifest["months"] = [];
  for (const [month, data] of Object.entries(bundle.reports.months).sort(([a], [b]) => a.localeCompare(b))) {
    const parts = splitMonth(data);
    for (const [index, part] of parts.entries()) {
      const digest = monthDigest(part);
      const from = part.finance[0].date; const to = part.finance.at(-1)!.date;
      let record = [...state.months, ...prior?.months ?? []].find(item => item.from === from && item.to === to && item.sha256 === digest);
      const build = (id: string) => buildReportTabs({ data: part, spreadsheetId: id, ids: MONTH_IDS, generatedAt: String(bundle.status.generated_at_bangkok), auditUrl: driveUrl(state.audit!.fileId), mainUrl: reportUrl(spreadsheetId, MAIN_IDS[0]) });
      if (!record) {
        const id = await google.createWorkbook(state.folderId, `BeGifted Unearned Revenue ${month}${parts.length > 1 ? ` ${index + 1}/${parts.length}` : ""} — ${bundle.status.run_id}`, build("pending-report-id").tabs);
        const report = build(id);
        process.stderr.write(`Publishing ${month} ${from}–${to}: ${allocatedCells(part).toLocaleString()} cells\n`);
        await google.writeTabs(id, report.tabs);
        await google.batch(id, dateFilterRequests(report.tabs, part));
        await google.verifyTabs(id, report.tabs);
        record = { month, from, to, spreadsheetId: id, cells: allocatedCells(part), sha256: digest, overviewSheetId: MONTH_IDS[0], studentSheetId: MONTH_IDS[1], packageSheetId: MONTH_IDS[2] };
        state.months.push(record); save();
      } else {
        const metadata = await google.metadata(record.spreadsheetId);
        if (metadata.sheets.reduce((sum, s) => sum + s.properties.gridProperties.rowCount * s.properties.gridProperties.columnCount, 0) !== record.cells) throw new Error("Archived report grid size changed");
        // A previously published immutable report retains its original revision
        // header/evidence links. Its data digest was bound to that manifest.
        if (!prior?.months.some(item => item.spreadsheetId === record!.spreadsheetId)) {
          await google.refreshPreparedLinks(record.spreadsheetId, build(record.spreadsheetId).tabs);
          await google.verifyTabs(record.spreadsheetId, build(record.spreadsheetId).tabs);
        }
      }
      Object.assign(logical, build(record.spreadsheetId).traces); months.push(record);
    }
  }
  const traces = keyedTraces(bundle.tables, logical, state.audit.fileId);
  const expectedContract = gzipSync(JSON.stringify({ tables: bundle.tables, traces }), { level: 9 });
  if (!state.contract || state.contract.sha256 !== sha256(expectedContract)) {
    const bytes = expectedContract;
    const uploaded = await google.upload(state.folderId, `${bundle.status.published_cutoff} ${bundle.status.run_id} values.json.gz`, bytes);
    state.contract = { fileId: uploaded.id, bytes: bytes.length, sha256: sha256(bytes) };
    delete state.manifestFileId; delete state.manifestHash; delete state.manifest; save();
  }
  const qaRows = bundle.tables["QA Checks"];
  const manifest: PublicationManifest = publicationManifestSchema.parse({
    schemaVersion: 5, runId: bundle.status.run_id, cutoff: bundle.status.published_cutoff, sourceFingerprint: bundle.status.source_fingerprint,
    revision: bundle.status.publication_revision, generatedAtBangkok: bundle.status.generated_at_bangkok, canonicalModel: bundle.status.canonical_model, modelVersion: bundle.status.candidate_model_version,
    contract: state.contract, audit: state.audit, folderId: state.folderId, rollbackSpreadsheetId: input.rollbackId,
    rowCounts: Object.fromEntries(Object.entries(bundle.tables).map(([name, rows]) => [name, rows.length - 1])),
    qa: { hardStatus: "PASS", dailyCount: bundle.reports.finance.length, creditTolerance: 0.001, moneyTolerance: 1, checks: qaRows.slice(1).filter(row => row[qaRows[0].indexOf("status")] === "PASS").map(row => row[0]) }, months,
  });
  const contractBytes = await google.bytes(manifest.contract.fileId);
  parseValuesPublication({ manifest, contractBytes, statusStart: scalarRows(bundle.status), statusEnd: scalarRows(bundle.status) });
  if (!state.manifestFileId) {
    const bytes = Buffer.from(JSON.stringify(manifest));
    const uploaded = await google.upload(state.folderId, `${manifest.cutoff} ${manifest.runId} manifest.json`, bytes, "application/json");
    state.manifestFileId = uploaded.id; state.manifestHash = sha256(bytes); state.manifest = manifest; save();
  }
  if (sha256(await google.bytes(state.manifestFileId, 2_000_000)) !== state.manifestHash) throw new Error("Uploaded manifest verification failed");
  if (!input.commit) return { status: "prepared", runId: manifest.runId, cutoff: manifest.cutoff, reports: months.length, reviewChanged: false, manifestFileId: state.manifestFileId, pendingAudience: [...new Set(google.pendingAudience)] };
  const cutoff = manifest.cutoff;
  const latestMonth = bundle.reports.months[cutoff.slice(0, 7)];
  const main = buildReportTabs({ data: { finance: bundle.reports.finance, students: latestMonth.students.filter(row => row.date === cutoff), packages: latestMonth.packages.filter(row => row.date === cutoff) }, spreadsheetId, ids: MAIN_IDS, generatedAt: manifest.generatedAtBangkok, auditUrl: driveUrl(manifest.audit.fileId), historyLinks: months, controlUrl: reportUrl(spreadsheetId, CONTROL_ID), mainUrl: reportUrl(spreadsheetId, MAIN_IDS[0]) });
  // Any abandoned stage belongs to a failed run; it is never referenced by the
  // current publication. Remove only our own generated temporary tabs.
  let metadata = await google.metadata(spreadsheetId);
  const stale = metadata.sheets.filter(s => s.properties.title.startsWith("_UR_V5_STAGE_"));
  if (stale.length) { await google.batch(spreadsheetId, stale.map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } }))); metadata = await google.metadata(spreadsheetId); }
  const capacity = capacityPlan(metadata, main.tabs);
  const stages = main.tabs.map((tab, i) => ({ ...tab, sheetId: randomInt(100_000_000, 199_999_999), title: `_UR_V5_STAGE_${manifest.runId.slice(0, 8)}_${i}` }));
  await google.batch(spreadsheetId, stages.map(tab => ({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title, hidden: true, gridProperties: { rowCount: tab.rows.length, columnCount: tab.widths.length } } } })));
  await google.writeTabs(spreadsheetId, stages);
  await google.verifyTabs(spreadsheetId, stages);
  const control = await assertUnchanged();
  const status = scalarRows({ ...bundle.status, manifest_file_id: state.manifestFileId, manifest_sha256: state.manifestHash!, report_folder_id: manifest.folderId, rollback_spreadsheet_id: input.rollbackId });
  const requests = buildCommitRequests(metadata, main.tabs, stages.map(tab => tab.sheetId), status, control, bundle.audit.opening_baselines_to_write, google.email);
  try { await google.batch(spreadsheetId, requests); }
  catch (error) {
    // A transport timeout can occur after Google committed the atomic request.
    // Resolve it by reading the marker; never blindly replay a mixed delete/add.
    const observed = statusFields(await google.values(spreadsheetId, statusRange));
    if (observed.run_id !== manifest.runId || observed.manifest_sha256 !== state.manifestHash) throw error;
  }
  await google.verifyTabs(spreadsheetId, main.tabs);
  const finalRows = await google.values(spreadsheetId, statusRange);
  parseValuesPublication({ manifest, contractBytes, statusStart: finalRows, statusEnd: await google.values(spreadsheetId, statusRange) });
  const finalMetadata = await google.metadata(spreadsheetId);
  if (finalMetadata.sheets.filter(s => !s.properties.hidden).length !== 3) throw new Error("Finance workbook does not have exactly three visible tabs");
  return { status: "published", runId: manifest.runId, cutoff, reports: months.length, ...capacity, reviewChanged: String(bundle.status.review_conditions) !== (initial.review_conditions || "NONE") && bundle.status.review_conditions !== "NONE" };
}
