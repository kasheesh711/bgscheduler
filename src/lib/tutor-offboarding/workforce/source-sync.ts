import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WiseApiError } from "@/lib/wise/client";
import { persistWorkforceSourceWindow } from "./observation-store";
import { fetchWorkforceSourceWindow, WorkforceSourceFetchError } from "./wise-source";
import { captureGrowthBookingMetadata } from "./growth/capture";
import { captureGrowthLifecycle } from "./growth/reconcile";
import { normalizeGrowthBookingMetadata } from "./growth/source";
import type { Database } from "@/lib/db";
import type { SourceWindowRequest, SourceWindowResult, WorkforceCompleteness } from "./types";

export type HistorySyncMode = "dry_run" | "apply";
export interface HistorySyncRequest {
  from: string;
  to: string;
  maxRequests: number;
  maxPages: number;
  checkpointPath: string;
  mode: HistorySyncMode;
  /** Spend the bounded run on demand dates before collecting financial evidence. */
  sessionsOnly?: boolean;
  /** Revisit date-complete windows whose financial capture is partial or skipped. */
  refreshCredits?: boolean;
}
export interface HistorySyncWindow {
  from: string;
  to: string;
  status: "complete" | "incomplete" | "failed";
  sourceKey: string | null;
  observedAt: string | null;
  requests: number;
  pages: number;
  persisted: boolean;
  reasonCodes: string[];
  creditCapture?: "complete" | "partial" | "skipped";
}
export interface HistorySyncResult {
  mode: HistorySyncMode;
  requestedWindow: { from: string; to: string };
  completeThrough: string | null;
  complete: boolean;
  creditsComplete: boolean;
  requests: number;
  pages: number;
  windows: HistorySyncWindow[];
  sessions: number;
  creditEvidence: number;
  knownNetCredits: number;
  unknownNetCredits: number;
  knownNormalCredits: number;
  classifiedBookings: number;
  unknownBookingClassifications: number;
  coverage: Array<{ from: string; to: string; completeness: WorkforceCompleteness; issueCodes: string[] }>;
}
interface HistoryCheckpoint {
  version: 1;
  from: string;
  to: string;
  windows: HistorySyncWindow[];
}
export interface HistorySyncDependencies {
  fetchWindow?: (input: SourceWindowRequest) => Promise<SourceWindowResult>;
  persistWindow?: (window: SourceWindowResult) => Promise<unknown>;
  db?: Database;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
function dateMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Dates must use YYYY-MM-DD");
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return ms;
}
function key(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function monthEnd(ms: number): number {
  const current = new Date(ms);
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0);
}
function windows(from: string, to: string): Array<{ from: string; to: string }> {
  const first = dateMs(from), last = dateMs(to);
  if (first > last) throw new Error("from must not be after to");
  const result: Array<{ from: string; to: string }> = [];
  for (let start = first; start <= last;) {
    const end = Math.min(last, monthEnd(start));
    result.push({ from: key(start), to: key(end) });
    start = end + DAY_MS;
  }
  return result;
}
function readCheckpoint(file: string, from: string, to: string): HistoryCheckpoint {
  if (!existsSync(file)) return { version: 1, from, to, windows: [] };
  const value = JSON.parse(readFileSync(file, "utf8")) as HistoryCheckpoint;
  if (value.version !== 1 || value.from !== from || value.to !== to || !Array.isArray(value.windows)) {
    throw new Error("Checkpoint does not match this date range; use a new checkpoint path");
  }
  return value;
}
function writeCheckpoint(file: string, checkpoint: HistoryCheckpoint): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(checkpoint, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}
function checkpointResult(checkpoint: HistoryCheckpoint, mode: HistorySyncMode, requests: number, pages: number, outputs: SourceWindowResult[]): HistorySyncResult {
  const planned = windows(checkpoint.from, checkpoint.to);
  let completeThrough: string | null = null;
  let completePrefix = true;
  for (const period of planned) {
    const stored = checkpoint.windows.find(row => row.from === period.from && row.to === period.to);
    const usable = stored?.status === "complete" && (mode === "dry_run" || stored.persisted);
    if (completePrefix && usable) completeThrough = period.to;
    else completePrefix = false;
  }
  const creditRows = outputs.flatMap(result => result.credits);
  const classifications = outputs.flatMap(result => result.sessions.map(session => normalizeGrowthBookingMetadata(session, session.observedAt ?? result.observedAt)));
  return {
    mode, requestedWindow: { from: checkpoint.from, to: checkpoint.to }, completeThrough,
    complete: completeThrough === checkpoint.to,
    creditsComplete: planned.every(period => checkpoint.windows.some(row => row.from === period.from && row.to === period.to && row.status === "complete" && row.creditCapture === "complete")),
    requests, pages,
    windows: checkpoint.windows, sessions: outputs.reduce((sum, result) => sum + result.sessions.length, 0),
    creditEvidence: creditRows.length, knownNetCredits: creditRows.filter(row => row.netCredits !== null && row.evidenceStatus === "verified").length,
    unknownNetCredits: creditRows.filter(row => row.netCredits === null || row.evidenceStatus !== "verified").length,
    knownNormalCredits: creditRows.filter(row => row.normalCredits !== null).length,
    classifiedBookings: classifications.filter(row => row.classification !== "unknown").length,
    unknownBookingClassifications: classifications.filter(row => row.classification === "unknown").length,
    coverage: outputs.map(result => ({ from: result.requestedWindow.from, to: result.requestedWindow.to, completeness: result.completeness, issueCodes: result.contractIssues })),
  };
}

