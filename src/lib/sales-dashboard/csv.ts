export const CSV_UTF8_BOM = "\uFEFF";

export interface CsvColumn<Row> {
  key: string;
  header: string;
  value: (row: Row) => unknown;
}

export interface SerializeCsvOptions {
  includeBom?: boolean;
}

function csvValue(value: unknown): string {
  const normalized = Array.isArray(value)
    ? value.map((item) => String(item ?? "")).join("; ")
    : value instanceof Date
      ? value.toISOString()
      : String(value ?? "");
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function serializeCsv<Row>(
  rows: readonly Row[],
  columns: readonly CsvColumn<Row>[],
  options: SerializeCsvOptions = {},
): string {
  const includeBom = options.includeBom ?? true;
  const csvRows = [
    columns.map((column) => csvValue(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(column.value(row))).join(",")),
  ];
  return `${includeBom ? CSV_UTF8_BOM : ""}${csvRows.join("\r\n")}`;
}

export function sanitizeCsvFilename(filename: string): string {
  const trimmed = filename.trim().replace(/\.csv$/i, "");
  const safe = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safe || "export"}.csv`;
}

export function downloadCsv<Row>(
  filename: string,
  rows: readonly Row[],
  columns: readonly CsvColumn<Row>[],
): void {
  if (columns.length === 0) return;
  const csv = serializeCsv(rows, columns);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeCsvFilename(filename);
  link.click();
  URL.revokeObjectURL(url);
}
