import { describe, expect, it } from "vitest";
import {
  aliasImportDedupeKey,
  mergeAliasImportPreviewSources,
  type AliasImportPreviewSource,
} from "@/components/line-review/alias-import-batch";
import type { AliasImportPreview, AliasImportPreviewRow } from "@/components/line-review/types";

function row(overrides: Partial<AliasImportPreviewRow>): AliasImportPreviewRow {
  return {
    rowId: "row-1",
    aliasLabel: "Maida/Nasda.Su",
    latestMessagePreview: "คุณแม่สะดวกชำระเป็นรายครั้งได้เลย...",
    timeLabel: "11:06",
    rawText: "raw",
    parsedCodes: [],
    suggestedStudents: [],
    contactCandidates: [],
    autoSelectedContactId: null,
    ...overrides,
  };
}

function source(input: {
  sourceName: string;
  sourceIndex: number;
  rows: AliasImportPreviewRow[];
}): AliasImportPreviewSource {
  return {
    sourceType: "image",
    sourceName: input.sourceName,
    sourceIndex: input.sourceIndex,
    preview: {
      source: "image",
      rows: input.rows,
    } satisfies AliasImportPreview,
  };
}

describe("LINE alias import batch merging", () => {
  it("deduplicates the same alias, preview, and time across screenshots", () => {
    const rows = mergeAliasImportPreviewSources([
      source({ sourceName: "shot-1.png", sourceIndex: 0, rows: [row({ rowId: "a" })] }),
      source({ sourceName: "shot-2.png", sourceIndex: 1, rows: [row({ rowId: "b" })] }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowId: "0:a",
      sourceName: "shot-1.png",
      duplicateCount: 2,
    });
  });

  it("keeps the same alias when preview or time differs", () => {
    const rows = mergeAliasImportPreviewSources([
      source({ sourceName: "shot-1.png", sourceIndex: 0, rows: [row({ rowId: "a" })] }),
      source({
        sourceName: "shot-2.png",
        sourceIndex: 1,
        rows: [row({
          rowId: "b",
          latestMessagePreview: "You sent a sticker.",
          timeLabel: "11:03",
        })],
      }),
    ]);

    expect(rows.map((item) => item.rowId)).toEqual(["0:a", "1:b"]);
  });

  it("uses normalized values for conservative exact-row dedupe keys", () => {
    expect(aliasImportDedupeKey(row({ aliasLabel: " Maida/Nasda.Su " }))).toBe(
      aliasImportDedupeKey(row({ aliasLabel: "maida/nasda.su" })),
    );
  });
});
