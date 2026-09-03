import type { TraceAnchor } from "./types";

export function buildGoogleSheetTraceUrl(
  spreadsheetId: string,
  sheetId: number,
  a1: string,
): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${sheetId}&range=${encodeURIComponent(a1)}`;
}

export function makeTraceAnchor(input: {
  spreadsheetId: string;
  sheetId: number;
  row: number;
  a1: string;
}): TraceAnchor {
  return {
    ...input,
    url: buildGoogleSheetTraceUrl(input.spreadsheetId, input.sheetId, input.a1),
  };
}
