import { getGoogleSheetsAccessToken, getGoogleSheetsWriteAccessToken } from "./google-oauth";

interface GoogleSheetsValuesResponse {
  values?: unknown[][];
  error?: { message?: string };
}

interface GoogleSheetsMetadataResponse {
  sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  error?: { message?: string };
}

interface GoogleSheetsUpdateResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
  error?: { message?: string };
}

function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

async function googleSheetsGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `Google Sheets request failed (${response.status})`);
  }
  return body;
}

async function googleSheetsPost<T>(
  path: string,
  accessToken: string,
  payload: Record<string, unknown>,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `Google Sheets batch update failed (${response.status})`);
  }
  return body;
}

async function googleSheetsPut<T>(
  path: string,
  accessToken: string,
  params: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `Google Sheets update failed (${response.status})`);
  }
  return body;
}

export async function listGoogleSheetTitles(email: string, spreadsheetId: string): Promise<string[]> {
  const accessToken = await getGoogleSheetsAccessToken(email);
  const body = await googleSheetsGet<GoogleSheetsMetadataResponse>(
    `${spreadsheetId}`,
    accessToken,
    { fields: "sheets.properties.title" },
  );
  return (body.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => Boolean(title));
}

export async function fetchGoogleSheetRows(
  email: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<unknown[][]> {
  const accessToken = await getGoogleSheetsAccessToken(email);
  const range = encodeURIComponent(quoteSheetName(sheetName));
  const body = await googleSheetsGet<GoogleSheetsValuesResponse>(
    `${spreadsheetId}/values/${range}`,
    accessToken,
    {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    },
  );
  return body.values ?? [];
}

export async function updateGoogleSheetCell(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  cellA1: string,
  value: string,
): Promise<GoogleSheetsUpdateResponse> {
  const accessToken = await getGoogleSheetsWriteAccessToken(email);
  const range = `${quoteSheetName(sheetName)}!${cellA1}`;
  return googleSheetsPut<GoogleSheetsUpdateResponse>(
    `${spreadsheetId}/values/${encodeURIComponent(range)}`,
    accessToken,
    { valueInputOption: "USER_ENTERED" },
    {
      range,
      majorDimension: "ROWS",
      values: [[value]],
    },
  );
}

export interface GoogleSheetProperties {
  title: string;
  /** Numeric gid. `insertDimension` addresses sheets by this, not by title. */
  sheetId: number;
}

export async function listGoogleSheetProperties(
  email: string,
  spreadsheetId: string,
): Promise<GoogleSheetProperties[]> {
  const accessToken = await getGoogleSheetsAccessToken(email);
  const body = await googleSheetsGet<GoogleSheetsMetadataResponse>(
    `${spreadsheetId}`,
    accessToken,
    { fields: "sheets.properties(sheetId,title)" },
  );
  return (body.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter((properties): properties is { title: string; sheetId: number } =>
      typeof properties?.title === "string" && typeof properties?.sheetId === "number")
    .map((properties) => ({ title: properties.title, sheetId: properties.sheetId }));
}

/**
 * Insert one blank row beneath `afterRowNumber` (1-based).
 *
 * `values.update` can only overwrite, so inserting requires a structural
 * `batchUpdate`. Callers writing several rows into one sheet must work from
 * the bottom up, or every row number below an insert shifts underneath them.
 */
export async function insertGoogleSheetRow(
  email: string,
  spreadsheetId: string,
  sheetGid: number,
  afterRowNumber: number,
): Promise<void> {
  const accessToken = await getGoogleSheetsWriteAccessToken(email);
  await googleSheetsPost<{ replies?: unknown[] }>(
    `${spreadsheetId}:batchUpdate`,
    accessToken,
    {
      requests: [{
        insertDimension: {
          range: {
            sheetId: sheetGid,
            dimension: "ROWS",
            // 0-based half-open: inserting at `afterRowNumber` places the new
            // row immediately below the 1-based row of that number.
            startIndex: afterRowNumber,
            endIndex: afterRowNumber + 1,
          },
          inheritFromBefore: true,
        },
      }],
    },
  );
}

/** Write a contiguous run of cells across one row in a single request. */
export async function updateGoogleSheetRowValues(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  values: Array<string | number | null>,
  lastColumn = "H",
): Promise<GoogleSheetsUpdateResponse> {
  const accessToken = await getGoogleSheetsWriteAccessToken(email);
  const range = `${quoteSheetName(sheetName)}!A${rowNumber}:${lastColumn}${rowNumber}`;
  return googleSheetsPut<GoogleSheetsUpdateResponse>(
    `${spreadsheetId}/values/${encodeURIComponent(range)}`,
    accessToken,
    { valueInputOption: "USER_ENTERED" },
    {
      range,
      majorDimension: "ROWS",
      values: [values.map((value) => value ?? "")],
    },
  );
}

export interface GoogleSheetsAppendResult {
  /** A1 range the appended rows landed on, e.g. `'Detailed'!A8282:H8282`. */
  updatedRange: string | null;
  /** 1-based row of the first appended row, parsed out of `updatedRange`. */
  firstRowNumber: number | null;
  updatedRows: number;
}

interface GoogleSheetsAppendResponse {
  updates?: { updatedRange?: string; updatedRows?: number };
  error?: { message?: string };
}

/**
 * Append rows to the end of a sheet's data.
 *
 * `insertDataOption: INSERT_ROWS` makes Google add rows rather than overwrite
 * whatever sits below the table, and `RAW` sends each value with the type it
 * already has — a JS number becomes a numeric cell, a string stays text. That
 * matters when appending to a typed column: `USER_ENTERED` would re-parse the
 * value, and a row whose type differs from its column is treated by QUERY as a
 * minority type and silently dropped from any view built on it.
 */
export async function appendGoogleSheetRows(
  email: string,
  spreadsheetId: string,
  sheetName: string,
  rows: Array<Array<string | number | null>>,
  lastColumn = "H",
): Promise<GoogleSheetsAppendResult> {
  const accessToken = await getGoogleSheetsWriteAccessToken(email);
  const range = `${quoteSheetName(sheetName)}!A:${lastColumn}`;
  const body = await googleSheetsPost<GoogleSheetsAppendResponse>(
    `${spreadsheetId}/values/${encodeURIComponent(range)}:append`,
    accessToken,
    { range, majorDimension: "ROWS", values: rows.map((row) => row.map((cell) => cell ?? "")) },
    {
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      includeValuesInResponse: "false",
    },
  );
  const updatedRange = body.updates?.updatedRange ?? null;
  // `'Tab name'!A8282:H8282` — the row number is what lets a human find the
  // appended line later, and what reconcile records.
  const firstRowNumber = updatedRange
    ? Number(updatedRange.match(/![A-Z]+(\d+)/u)?.[1] ?? "") || null
    : null;
  return { updatedRange, firstRowNumber, updatedRows: body.updates?.updatedRows ?? 0 };
}
