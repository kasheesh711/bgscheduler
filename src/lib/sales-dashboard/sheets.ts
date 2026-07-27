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
): Promise<T> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
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
