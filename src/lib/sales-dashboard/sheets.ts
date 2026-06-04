import { getGoogleSheetsAccessToken, getGoogleSheetsWriteAccessToken } from "./google-oauth";

interface GoogleSheetsValuesResponse {
  values?: unknown[][];
  error?: { message?: string };
}

interface GoogleSheetsMetadataResponse {
  sheets?: Array<{ properties?: { title?: string } }>;
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
