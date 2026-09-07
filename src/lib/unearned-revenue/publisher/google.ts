import { getGoogleDriveAccessToken, getGoogleSheetsWriteAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { displayed, HEAD_ROWS, type Cell, type ReportTab } from "./layout";

export interface SheetProperty { sheetId: number; title: string; hidden?: boolean; gridProperties: { rowCount: number; columnCount: number } }
export interface SheetMetadata { spreadsheetId: string; sheets: Array<{ properties: SheetProperty; protectedRanges?: Array<{ protectedRangeId: number }> }> }
export interface Audience { type: "user" | "group"; emailAddress: string; role: "reader" | "writer" }
export class PublicationGoogle {
  private token = "";
  private nextWrite = 0;
  private connectedAt = 0;
  readonly pendingAudience: string[] = [];
  constructor(readonly email: string, readonly audience: Audience[]) {}
  async connect() {
    await getGoogleSheetsWriteAccessToken(this.email);
    this.token = await getGoogleDriveAccessToken(this.email);
    this.connectedAt = Date.now();
  }
  async request<T>(service: "sheets" | "drive", path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    if (Date.now() - this.connectedAt > 30 * 60_000) await this.connect();
    const base = service === "sheets" ? "https://sheets.googleapis.com/v4/" : "https://www.googleapis.com/";
    for (let attempt = 0; attempt < 7; attempt++) {
      if (method !== "GET" && service === "sheets") {
        const delay = this.nextWrite - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        this.nextWrite = Date.now() + 1_100;
      }
      const response = await fetch(base + path, {
        method, headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
        body: body instanceof Buffer ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await response.text();
      let result: { error?: { message?: string } };
      try { result = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Invalid Google API response (${response.status})`); }
      if (response.ok) return result as T;
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 6) {
        const delay = Math.min(32_000, 2_000 * 2 ** attempt);
        process.stderr.write(`Google ${service} retry after ${response.status}; waiting ${delay / 1000}s\n`);
        await new Promise(resolve => setTimeout(resolve, delay)); continue;
      }
      throw new Error(`Google ${service} ${response.status}: ${result.error?.message ?? "request failed"}`);
    }
    throw new Error("Google retry limit reached");
  }
  metadata(id: string): Promise<SheetMetadata> {
    return this.request("sheets", `spreadsheets/${id}?fields=spreadsheetId,sheets(properties,protectedRanges(protectedRangeId))`);
  }
  async values(id: string, range: string): Promise<Array<Array<string | number | boolean | null>>> {
    const result = await this.request<{ values?: Array<Array<string | number | boolean | null>> }>("sheets", `spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return result.values ?? [];
  }
  batch(id: string, requests: unknown[]) { return this.request("sheets", `spreadsheets/${id}:batchUpdate`, "POST", { requests }); }
  async bytes(id: string, limit = 30_000_000): Promise<Buffer> {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) throw new Error(`Archive is inaccessible (${response.status})`);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length; if (size > limit) throw new Error("Archive exceeds file budget"); chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async createFile(name: string, mimeType: string, folderId?: string) {
    return this.request<{ id: string }>("drive", "drive/v3/files?fields=id", "POST", { name, mimeType, ...(folderId ? { parents: [folderId] } : {}) });
  }
  async findFolder(name: string, parent?: string): Promise<string | null> {
    const q = `name = '${name.replaceAll("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parent ? ` and '${parent}' in parents` : " and 'root' in parents"}`;
    const result = await this.request<{ files: Array<{ id: string }> }>("drive", `drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=100`);
    if (result.files.length > 1) throw new Error(`Multiple publisher folders named ${name}; specify --folder-id`);
    return result.files[0]?.id ?? null;
  }
  async ensureFolder(): Promise<string> {
    const root = await this.findFolder("ChatGPT") ?? (await this.createFile("ChatGPT", "application/vnd.google-apps.folder")).id;
    const id = await this.findFolder("BeGifted Unearned Revenue", root) ?? (await this.createFile("BeGifted Unearned Revenue", "application/vnd.google-apps.folder", root)).id;
    await this.share(id, true);
    return id;
  }
  async share(id: string, preparing = false) {
    const { permissions } = await this.request<{ permissions: Array<{ emailAddress?: string; role: string }> }>("drive", `drive/v3/files/${id}/permissions?fields=permissions(emailAddress,role)`);
    for (const grant of this.audience) {
      if (grant.emailAddress === this.email || permissions.some(p => p.emailAddress?.toLowerCase() === grant.emailAddress.toLowerCase())) continue;
      try { await this.request("drive", `drive/v3/files/${id}/permissions?sendNotificationEmail=false`, "POST", grant); }
      catch (error) {
        if (!preparing || !(error instanceof Error) || !error.message.includes("do not have a Google Account")) throw error;
        this.pendingAudience.push(grant.emailAddress);
        process.stderr.write(`Finance access pending: ${grant.emailAddress}; Google requires a visitor invitation. Cutover is blocked until access is resolved.\n`);
      }
    }
  }
  async upload(folderId: string, name: string, bytes: Buffer, mimeType = "application/gzip") {
    const boundary = `ur-${crypto.randomUUID()}`;
    const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const body = Buffer.concat([header, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return this.request<{ id: string }>("drive", "upload/drive/v3/files?uploadType=multipart&fields=id", "POST", body, { "Content-Type": `multipart/related; boundary=${boundary}` });
  }
  async createWorkbook(folderId: string, name: string, tabs: ReportTab[]): Promise<string> {
    const { id } = await this.createFile(name, "application/vnd.google-apps.spreadsheet", folderId);
    const existing = await this.metadata(id);
    await this.batch(id, [
      { updateSpreadsheetProperties: { properties: { locale: "en_US", timeZone: "Asia/Bangkok" }, fields: "locale,timeZone" } },
      ...tabs.map(tab => ({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title, gridProperties: { rowCount: tab.rows.length, columnCount: tab.widths.length, frozenRowCount: HEAD_ROWS, hideGridlines: true } } } })),
      ...existing.sheets.map(sheet => ({ deleteSheet: { sheetId: sheet.properties.sheetId } })),
    ]);
    return id;
  }
  async writeTabs(id: string, tabs: ReportTab[]) {
    for (const tab of tabs) {
      for (let start = 0; start < tab.rows.length; start += 1_000) {
        await this.batch(id, [{ updateCells: { start: { sheetId: tab.sheetId, rowIndex: start, columnIndex: 0 }, rows: tab.rows.slice(start, start + 1_000).map(row => ({ values: Array.from({ length: tab.widths.length }, (_, i) => enteredCell(row[i])) })), fields: "userEnteredValue" } }]);
      }
      await this.batch(id, formatRequests(tab, this.email));
    }
  }
  async verifyTabs(id: string, tabs: ReportTab[]) {
    for (const tab of tabs) {
      const actual = await this.values(id, `'${tab.title.replaceAll("'", "''")}'!A1:${columnName(tab.widths.length)}${tab.rows.length}`);
      for (let row = 0; row < tab.rows.length; row++) for (let col = 0; col < tab.widths.length; col++) {
        const expected = displayed(tab.rows[row][col]);
        const observed = actual[row]?.[col] ?? null;
        if (typeof expected === "number" ? typeof observed !== "number" || Math.abs(expected - observed) > 0.000001 : String(expected ?? "") !== String(observed ?? "")) {
          throw new Error(`Published report verification failed: ${tab.title} row ${row + 1} column ${col + 1}`);
        }
      }
    }
  }
  async refreshPreparedLinks(id: string, tabs: ReportTab[]) {
    // Only called for this run's unpublished drafts. Published revisions are
    // immutable and are never sent through this path.
    for (const tab of tabs) {
      await this.batch(id, [
        { updateCells: { start: { sheetId: tab.sheetId, rowIndex: 0, columnIndex: 0 }, rows: tab.rows.slice(0, 4).map(row => ({ values: row.map(enteredCell) })), fields: "userEnteredValue" } },
        ...headerPresentationRequests(tab),
      ]);
      if (tab.sheetId !== 2) continue;
      for (let start = HEAD_ROWS; start < tab.rows.length; start += 1_000) {
        await this.batch(id, [{ updateCells: { start: { sheetId: tab.sheetId, rowIndex: start, columnIndex: 3 }, rows: tab.rows.slice(start, start + 1_000).map(row => ({ values: [enteredCell(row[3])] })), fields: "userEnteredValue" } }]);
      }
    }
  }
}

export function columnName(index: number): string {
  let result = "";
  while (index > 0) { index--; result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26); }
  return result;
}
export function enteredCell(value: Cell | undefined) {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") {
    if (!/^https:\/\/(docs|drive)\.google\.com\//.test(value.link)) throw new Error("Invalid report evidence URL");
    return { userEnteredValue: { formulaValue: `=HYPERLINK("${value.link.replaceAll('"', '""')}","${value.label.replaceAll('"', '""')}")` } };
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Report contains a non-finite amount");
  return { userEnteredValue: typeof value === "number" ? { numberValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } };
}
export function formatRequests(tab: ReportTab, owner: string): unknown[] {
  const range = { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: tab.rows.length, startColumnIndex: 0, endColumnIndex: tab.widths.length };
  const data = { ...range, startRowIndex: HEAD_ROWS - 1 };
  const requests: unknown[] = [
    { repeatCell: { range, cell: { userEnteredFormat: { textFormat: { fontFamily: "Arial", fontSize: 11 }, verticalAlignment: "MIDDLE", wrapStrategy: "CLIP" } }, fields: "userEnteredFormat" } },
    { repeatCell: { range: { ...range, startRowIndex: HEAD_ROWS - 1, endRowIndex: HEAD_ROWS }, cell: { userEnteredFormat: { backgroundColor: { red: 0.93, green: 0.94, blue: 0.95 }, textFormat: { bold: true } } }, fields: "userEnteredFormat(backgroundColor,textFormat.bold)" } },
    { repeatCell: { range: { ...range, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }, fields: "userEnteredFormat.textFormat" } },
    { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 0, endIndex: tab.rows.length }, properties: { pixelSize: 30 }, fields: "pixelSize" } },
    { setBasicFilter: { filter: { range: data } } },
    { addProtectedRange: { protectedRange: { range, description: "Validated published finance results", warningOnly: false, editors: { users: [owner] } } } },
  ];
  tab.widths.forEach((width, i) => requests.push({ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: width }, fields: "pixelSize" } }));
  for (const col of tab.moneyColumns) requests.push({ repeatCell: { range: { ...range, startRowIndex: HEAD_ROWS, startColumnIndex: col, endColumnIndex: col + 1 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00;[Red](#,##0.00)" } } }, fields: "userEnteredFormat.numberFormat" } });
  requests.push({ repeatCell: { range: { ...range, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" }, textFormat: { bold: true } } }, fields: "userEnteredFormat.numberFormat,userEnteredFormat.textFormat.bold" } });
  if (tab.title !== "ภาพรวม") requests.push({ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: tab.widths.length - 1, endIndex: tab.widths.length }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } });
  requests.push(...headerPresentationRequests(tab));
  return requests;
}

function headerPresentationRequests(tab: ReportTab): unknown[] {
  const endColumnIndex = tab.widths.length - (tab.title === "ภาพรวม" || tab.widths.length === 6 ? 0 : 1);
  const title = { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex };
  const note = { sheetId: tab.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 2, endColumnIndex };
  return [
    { unmergeCells: { range: title } }, { mergeCells: { range: title, mergeType: "MERGE_ALL" } },
    { unmergeCells: { range: note } }, { mergeCells: { range: note, mergeType: "MERGE_ALL" } },
    { repeatCell: { range: note, cell: { userEnteredFormat: { wrapStrategy: "WRAP", textFormat: { fontSize: 10 } } }, fields: "userEnteredFormat(wrapStrategy,textFormat.fontSize)" } },
    { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 42 }, fields: "pixelSize" } },
  ];
}
