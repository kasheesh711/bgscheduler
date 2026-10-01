import type { PersonSignals } from "./types";

export const TERMINATION_SPREADSHEET_ID = "1xwbaLzyceUSNMUhhIBLV4j7uG3cRIqFKwJUfYZE_vG4";
export const TERMINATION_SHEET_ID = 470328060;
export const TERMINATION_SOURCE_URL = `https://docs.google.com/spreadsheets/d/${TERMINATION_SPREADSHEET_ID}/edit?gid=${TERMINATION_SHEET_ID}#gid=${TERMINATION_SHEET_ID}`;

export interface TerminationSheetRow {
  sourceRow: number;
  fullName: string;
  wiseName: string;
  nickname: string;
  emails: string[];
  terminated: boolean;
}
export interface TerminationSnapshot {
  rows: TerminationSheetRow[];
  checkedAt: string | null;
  lastError: string | null;
}
export interface TerminationEvidence {
  sourceRow: number;
  sourceName: string;
  checkedAt: string;
  sourceUrl: string;
  match: "email" | "full_name";
}
export interface TerminationSourceStatus {
  status: "ready" | "stale" | "not_synced" | "error";
  checkedAt: string | null;
  sourceUrl: string;
  confirmedRows: number;
  matchedPeople: number;
  unmatched: Array<{ sourceRow: number; sourceName: string; reason: string }>;
}
interface SheetCell {
  formattedValue?: string;
  effectiveFormat?: { textFormat?: { strikethrough?: boolean } };
  textFormatRuns?: Array<{ startIndex?: number; format?: { strikethrough?: boolean } }>;
}
export interface TerminationSheetResponse {
  sheets?: Array<{
    properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } };
    data?: Array<{ startRow?: number; startColumn?: number; rowData?: Array<{ values?: SheetCell[] }> }>;
  }>;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Full-cell and rich-text formats must agree over every non-space character. */
function strikeState(cell: SheetCell): "yes" | "no" | "partial" {
  const text = cell.formattedValue ?? "";
  const base = cell.effectiveFormat?.textFormat?.strikethrough === true;
  const states: boolean[] = [];
  let at = 0;
  let state = base;
  for (const run of cell.textFormatRuns ?? []) {
    const next = run.startIndex ?? 0;
    if (next < at || next > text.length) throw new Error("Invalid termination source formatting");
    if (text.slice(at, next).trim()) states.push(state);
    state = run.format?.strikethrough ?? base;
    at = next;
  }
  if (text.slice(at).trim()) states.push(state);
  return states.every(Boolean) ? "yes" : states.some(Boolean) ? "partial" : "no";
}

