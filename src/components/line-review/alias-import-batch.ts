import type { AliasImportPreview, AliasImportPreviewRow } from "./types";

export interface AliasImportPreviewSource {
  sourceType: "text" | "image";
  sourceName: string;
  sourceIndex: number;
  preview: AliasImportPreview;
}

function normalizeDedupeValue(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

export function aliasImportDedupeKey(row: Pick<
  AliasImportPreviewRow,
  "aliasLabel" | "latestMessagePreview" | "timeLabel"
>): string {
  return [
    normalizeDedupeValue(row.aliasLabel),
    normalizeDedupeValue(row.latestMessagePreview),
    normalizeDedupeValue(row.timeLabel),
  ].join("\u001f");
}

export function mergeAliasImportPreviewSources(
  sources: AliasImportPreviewSource[],
): AliasImportPreviewRow[] {
  const seen = new Map<string, AliasImportPreviewRow>();
  const rows: AliasImportPreviewRow[] = [];

  for (const source of sources) {
    for (const row of source.preview.rows) {
      const key = aliasImportDedupeKey(row);
      const existing = seen.get(key);
      if (existing) {
        existing.duplicateCount = (existing.duplicateCount ?? 1) + 1;
        continue;
      }

      const nextRow: AliasImportPreviewRow = {
        ...row,
        rowId: `${source.sourceIndex}:${row.rowId}`,
        sourceType: source.sourceType,
        sourceName: source.sourceName,
        sourceIndex: source.sourceIndex,
        sourceRowId: row.rowId,
        duplicateCount: 1,
      };
      seen.set(key, nextRow);
      rows.push(nextRow);
    }
  }

  return rows;
}
