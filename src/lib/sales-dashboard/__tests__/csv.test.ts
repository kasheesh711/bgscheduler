import { describe, expect, it } from "vitest";
import {
  CSV_UTF8_BOM,
  sanitizeCsvFilename,
  serializeCsv,
  type CsvColumn,
} from "../csv";

interface Row {
  name: string;
  amount: number | null;
  tags: string[];
  note?: string;
}

const columns: CsvColumn<Row>[] = [
  { key: "name", header: "Name", value: (row) => row.name },
  { key: "amount", header: "Amount", value: (row) => row.amount },
  { key: "tags", header: "Tags", value: (row) => row.tags },
  { key: "note", header: "Note", value: (row) => row.note },
];

describe("serializeCsv", () => {
  it("serializes rows with stable column order, quoted values, and CRLF line endings", () => {
    const csv = serializeCsv([
      { name: "Mint", amount: 1200, tags: ["Math", "G8"], note: "Paid" },
    ], columns, { includeBom: false });

    expect(csv).toBe('"Name","Amount","Tags","Note"\r\n"Mint","1200","Math; G8","Paid"');
  });

  it("escapes quotes, commas, newlines, nulls, and Unicode text", () => {
    const csv = serializeCsv([
      {
        name: "น้อง \"Mint\", Jr.",
        amount: null,
        tags: ["ไทย", "Inter"],
        note: "Line 1\nLine 2",
      },
    ], columns);

    expect(csv.startsWith(CSV_UTF8_BOM)).toBe(true);
    expect(csv).toContain('"น้อง ""Mint"", Jr."');
    expect(csv).toContain('"ไทย; Inter"');
    expect(csv).toContain('""');
    expect(csv).toContain('"Line 1\nLine 2"');
  });

  it("emits a header-only CSV when there are no rows", () => {
    expect(serializeCsv([], columns, { includeBom: false })).toBe('"Name","Amount","Tags","Note"');
  });
});

describe("sanitizeCsvFilename", () => {
  it("removes unsafe filename characters and preserves a csv extension", () => {
    expect(sanitizeCsvFilename(' sales/report: "June"*?.csv ')).toBe("sales-report-June.csv");
  });

  it("falls back when the filename is blank after sanitizing", () => {
    expect(sanitizeCsvFilename("???.csv")).toBe("export.csv");
  });
});
