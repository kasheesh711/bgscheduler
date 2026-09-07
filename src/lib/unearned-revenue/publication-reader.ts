import "server-only";

import { getGoogleDriveAccessToken } from "@/lib/sales-dashboard/google-oauth";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import { parseValuesPublication, publicationManifestSchema, sha256, statusFields, verifiedFile } from "./publication";

export async function readPublicationFile(email: string, fileId: string, maxBytes = 30_000_000): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error("Invalid publication Drive file ID");
  const accessToken = await getGoogleDriveAccessToken(email);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Publication file is inaccessible (${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Publication file exceeds its byte limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Publication file has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("Publication file exceeds its byte limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readValuesPublication(email: string, spreadsheetId: string, statusStart: unknown[][], statusSheetId: number) {
  const fields = statusFields(statusStart);
  const manifestBytes = await readPublicationFile(email, fields.manifest_file_id, 2_000_000);
  if (sha256(manifestBytes) !== fields.manifest_sha256) throw new Error("Publication manifest checksum mismatch");
  const manifest = publicationManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const [contractBytes, auditBytes] = await Promise.all([
    readPublicationFile(email, manifest.contract.fileId), readPublicationFile(email, manifest.audit.fileId),
  ]);
  verifiedFile(auditBytes, manifest.audit);
  for (const month of manifest.months) {
    const sheets = await listGoogleSheetProperties(email, month.spreadsheetId);
    if (![month.overviewSheetId, month.studentSheetId, month.packageSheetId].every(id => sheets.some(sheet => sheet.sheetId === id))) throw new Error("Published monthly report is missing a required tab");
  }
  const [statusEnd, properties] = await Promise.all([
    fetchGoogleSheetRange(email, spreadsheetId, "'Model Status'!A1:C202"),
    listGoogleSheetProperties(email, spreadsheetId),
  ]);
  if (properties.find(sheet => sheet.title === "Model Status")?.sheetId !== statusSheetId) throw new Error("Publication status tab changed during import");
  const { contract, metadata } = parseValuesPublication({ manifest, contractBytes, statusStart, statusEnd });
  return {
    contract, publicationManifest: metadata,
    // Legacy DB columns remain readable during rollback. V5 links are resolved
    // from the immutable manifest, never from these legacy formula addresses.
    sheetIds: Object.fromEntries(["Model Comparison", "CALC_Student_Period", "CALC_Account_Period", "CALC_Package_Lot_Period", "SRC_Wise_Receipt", "CALC_Exact_Package_Overview"].map(name => [name, statusSheetId])),
  };
}
