import { sha256, type PublicationManifest } from "../publication";
import type { TraceAnchor } from "../types";

export interface LinkCell { link: string; label: string }
export type Cell = string | number | boolean | null | LinkCell;
export interface DailyTotal { date: string; liability_thb: number; student_count: number }
export interface DailyStudent { date: string; student_id: string; student_name: string; liability_thb: number }
export interface DailyPackage extends DailyStudent {
  account_id: string; class_name: string; class_subject?: string; lot_id: string; package_name: string; kind: string;
  purchase_date: string | null; transaction_number: string; remaining_credits: number | null;
  source_url: string; credit_url: string;
}
export interface MonthData { finance: DailyTotal[]; students: DailyStudent[]; packages: DailyPackage[] }
export interface ReportBundle {
  schemaVersion: 5; status: Record<string, string | number>; tables: Record<string, unknown[][]>;
  reports: { finance: DailyTotal[]; months: Record<string, MonthData>; qa: unknown[] };
  audit: { sources: { manifest: Array<Record<string, unknown>> }; opening_baselines_to_write: Array<Record<string, unknown>>; [key: string]: unknown };
  controlValuesHash: string; previousStatus: Record<string, string>;
}
export interface ReportTab { title: string; sheetId: number; rows: Cell[][]; moneyColumns: number[]; widths: number[] }
export const TITLES = ["ภาพรวม", "รายนักเรียน", "รายละเอียดแพ็กเกจ"] as const;
export const HEAD_ROWS = 5;
export const MAIN_IDS = [2000011001, 2000011002, 2000011003] as const;
export const MONTH_IDS = [1, 2, 3] as const;
export const MONTH_CELL_BUDGET = 2_000_000;
export const MAIN_CELL_BUDGET = 1_000_000;
export const link = (url: string, label: string): LinkCell => ({ link: url, label });
export function reportUrl(id: string, sheetId: number, row?: number, endRow?: number): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${sheetId}${row ? `&range=A${row}:L${endRow ?? row}` : ""}`;
}
export const filterId = (day: string, packages = false): number => Number(day.replaceAll("-", "")) * 10 + (packages ? 2 : 1);
export const dateUrl = (id: string, sheetId: number, day: string, packages = false): string => `${reportUrl(id, sheetId)}&fvid=${filterId(day, packages)}`;
export function allocatedCells(data: MonthData): number {
  return (data.finance.length + HEAD_ROWS) * 6 + (data.students.length + HEAD_ROWS) * 5 + (data.packages.length + HEAD_ROWS) * 12;
}
export function splitMonth(data: MonthData, maxCells = MONTH_CELL_BUDGET): MonthData[] {
  const result: MonthData[] = [];
  let part: MonthData = { finance: [], students: [], packages: [] };
  const byDate = <T extends { date: string }>(rows: T[]) => {
    const groups = new Map<string, T[]>();
    for (const row of rows) { const group = groups.get(row.date) ?? []; group.push(row); groups.set(row.date, group); }
    return groups;
  };
  const students = byDate(data.students);
  const packages = byDate(data.packages);
  for (const day of data.finance) {
    const next = { finance: [...part.finance, day], students: [...part.students, ...students.get(day.date) ?? []], packages: [...part.packages, ...packages.get(day.date) ?? []] };
    if (allocatedCells(next) > maxCells && part.finance.length) {
      result.push(part); part = { finance: [day], students: students.get(day.date) ?? [], packages: packages.get(day.date) ?? [] };
    } else part = next;
    if (allocatedCells(part) > maxCells) throw new Error(`Daily report exceeds workbook budget: ${day.date}`);
  }
  if (part.finance.length) result.push(part);
  return result;
}
export function monthDigest(data: MonthData): string { return sha256(JSON.stringify(data)); }

export function buildReportTabs(input: {
  data: MonthData; spreadsheetId: string; ids: readonly number[]; generatedAt: string;
  auditUrl: string; historyLinks?: PublicationManifest["months"]; controlUrl?: string; mainUrl: string;
}): { tabs: ReportTab[]; traces: Record<string, TraceAnchor> } {
  const { data, ids, spreadsheetId } = input;
  const latest = data.finance.at(-1)!;
  const packageRanges = new Map<string, { start: number; end: number }>();
  const traces: Record<string, TraceAnchor> = {};
  const trace = (sheetId: number, row: number): TraceAnchor => ({ kind: "published", spreadsheetId, sheetId, row, a1: `A${row}:L${row}`, url: reportUrl(spreadsheetId, sheetId, row) });
  data.packages.forEach((row, index) => {
    const sheetRow = HEAD_ROWS + index + 1;
    const key = `${row.date}:${row.student_id}`;
    const range = packageRanges.get(key);
    if (range) range.end = sheetRow; else packageRanges.set(key, { start: sheetRow, end: sheetRow });
    traces[`lot:${row.date}:${row.lot_id}`] = { ...trace(ids[2], sheetRow), url: reportUrl(spreadsheetId, ids[2], sheetRow) + (input.historyLinks ? "" : `&fvid=${filterId(row.date, true)}`) };
  });
  function base(title: string): Cell[][] {
    const stamp = input.generatedAt;
    const readableTime = stamp.length >= 16 ? `${stamp.slice(8, 10)}/${stamp.slice(5, 7)}/${stamp.slice(0, 4)} ${stamp.slice(11, 16)}` : stamp;
    return [[title], ["ข้อมูลถึงวันที่", latest.date, "ยอดรวม (บาท)", latest.liability_thb],
      ["ปรับปรุงสำเร็จ", readableTime, "ข้อมูลย้อนหลังคำนวณจากหลักฐานที่มี ณ รอบปรับปรุงนี้"],
      [link(input.mainUrl, "กลับภาพรวม"), link(input.auditUrl, "หลักฐานการคำนวณ"), input.controlUrl ? link(input.controlUrl, "ตั้งค่าสำหรับผู้ดูแล") : null]];
  }
  const overview = [...base(TITLES[0]), ["วันที่", "ยอดรวม unearned revenue (บาท)", "จำนวนนักเรียน", "รายนักเรียน", "รายละเอียดแพ็กเกจ", "หมายเหตุ"] as Cell[]];
  for (const day of data.finance) {
    const archive = input.historyLinks?.find(item => item.from <= day.date && item.to >= day.date);
    if (input.historyLinks && !archive) throw new Error(`Missing archive for ${day.date}`);
    const target = archive?.spreadsheetId ?? spreadsheetId;
    const studentId = archive?.studentSheetId ?? ids[1];
    const packageId = archive?.packageSheetId ?? ids[2];
    overview.push([day.date, day.liability_thb, day.student_count, link(dateUrl(target, studentId, day.date), "ดูนักเรียน"), link(dateUrl(target, packageId, day.date, true), "ดูแพ็กเกจ"), day.date === latest.date ? "ล่าสุด" : ""]);
    traces[`period:${day.date}`] = trace(ids[0], overview.length);
  }
  const studentRows = [...base(TITLES[1]), ["วันที่", "นักเรียน", "ยอดคงเหลือ (บาท)", "แพ็กเกจ", "รหัสนักเรียน"] as Cell[]];
  for (const student of data.students) {
    const range = packageRanges.get(`${student.date}:${student.student_id}`);
    studentRows.push([student.date, student.student_name, student.liability_thb,
      range ? link(reportUrl(spreadsheetId, ids[2], range.start, range.end) + (input.historyLinks ? "" : `&fvid=${filterId(student.date, true)}`), "ดูแพ็กเกจ") : "ไม่มียอดคงเหลือ", student.student_id]);
    traces[`student:${student.date}:${student.student_id}`] = { ...trace(ids[1], studentRows.length), url: reportUrl(spreadsheetId, ids[1], studentRows.length) + (input.historyLinks ? "" : `&fvid=${filterId(student.date)}`) };
  }
  const packages = [...base(TITLES[2]), ["วันที่", "นักเรียน", "วิชา", "แพ็กเกจ / รายการ", "ยอดคงเหลือ (บาท)", "เครดิตคงเหลือ", "วันที่ซื้อ", "เลขที่รายการ", "หลักฐานซื้อ", "ประวัติเครดิต", "หมายเหตุ", "รหัสนักเรียน"] as Cell[]];
  for (const row of data.packages) packages.push([
    row.date, row.student_name, row.class_subject || "ยังไม่ระบุวิชา", row.package_name, row.liability_thb, row.remaining_credits,
    row.purchase_date, row.transaction_number, row.source_url ? link(row.source_url, "เปิดรายการซื้อ") : null,
    row.credit_url ? link(row.credit_url, "เปิดเครดิต") : null,
    row.kind === "VALUATION_ADJUSTMENT" ? "ส่วนต่างระหว่างมูลค่าแพ็กกับวิธีประเมินที่อนุมัติ ไม่ใช่การซื้อใหม่" : row.kind === "OPENING" ? "ยอดก่อน 1 มี.ค. 2026" : row.kind !== "PAID_PACKAGE" ? "ยังไม่มีหลักฐานระบุแพ็กที่แน่นอน" : "", row.student_id,
  ]);
  return { traces, tabs: [
    { title: TITLES[0], sheetId: ids[0], rows: overview, moneyColumns: [1], widths: [115, 270, 140, 140, 150, 140] },
    { title: TITLES[1], sheetId: ids[1], rows: studentRows, moneyColumns: [2], widths: [115, 330, 170, 140, 220] },
    { title: TITLES[2], sheetId: ids[2], rows: packages, moneyColumns: [4], widths: [115, 260, 150, 210, 170, 125, 115, 165, 145, 145, 310, 220] },
  ] };
}

export function displayed(cell: Cell | undefined): string | number | boolean | null {
  return cell && typeof cell === "object" ? cell.label : cell ?? null;
}
