import { createHash } from "node:crypto";

export interface PayoutFormulaBackupEntry {
  canonicalKey: string;
  spreadsheetId: string;
  sheetName: string;
  sheetGid: number;
  tutorCell: string;
  detailFormula: string;
  totalFormula: string;
  repointedDetailFormula: string;
  repointedTotalFormula: string;
}

export interface PayoutFormulaBackupArtifact {
  version: 1;
  createdAt: string;
  environmentTarget: "scratch" | "production";
  masterSpreadsheetId: string;
  sourceSheetName: string;
  compositeSheetName: string;
  fleetSha256: string;
  entries: PayoutFormulaBackupEntry[];
}

export function payoutFormulaFleetSha256(
  entries: readonly PayoutFormulaBackupEntry[],
): string {
  const canonical = [...entries]
    .toSorted((left, right) =>
      left.canonicalKey.localeCompare(right.canonicalKey)
      || left.spreadsheetId.localeCompare(right.spreadsheetId))
    .map((entry) => ({
      canonicalKey: entry.canonicalKey,
      spreadsheetId: entry.spreadsheetId,
      sheetName: entry.sheetName,
      sheetGid: entry.sheetGid,
      tutorCell: entry.tutorCell,
      detailFormula: entry.detailFormula,
      totalFormula: entry.totalFormula,
      repointedDetailFormula: entry.repointedDetailFormula,
      repointedTotalFormula: entry.repointedTotalFormula,
    }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
