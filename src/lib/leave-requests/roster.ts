import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { leaveRosterPeople, leaveRosterShifts } from "@/lib/db/schema";
import { getGoogleSheetsAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { datesBetweenBangkok, endOfBangkokMonth, nextMonthStart } from "@/lib/room-capacity/dates";
import { LEAVE_ROSTER_SPREADSHEET_ID } from "./config";
import { parseSpecificTimeWindow } from "./parser";
import { validDate } from "./work-model";

// Verified against existing admin_users. This registry never grants access.
export const LEAVE_ROSTER_PEOPLE = [
  { key: "petchy", name: "Petchy", email: "panida.wiya@gmail.com", aliases: ["Petch", "Petchy"] },
  { key: "care", name: "Care", email: "kittiya.carekt@gmail.com", aliases: ["Care"] },
  { key: "palm", name: "Palm", email: "chiraya.work@gmail.com", aliases: ["Palm"] },
  { key: "aya", name: "Aya", email: "pakwalaan@gmail.com", aliases: ["Aya"] },
  { key: "muk", name: "Muk", email: "suphitsaramanosamrit@gmail.com", aliases: ["Muk"] },
];

type Color = { red?: number; green?: number; blue?: number };
export interface RosterCell {
  formattedValue?: string;
  note?: string;
  effectiveFormat?: { backgroundColor?: Color; backgroundColorStyle?: { rgbColor?: Color; themeColor?: string } };
}
export interface RosterGrid { startRow?: number; startColumn?: number; rowData?: Array<{ values?: RosterCell[] }> }
interface RosterSheet { properties?: { title?: string }; data?: RosterGrid[] }
interface RosterResponse {
  sheets?: RosterSheet[];
  properties?: { spreadsheetTheme?: { themeColors?: Array<{ colorType: string; color: { rgbColor?: Color } }> } };
  error?: { message?: string };
}

export function rosterColor(cell: RosterCell, themes: Record<string, Color> = {}): string | null {
  const f = cell.effectiveFormat;
  const rgb = f?.backgroundColor ?? f?.backgroundColorStyle?.rgbColor ?? themes[f?.backgroundColorStyle?.themeColor ?? ""];
  return rgb ? "#" + [rgb.red, rgb.green, rgb.blue].map((v) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0")).join("") : null;
}

export function rosterMonth(title: string): string | null {
  const match = title.trim().match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[_\s-]+(20)?(\d{2})$/i);
  if (!match) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  return `20${match[3]}-${String(month).padStart(2, "0")}`;
}

function cellAddress(row: number, col: number): string {
  let letters = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return `${letters}${row + 1}`;
}

export function parseRosterMonth(sheet: RosterSheet, people = LEAVE_ROSTER_PEOPLE, themes: Record<string, Color> = {}): Array<typeof leaveRosterShifts.$inferInsert> {
  const title = sheet.properties?.title ?? "";
  const month = rosterMonth(title);
  if (!month) return [];
  const rows: RosterCell[][] = [];
  for (const grid of sheet.data ?? []) for (const [r, row] of (grid.rowData ?? []).entries()) {
    rows[(grid.startRow ?? 0) + r] ??= [];
    for (const [c, cell] of (row.values ?? []).entries()) rows[(grid.startRow ?? 0) + r][(grid.startColumn ?? 0) + c] = cell;
  }
  const legend = new Map<string, { status: string; shift: string | null; startMinute: number | null; endMinute: number | null }>();
  // Read the first monthly grid only: the weekly presentation below it repeats names.
  const header = rows.findIndex((row) => row?.filter((cell) => /^\d+$/.test(cell?.formattedValue ?? "")).length >= 28);
  if (header < 0) return [];
  for (const row of rows.slice(0, header)) {
    const label = row?.[0]?.formattedValue ?? "";
    const cell = row?.[1];
    if (!cell) continue;
    const color = rosterColor(cell, themes);
    if (!color) continue;
    const text = `${label} ${cell.formattedValue ?? ""}`;
    if (/shift\s*\d/i.test(label)) {
      const time = parseSpecificTimeWindow(cell.formattedValue);
      if (!time.error) legend.set(color, { status: "working", shift: label, startMinute: time.startMinute, endMinute: time.endMinute });
    } else if (/holiday|day\s*off|leave/i.test(text)) {
      legend.set(color, { status: /holiday/i.test(text) ? "holiday" : /leave/i.test(text) ? "leave" : "off", shift: null, startMinute: null, endMinute: null });
    }
  }
  const result: Array<typeof leaveRosterShifts.$inferInsert> = [];
  const seen = new Set<string>();
  for (let r = header + 1; r < Math.min(header + 10, rows.length); r++) {
    const row = rows[r];
    const name = row?.[0]?.formattedValue?.trim().toLowerCase();
    const person = people.find((p) => p.aliases.some((a) => a.toLowerCase() === name));
    if (!person || seen.has(person.key)) continue;
    seen.add(person.key);
    for (let c = 1; c < rows[header].length; c++) {
      const day = rows[header][c]?.formattedValue ?? "";
      if (!/^\d{1,2}$/.test(day)) continue;
      const date = `${month}-${day.padStart(2, "0")}`;
      if (!validDate(date)) continue;
      const cell = row[c] ?? {};
      const color = rosterColor(cell, themes);
      const note = [cell.formattedValue, cell.note].filter(Boolean).join(" · ") || null;
      const info = color ? legend.get(color) : null;
      let status = info?.status ?? "unknown";
      // A swap's embedded date is a reference, never another day's assignment.
      if (/\bSL\b|sick|ลาป่วย/i.test(note ?? "")) status = "sick";
      else if (/\boff\b|holiday|\bleave\b|วันหยุด|ลาพัก/i.test(note ?? "")) status = /holiday/i.test(note ?? "") ? "holiday" : "off";
      else if (note && !/^(?:sw(?:ap)?\s*(?:with\s*)?[\p{L}\s]*\d{1,2}\/\d{1,2}|shift\s*\d)$/iu.test(note)) status = "unknown";
      result.push({ personKey: person.key, date, status, shift: status === "working" ? info?.shift ?? null : null, startMinute: status === "working" ? info?.startMinute ?? null : null, endMinute: status === "working" ? info?.endMinute ?? null : null, sourceTab: title, sourceCell: cellAddress(r, c), color, note });
    }
  }
  return result;
}

export async function syncLeaveRoster(db: Database, email: string, today: string): Promise<{ fetchedAt: string; missingMonths: string[] }> {
  await db.insert(leaveRosterPeople).values(LEAVE_ROSTER_PEOPLE).onConflictDoNothing();
  const people = await db.select().from(leaveRosterPeople);
  const token = await getGoogleSheetsAccessToken(email);
  const fetchSheet = async (params: URLSearchParams): Promise<RosterResponse> => {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${LEAVE_ROSTER_SPREADSHEET_ID}?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as RosterResponse;
    if (!response.ok) throw new Error(`Roster could not be read (${response.status}).`);
    return result;
  };
  const metadata = await fetchSheet(new URLSearchParams({ fields: "sheets.properties.title,properties.spreadsheetTheme" }));
  const months = [today.slice(0, 7), nextMonthStart(today).slice(0, 7)];
  const titles = (metadata.sheets ?? []).map((s) => s.properties?.title ?? "").filter((t) => months.includes(rosterMonth(t) ?? ""));
  const themes = Object.fromEntries((metadata.properties?.spreadsheetTheme?.themeColors ?? []).map((t) => [t.colorType, t.color.rgbColor ?? {}]));
  const fetchedAt = new Date();
  if (titles.length) {
    const params = new URLSearchParams({ fields: "sheets(properties.title,data(startRow,startColumn,rowData.values(formattedValue,note,effectiveFormat(backgroundColor,backgroundColorStyle))))", includeGridData: "true" });
    titles.forEach((t) => params.append("ranges", `'${t.replace(/'/g, "''")}'!A1:AF20`));
    const body = await fetchSheet(params);
    for (const sheet of body.sheets ?? []) {
      const shifts = parseRosterMonth(sheet, people, themes);
      if (!shifts.length) throw new Error(`Roster layout or legend is missing in ${sheet.properties?.title}.`);
      const month = rosterMonth(sheet.properties?.title ?? "")!;
      for (const person of people) for (const date of datesBetweenBangkok(`${month}-01`, endOfBangkokMonth(`${month}-01`))) {
        if (!shifts.some((shift) => shift.personKey === person.key && shift.date === date)) shifts.push({ personKey: person.key, date, status: "unknown", sourceTab: sheet.properties!.title!, sourceCell: "", note: "Person or date is absent from this month's roster." });
      }
      await db.insert(leaveRosterShifts).values(shifts.map((s) => ({ ...s, fetchedAt }))).onConflictDoUpdate({
        target: [leaveRosterShifts.personKey, leaveRosterShifts.date],
        set: { status: sql`excluded.status`, shift: sql`excluded.shift`, startMinute: sql`excluded.start_minute`, endMinute: sql`excluded.end_minute`, sourceTab: sql`excluded.source_tab`, sourceCell: sql`excluded.source_cell`, color: sql`excluded.color`, note: sql`excluded.note`, fetchedAt },
      });
    }
  }
  return { fetchedAt: fetchedAt.toISOString(), missingMonths: months.filter((m) => !titles.some((t) => rosterMonth(t) === m)) };
}

export async function rosterForDate(db: Database, date: string) {
  return db.select().from(leaveRosterShifts).where(eq(leaveRosterShifts.date, date));
}
