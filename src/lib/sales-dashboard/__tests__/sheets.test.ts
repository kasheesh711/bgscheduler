import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../google-oauth", () => ({
  getGoogleSheetsAccessToken: vi.fn(),
  getGoogleSheetsWriteAccessToken: vi.fn(),
}));

import {
  getGoogleSheetsAccessToken,
  getGoogleSheetsWriteAccessToken,
} from "../google-oauth";
import {
  appendGoogleSheetRows,
  batchUpdateGoogleSheetValues,
  batchUpdateGoogleSpreadsheet,
  fetchGoogleSheetRange,
  updateGoogleSheetRangeValues,
} from "../sheets";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google Sheets HTTP helpers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoogleSheetsAccessToken).mockResolvedValue("read-token");
    vi.mocked(getGoogleSheetsWriteAccessToken).mockResolvedValue("write-token");
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes a bounded range and sends explicit render options", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      values: [["=SUM(H9:H)"]],
    }));

    await expect(fetchGoogleSheetRange(
      "finance@example.com",
      "sheet-123",
      "'Finance''s Detail'!A1:H12",
      {
        valueRenderOption: "FORMULA",
        dateTimeRenderOption: "FORMATTED_STRING",
      },
    )).resolves.toEqual([["=SUM(H9:H)"]]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/"
      + "'Finance''s%20Detail'!A1%3AH12"
      + "?majorDimension=ROWS&valueRenderOption=FORMULA"
      + "&dateTimeRenderOption=FORMATTED_STRING",
    );
    expect(init).toEqual({
      headers: { Authorization: "Bearer read-token" },
    });
  });

  it("sends the selected input option and exact rectangular values payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      updatedRange: "'Finance''s Detail'!B4:B5",
      updatedCells: 2,
    }));

    await updateGoogleSheetRangeValues(
      "finance@example.com",
      "sheet-123",
      "'Finance''s Detail'!B4:B5",
      [[46229], [null]],
      "RAW",
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/"
      + "'Finance''s%20Detail'!B4%3AB5?valueInputOption=RAW",
    );
    expect(init).toMatchObject({
      method: "PUT",
      headers: {
        Authorization: "Bearer write-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      range: "'Finance''s Detail'!B4:B5",
      majorDimension: "ROWS",
      values: [[46229], [""]],
    });
  });

  it("sends an atomic values batch with structured ranges", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      totalUpdatedCells: 2,
    }));

    await batchUpdateGoogleSheetValues(
      "finance@example.com",
      "sheet-123",
      [
        { range: "'Payouts'!A9", values: [["=QUERY(...)"]] },
        { range: "'Payouts'!B6", values: [["=SUM(H9:H)"]] },
      ],
      "USER_ENTERED",
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values:batchUpdate",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer write-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      valueInputOption: "USER_ENTERED",
      includeValuesInResponse: false,
      data: [
        {
          range: "'Payouts'!A9",
          majorDimension: "ROWS",
          values: [["=QUERY(...)"]],
        },
        {
          range: "'Payouts'!B6",
          majorDimension: "ROWS",
          values: [["=SUM(H9:H)"]],
        },
      ],
    });
  });

  it("appends RAW rows without inserting and shifting referenced ranges", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      updates: {
        updatedRange: "'Feedback Deductions'!A2:H2",
        updatedRows: 1,
      },
    }));

    await expect(appendGoogleSheetRows(
      "finance@example.com",
      "sheet-123",
      "Feedback Deductions",
      [["Kevin", "Feedback deduction", "Student", 46228, 0.25, "—", 0, -100]],
    )).resolves.toEqual({
      updatedRange: "'Feedback Deductions'!A2:H2",
      firstRowNumber: 2,
      updatedRows: 1,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/"
      + "'Feedback%20Deductions'!A%3AH:append"
      + "?valueInputOption=RAW&insertDataOption=OVERWRITE"
      + "&includeValuesInResponse=false",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer write-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      range: "'Feedback Deductions'!A:H",
      majorDimension: "ROWS",
      values: [["Kevin", "Feedback deduction", "Student", 46228, 0.25, "—", 0, -100]],
    });
  });

  it("sends structural requests without stringifying them", async () => {
    const requests = [{
      addSheet: {
        properties: {
          title: "Feedback Deductions",
          gridProperties: { rowCount: 1_000, columnCount: 8 },
        },
      },
    }];

    await batchUpdateGoogleSpreadsheet(
      "finance@example.com",
      "sheet-123",
      requests,
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-123:batchUpdate",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer write-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({ requests });
  });

  it("propagates the Google error message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error: { message: "Invalid addSheet request." },
    }));

    await expect(batchUpdateGoogleSpreadsheet(
      "finance@example.com",
      "sheet-123",
      [{ addSheet: { properties: {} } }],
    )).rejects.toThrow("Invalid addSheet request.");
  });

  it("performs no token lookup or network call for empty batches", async () => {
    await expect(batchUpdateGoogleSheetValues(
      "finance@example.com",
      "sheet-123",
      [],
      "RAW",
    )).resolves.toEqual({
      totalUpdatedCells: 0,
      responses: [],
    });
    await expect(batchUpdateGoogleSpreadsheet(
      "finance@example.com",
      "sheet-123",
      [],
    )).resolves.toEqual({ replies: [] });

    expect(getGoogleSheetsWriteAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