/** OFF-15: only the owner's explicit, complete name strikethrough confirms termination. */
export function parseTerminationSheet(response: TerminationSheetResponse): TerminationSheetRow[] {
  const sheet = response.sheets?.find((s) => s.properties?.sheetId === TERMINATION_SHEET_ID && s.properties.title === "Tutors");
  if (!sheet) throw new Error("Termination source tab is missing");
  const rows = new Map<number, Map<number, SheetCell>>();
  for (const grid of sheet.data ?? []) {
    for (const [r, row] of (grid.rowData ?? []).entries()) {
      const rowNumber = (grid.startRow ?? 0) + r + 1;
      const cells = rows.get(rowNumber) ?? new Map<number, SheetCell>();
      for (const [c, value] of (row.values ?? []).entries()) cells.set((grid.startColumn ?? 0) + c, value);
      rows.set(rowNumber, cells);
    }
  }
  const expected = ["Tutor Full Name", "Wise Tutor", "Tutor Nickname", "Tutor email", "Tutor email 2"];
  if (expected.some((header, i) => normalize(rows.get(1)?.get(i + 3)?.formattedValue ?? "") !== normalize(header))) {
    throw new Error("Termination source headers changed");
  }
  const result: TerminationSheetRow[] = [];
  for (const [sourceRow, cells] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    if (sourceRow === 1) continue;
    const values = Array.from({ length: 5 }, (_, i) => (cells.get(i + 3)?.formattedValue ?? "").trim());
    if (!values.some(Boolean)) continue;
    if (!values[0] || !values[1]) throw new Error("Termination source identity is incomplete");
    const states = [3, 4, 5].filter((c) => cells.get(c)?.formattedValue?.trim()).map((c) => strikeState(cells.get(c)!));
    if (states.includes("partial") || (states.includes("yes") && states.includes("no"))) {
      throw new Error("Termination source name formatting is inconsistent");
    }
    // The live email columns also contain modality notes. OFF-02: those are unknown, never identifiers.
    const emails = [...new Set(values.slice(3).map(normalize).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
    result.push({ sourceRow, fullName: values[0], wiseName: values[1], nickname: values[2], emails, terminated: states.every((s) => s === "yes") });
  }
  if (!result.length) throw new Error("Termination source is empty");
  return result;
}

/** OFF-01/OFF-15: unique exact identities only. Nicknames and fuzzy matches never confer confirmation. */
export function buildTerminationMatches(people: PersonSignals[], snapshot: TerminationSnapshot, now: Date): {
  byKey: Record<string, TerminationEvidence>; source: TerminationSourceStatus;
} {
  const byKey: Record<string, TerminationEvidence> = Object.create(null);
  const source: TerminationSourceStatus = {
    status: snapshot.lastError ? "error" : !snapshot.checkedAt ? "not_synced" :
      now.getTime() - Date.parse(snapshot.checkedAt) > 3 * 86_400_000 || !Number.isFinite(Date.parse(snapshot.checkedAt)) ? "stale" : "ready",
    checkedAt: snapshot.checkedAt, sourceUrl: TERMINATION_SOURCE_URL,
    confirmedRows: snapshot.rows.filter((r) => r.terminated).length, matchedPeople: 0, unmatched: [],
  };
  if (!snapshot.checkedAt) return { byKey, source };
  const emails = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, value: string, key: string) => {
    const normalized = normalize(value);
    if (!normalized) return;
    const keys = map.get(normalized) ?? new Set<string>(); keys.add(key); map.set(normalized, keys);
  };
  for (const person of people) for (const account of person.accounts) {
    if (account.email) add(emails, account.email, person.canonicalKey);
    // A one-word display name is a nickname, even if it happens to equal the sheet's full-name cell.
    if (/\s/.test(account.displayName.trim())) add(names, account.displayName, person.canonicalKey);
  }
  const candidates = snapshot.rows.map((row) => {
    const emailKeys = new Set(row.emails.flatMap((e) => [...(emails.get(normalize(e)) ?? [])]));
    const nameKeys = new Set([row.fullName, row.wiseName].flatMap((n) => [...(names.get(normalize(n)) ?? [])]));
    return { row, keys: new Set([...emailKeys, ...nameKeys]), match: emailKeys.size ? "email" as const : "full_name" as const };
  });
  const rowCountByKey = new Map<string, number>();
  for (const candidate of candidates) for (const key of candidate.keys) rowCountByKey.set(key, (rowCountByKey.get(key) ?? 0) + 1);
  for (const { row, keys, match } of candidates) {
    if (!row.terminated) continue;
    const [key] = keys;
    if (keys.size !== 1 || rowCountByKey.get(key) !== 1) {
      source.unmatched.push({ sourceRow: row.sourceRow, sourceName: row.fullName, reason: keys.size === 0 ? "No exact roster identity match" : "Conflicting or duplicate identity; review required" });
      continue;
    }
    byKey[key] = { sourceRow: row.sourceRow, sourceName: row.fullName, checkedAt: snapshot.checkedAt, sourceUrl: `${TERMINATION_SOURCE_URL}&range=D${row.sourceRow}:H${row.sourceRow}`, match };
  }
  source.matchedPeople = Object.keys(byKey).length;
  return { byKey, source };
}
