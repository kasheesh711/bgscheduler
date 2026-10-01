import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { tutorOffboardingSheetSource } from "@/lib/db/schema";
import { sqlStateOf } from "@/lib/db/sql-state";
import { getGoogleSheetsAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { parseTerminationSheet, TERMINATION_SHEET_ID, TERMINATION_SPREADSHEET_ID, type TerminationSheetResponse, type TerminationSnapshot } from "./termination-source";

const SOURCE_KEY = "terminated-tutors";

/** Called only by the existing snapshot sync, never by a page or API read. */
async function fetchTerminationSheet(email: string, db: Database) {
  const token = await getGoogleSheetsAccessToken(email, db);
  const read = async (params: URLSearchParams): Promise<TerminationSheetResponse> => {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${TERMINATION_SPREADSHEET_ID}?${params}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Termination source read failed");
    return await response.json() as TerminationSheetResponse;
  };
  const metadata = await read(new URLSearchParams({ fields: "sheets.properties(sheetId,title,gridProperties.rowCount)" }));
  const target = metadata.sheets?.find((s) => s.properties?.sheetId === TERMINATION_SHEET_ID && s.properties.title === "Tutors");
  const rowCount = target?.properties?.gridProperties?.rowCount;
  // Bound the read and fail visibly rather than silently truncating newly appended tutors.
  if (!Number.isInteger(rowCount) || rowCount! < 2 || rowCount! > 10_000) throw new Error("Termination source dimensions changed");
  const body = await read(new URLSearchParams({
    ranges: `'Tutors'!D1:H${rowCount}`,
    fields: "sheets(properties(sheetId,title),data(startRow,startColumn,rowData.values(formattedValue,effectiveFormat.textFormat.strikethrough,textFormatRuns)))",
    includeGridData: "true",
  }));
  return parseTerminationSheet(body);
}

/** OFF-15: whole-source replacement is atomic; failed reads retain the last successful evidence. */
export async function syncTerminationSource(
  email: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<{ rows: number; confirmed: number } | { error: string }> {
  try {
    if (!email.trim()) {
      const error = new Error("No integration account configured"); error.name = "NotConfigured"; throw error;
    }
    const rows = await fetchTerminationSheet(email.trim().toLowerCase(), db);
    await db.insert(tutorOffboardingSheetSource).values({ sourceKey: SOURCE_KEY, rows, checkedAt: now, attemptedAt: now, lastError: null })
      .onConflictDoUpdate({ target: tutorOffboardingSheetSource.sourceKey, set: { rows, checkedAt: now, attemptedAt: now, lastError: null } });
    return { rows: rows.length, confirmed: rows.filter((r) => r.terminated).length };
  } catch (error) {
    const safeError = `${error instanceof Error ? error.name : "UnknownError"} (${sqlStateOf(error) ?? "no SQLSTATE"})`;
    await db.insert(tutorOffboardingSheetSource).values({ sourceKey: SOURCE_KEY, rows: [], checkedAt: null, attemptedAt: now, lastError: safeError })
      .onConflictDoUpdate({ target: tutorOffboardingSheetSource.sourceKey, set: { attemptedAt: now, lastError: safeError } });
    return { error: safeError };
  }
}

/** Fresh, Postgres-only read: decisions and source health must not be hidden by snapshot caching. */
export async function loadTerminationSnapshot(db: Database = getDb()): Promise<TerminationSnapshot> {
  const [row] = await db.select().from(tutorOffboardingSheetSource).where(eq(tutorOffboardingSheetSource.sourceKey, SOURCE_KEY)).limit(1);
  return row ? { rows: row.rows, checkedAt: row.checkedAt?.toISOString() ?? null, lastError: row.lastError } : { rows: [], checkedAt: null, lastError: null };
}