/** Monthly windows are checkpointed independently; only the contiguous complete prefix advances. */
export async function syncWorkforceHistory(
  input: HistorySyncRequest,
  dependencies: HistorySyncDependencies = {},
): Promise<HistorySyncResult> {
  if (!Number.isInteger(input.maxRequests) || input.maxRequests < 1 || !Number.isInteger(input.maxPages) || input.maxPages < 1) throw new Error("Explicit positive request and page caps are required");
  if (!input.checkpointPath.trim()) throw new Error("checkpointPath is required");
  if (input.sessionsOnly && input.refreshCredits) throw new Error("sessionsOnly and refreshCredits cannot be combined");
  const planned = windows(input.from, input.to);
  const checkpointFile = path.resolve(input.checkpointPath);
  const checkpoint = readCheckpoint(checkpointFile, input.from, input.to);
  const fetchWindow = dependencies.fetchWindow ?? fetchWorkforceSourceWindow;
  const persistWindow = dependencies.persistWindow ?? (async (window: SourceWindowResult) => {
    if (!dependencies.db) throw new Error("Database is required in apply mode");
    return persistWorkforceSourceWindow(dependencies.db, window);
  });
  let requests = 0, pages = 0;
  const outputs: SourceWindowResult[] = [];

  for (const period of planned) {
    const prior = checkpoint.windows.find(row => row.from === period.from && row.to === period.to);
    if (prior?.status === "complete" && (input.mode === "dry_run" || prior.persisted)
      && (!input.refreshCredits || prior.creditCapture === "complete")) continue;
    const remainingRequests = input.maxRequests - requests;
    const remainingPages = input.maxPages - pages;
    if (remainingRequests <= 0 || remainingPages <= 0) {
      const failed: HistorySyncWindow = { from: period.from, to: period.to, status: "incomplete", sourceKey: null, observedAt: null, requests: 0, pages: 0, persisted: false, reasonCodes: [remainingRequests <= 0 ? "REQUEST_CAP_EXHAUSTED" : "PAGE_CAP_EXHAUSTED"] };
      const checkpointRow = prior?.status === "complete" && prior.persisted
        ? { ...prior, creditCapture: "partial" as const, reasonCodes: [...new Set([...prior.reasonCodes, ...failed.reasonCodes])] }
        : failed;
      checkpoint.windows = [...checkpoint.windows.filter(row => row.from !== period.from || row.to !== period.to), checkpointRow].sort((a, b) => a.from.localeCompare(b.from));
      writeCheckpoint(checkpointFile, checkpoint);
      break;
    }
    try {
      const source = await fetchWindow({ from: period.from, to: period.to, maxRequests: remainingRequests, maxPages: remainingPages, ...(input.sessionsOnly ? { creditExamples: [] } : {}) });
      requests += source.paging.requests;
      pages += source.paging.pagesReturned;
      const result = { ...source, sourceKey: `wise-history:${period.from}:${period.to}:${source.observedAt}` };
      outputs.push(result);
      let persisted = false;
      if (input.mode === "apply") {
        await persistWindow(result);
        persisted = true;
        if (result.complete && result.completeness === "complete" && !result.truncated && dependencies.db) {
          try {
            await captureGrowthBookingMetadata(dependencies.db, result.sessions, result.observedAt);
            await captureGrowthLifecycle(dependencies.db, new Date(result.observedAt));
          } catch (error) {
            const safeName = error instanceof Error ? error.name : "UnknownError";
            console.error(`[workforce-sync] growth evidence capture failed (${safeName})`);
          }
        }
      }
      const status: HistorySyncWindow["status"] = result.complete && result.completeness === "complete" && !result.truncated ? "complete" : "incomplete";
      const missingCredit = result.sessions.some(session => session.wiseClassId && (session.historicalBookedStudentIds ?? []).some(studentId =>
        !result.credits.some(credit => credit.wiseSessionId === session.wiseSessionId && credit.wiseStudentId === studentId)));
      const creditCapture = input.sessionsOnly ? "skipped" as const
        : status !== "complete" || missingCredit || result.contractIssues.some(code => ["CREDIT_EXAMPLE_REQUEST_CAP_EXHAUSTED", "SESSION_CREDIT_FETCH_FAILED", "SESSION_CREDIT_HISTORY_NOT_EXPOSED"].includes(code))
          ? "partial" as const : "complete" as const;
      const row: HistorySyncWindow = { from: period.from, to: period.to, status, creditCapture, sourceKey: result.sourceKey, observedAt: result.observedAt, requests: result.paging.requests, pages: result.paging.pagesReturned, persisted, reasonCodes: result.contractIssues };
      const checkpointRow = prior?.status === "complete" && prior.persisted && status !== "complete"
        ? { ...prior, creditCapture: "partial" as const, reasonCodes: [...new Set([...prior.reasonCodes, ...row.reasonCodes])] }
        : row;
      checkpoint.windows = [...checkpoint.windows.filter(item => item.from !== period.from || item.to !== period.to), checkpointRow].sort((a, b) => a.from.localeCompare(b.from));
      writeCheckpoint(checkpointFile, checkpoint);
      if (status === "incomplete" && (result.contractIssues.includes("REQUEST_CAP_EXHAUSTED") || result.contractIssues.includes("PAGE_CAP_EXHAUSTED"))) break;
    } catch (error) {
      const sourceError = error instanceof WorkforceSourceFetchError ? error.sourceError : error;
      const failedRequests = error instanceof WorkforceSourceFetchError ? error.requests : 0;
      const failedPages = error instanceof WorkforceSourceFetchError ? error.pagesReturned : 0;
      requests += failedRequests;
      pages += failedPages;
      const status429 = sourceError instanceof WiseApiError && sourceError.status === 429;
      const row: HistorySyncWindow = { from: period.from, to: period.to, status: "failed", sourceKey: null, observedAt: (dependencies.now?.() ?? new Date()).toISOString(), requests: failedRequests, pages: failedPages, persisted: false, reasonCodes: [status429 ? "WISE_RATE_LIMITED" : "SOURCE_FETCH_FAILED"] };
      const checkpointRow = prior?.status === "complete" && prior.persisted
        ? { ...prior, creditCapture: "partial" as const, reasonCodes: [...new Set([...prior.reasonCodes, ...row.reasonCodes])] }
        : row;
      checkpoint.windows = [...checkpoint.windows.filter(item => item.from !== period.from || item.to !== period.to), checkpointRow].sort((a, b) => a.from.localeCompare(b.from));
      writeCheckpoint(checkpointFile, checkpoint);
      // Consumption before a thrown page cannot be recovered from every adapter.
      // Stop here so another window never receives an overstated remaining cap.
      break;
    }
  }
  if (!existsSync(checkpointFile)) writeCheckpoint(checkpointFile, checkpoint);
  return checkpointResult(checkpoint, input.mode, requests, pages, outputs);
}
