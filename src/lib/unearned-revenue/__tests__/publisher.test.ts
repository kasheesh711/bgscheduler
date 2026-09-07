import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({}));
import { splitMonth, allocatedCells, buildReportTabs, MAIN_IDS, type MonthData } from "../publisher/layout";
import { buildCommitRequests, capacityPlan, dateFilterRequests, validateDailyBundle } from "../publisher/publish";
import { enteredCell, type SheetMetadata } from "../publisher/google";

function data(): MonthData {
  return { finance: ["2026-03-01", "2026-03-02"].map(date => ({ date, liability_thb: 10, student_count: 2 })), students: ["2026-03-01", "2026-03-02"].flatMap(date => [{ date, student_id: "1", student_name: "นักเรียน", liability_thb: 10 }, { date, student_id: "2", student_name: "Zero", liability_thb: 0 }]), packages: ["2026-03-01", "2026-03-02"].map(date => ({ date, student_id: "1", student_name: "นักเรียน", liability_thb: 10, account_id: "a", class_name: "Math", lot_id: "l", package_name: "ยอดยกมา", kind: "OPENING", purchase_date: null, transaction_number: "", remaining_credits: 1, source_url: "", credit_url: "" })) };
}
function tabs() { return buildReportTabs({ data: data(), spreadsheetId: "test-report-id", ids: MAIN_IDS, generatedAt: "2026-03-03", auditUrl: "https://drive.google.com/file/d/audit-id-123/view", mainUrl: "https://docs.google.com/spreadsheets/d/main-id-123/edit" }).tabs; }
const metadata: SheetMetadata = { spreadsheetId: "main-id-123", sheets: [
  { properties: { sheetId: 797927364, title: "Package Control", gridProperties: { rowCount: 20_000, columnCount: 19 } } },
  { properties: { sheetId: 2000001001, title: "Model Status", gridProperties: { rowCount: 200, columnCount: 3 } } },
  { properties: { sheetId: 9, title: "Legacy Evidence", gridProperties: { rowCount: 200_000, columnCount: 20 } } },
] };

describe("compact Finance publisher", () => {
  it("splits only at complete day boundaries and counts header grids", () => {
    const one = { finance: data().finance.slice(0, 1), students: data().students.slice(0, 2), packages: data().packages.slice(0, 1) };
    const parts = splitMonth(data(), allocatedCells(one));
    expect(parts).toHaveLength(2);
    expect(parts.every(part => part.students.every(row => row.date === part.finance[0].date))).toBe(true);
    expect(() => splitMonth(data(), allocatedCells(one) - 1)).toThrow(/exceeds/);
  });
  it("keeps zero students and links a date to a filter and student to package rows", () => {
    const report = tabs();
    expect(report[1].rows.some(row => row[1] === "Zero" && row[2] === 0)).toBe(true);
    expect(report[0].rows[5][3]).toMatchObject({ link: expect.stringContaining("fvid=202603011") });
    expect(report[1].rows[5][3]).toMatchObject({ link: expect.stringContaining("range=A6:L6") });
    expect(dateFilterRequests(report, data())).toHaveLength(4);
  });
  it("rejects an incomplete or inconsistent daily bundle", () => {
    const source = { schemaVersion: 5, status: { canonical_model: "LEGACY_ACCOUNT_RATE", published_cutoff: "2026-03-02" }, reports: { months: { "2026-03": data() }, finance: data().finance } };
    expect(() => validateDailyBundle(source as never)).not.toThrow();
    source.reports.months["2026-03"].packages[0].liability_thb = 12;
    expect(() => validateDailyBundle(source as never)).toThrow(/mismatch/);
  });
  it("counts all old, staged and destination grids before publishing", () => {
    expect(capacityPlan(metadata, tabs()).finalCells).toBeLessThan(1_000_000);
    const huge = structuredClone(metadata); huge.sheets[2].properties.gridProperties.rowCount = 500_000;
    expect(() => capacityPlan(huge, tabs())).toThrow(/capacity/);
  });
  it("commits displayed results and marker together while preserving control IDs", () => {
    const requests = buildCommitRequests(metadata, tabs(), [101, 102, 103], [["field", "value"], ["run_id", "revision-2"]], [["", "", "", "", "", "", "", "", "", "", "account_id"]], [], "owner@example.com") as Array<{ updateCells?: { range?: { sheetId: number } }; copyPaste?: unknown; deleteSheet?: { sheetId: number } }>;
    expect(requests.some(r => r.updateCells?.range?.sheetId === 2000001001)).toBe(true);
    expect(requests.filter(r => r.copyPaste)).toHaveLength(3);
    expect(requests.filter(r => r.deleteSheet).map(r => r.deleteSheet!.sheetId)).toEqual([9, 101, 102, 103]);
    expect(requests.some(r => r.deleteSheet?.sheetId === 797927364)).toBe(false);
  });
  it("preserves source text rather than evaluating spreadsheet injection", () => {
    expect(enteredCell("=IMPORTXML(\"url\")")).toEqual({ userEnteredValue: { stringValue: "=IMPORTXML(\"url\")" } });
    expect(() => enteredCell({ label: "x", link: "https://example.com" })).toThrow(/URL/);
  });
});
