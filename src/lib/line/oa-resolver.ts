import { createHash, randomBytes, randomUUID } from "crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  listCurrentLineStudents,
  normalizeLineStudentCode,
  type LineStudentDirectoryRow,
  type LineStudentLinkActor,
} from "@/lib/line/student-links";

export type LineOaResolverRunStatus = "active" | "committed" | "expired";
export type LineOaResolverRowStatus =
  | "pending"
  | "matched"
  | "ambiguous"
  | "no_match"
  | "error"
  | "needs_manual_code"
  | "committed";

export interface LineOaChatUrlParts {
  lineOaAccountId: string;
  lineUserId: string;
}

export type LineOaRelationshipRole = "mom" | "dad" | "secretary" | "other" | "unknown";

export interface LineOaResolverCandidateContact extends LineOaChatUrlParts {
  lineChatUrl: string;
  chatTitle: string | null;
  adminNoteRaw: string | null;
  relationshipRole: LineOaRelationshipRole;
  candidateRank: number;
  captureMode: string | null;
  matchMode: string | null;
  searchCode: string | null;
  siblingFanout?: boolean;
}

export interface LineOaResolverRowDto {
  id: string;
  runId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  searchCode: string | null;
  status: LineOaResolverRowStatus;
  lineOaAccountId: string | null;
  lineUserId: string | null;
  lineChatUrl: string | null;
  chatTitle: string | null;
  matchMode: string | null;
  captureMode: string | null;
  errorMessage: string | null;
  evidence: Record<string, unknown>;
  committedContactId: string | null;
  committedLinkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LineOaResolverRunDto {
  id: string;
  status: LineOaResolverRunStatus;
  tokenPrefix: string;
  worklistSource: string;
  totalRows: number;
  pendingRows: number;
  matchedRows: number;
  ambiguousRows: number;
  noMatchRows: number;
  errorRows: number;
  needsManualCodeRows: number;
  committedRows: number;
  createdByEmail: string | null;
  createdByName: string | null;
  expiresAt: string;
  committedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rows: LineOaResolverRowDto[];
}

export interface LineOaResolverRunCreateResult {
  run: LineOaResolverRunDto;
  token: string;
}

export interface LineOaResolverWorklistRow {
  rowId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  searchCode: string;
  searchCodes: string[];
}

export interface LineOaResolverCommitResult {
  committed: number;
  skipped: number;
  run: LineOaResolverRunDto;
}

type RunRow = typeof schema.lineOaResolverRuns.$inferSelect;
type ResolverRow = typeof schema.lineOaResolverRows.$inferSelect;
type LinkRow = typeof schema.lineContactStudentLinks.$inferSelect;
type ContactRow = typeof schema.lineContacts.$inferSelect;

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const LINE_USER_ID_PATTERN = /^U[a-fA-F0-9]{32}$/u;
const DOTTED_CODE_PATTERN = /[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+/gu;

function now(): Date {
  return new Date();
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeActor(actor: LineStudentLinkActor): { email: string | null; name: string | null } {
  return {
    email: actor.email?.trim().toLowerCase() || null,
    name: actor.name?.trim() || null,
  };
}

function normalizeStatus(value: string): LineOaResolverRowStatus {
  if (
    value === "pending" ||
    value === "matched" ||
    value === "ambiguous" ||
    value === "no_match" ||
    value === "error" ||
    value === "needs_manual_code" ||
    value === "committed"
  ) {
    return value;
  }
  return "error";
}

function runStatus(value: string, expiresAt: Date | string): LineOaResolverRunStatus {
  if (value === "committed") return "committed";
  if (new Date(expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function rowToDto(row: ResolverRow): LineOaResolverRowDto {
  return {
    id: row.id,
    runId: row.runId,
    wiseStudentId: row.wiseStudentId,
    studentKey: row.studentKey,
    studentName: row.studentName,
    parentName: row.parentName,
    searchCode: row.searchCode,
    status: normalizeStatus(row.status),
    lineOaAccountId: row.lineOaAccountId,
    lineUserId: row.lineUserId,
    lineChatUrl: row.lineChatUrl,
    chatTitle: row.chatTitle,
    matchMode: row.matchMode,
    captureMode: row.captureMode,
    errorMessage: row.errorMessage,
    evidence: row.evidence ?? {},
    committedContactId: row.committedContactId,
    committedLinkId: row.committedLinkId,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function countRows(rows: ResolverRow[]) {
  const counts = {
    totalRows: rows.length,
    pendingRows: 0,
    matchedRows: 0,
    ambiguousRows: 0,
    noMatchRows: 0,
    errorRows: 0,
    needsManualCodeRows: 0,
    committedRows: 0,
  };
  for (const row of rows) {
    const status = normalizeStatus(row.status);
    if (status === "pending") counts.pendingRows += 1;
    else if (status === "matched") counts.matchedRows += 1;
    else if (status === "ambiguous") counts.ambiguousRows += 1;
    else if (status === "no_match") counts.noMatchRows += 1;
    else if (status === "error") counts.errorRows += 1;
    else if (status === "needs_manual_code") counts.needsManualCodeRows += 1;
    else if (status === "committed") counts.committedRows += 1;
  }
  return counts;
}

function runToDto(run: RunRow, rows: ResolverRow[]): LineOaResolverRunDto {
  const counts = countRows(rows);
  return {
    id: run.id,
    status: runStatus(run.status, run.expiresAt),
    tokenPrefix: run.tokenPrefix,
    worklistSource: run.worklistSource,
    ...counts,
    createdByEmail: run.createdByEmail,
    createdByName: run.createdByName,
    expiresAt: iso(run.expiresAt)!,
    committedAt: iso(run.committedAt),
    createdAt: iso(run.createdAt)!,
    updatedAt: iso(run.updatedAt)!,
    rows: rows.map(rowToDto),
  };
}

function extractParentheticalCodes(value: string): string[] {
  return [...value.matchAll(/\(([^)]+)\)/gu)]
    .flatMap((match) => match[1]?.match(DOTTED_CODE_PATTERN) ?? [])
    .filter(Boolean);
}

function extractDottedCodes(value: string): string[] {
  return [...value.matchAll(DOTTED_CODE_PATTERN)].map((match) => match[0]).filter(Boolean);
}

function uniqueNormalizedCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const code of codes) {
    const normalized = normalizeLineStudentCode(code);
    if (!normalized || !normalized.includes(".") || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(code);
  }
  return result;
}

function normalizedParentGroup(value: string | null | undefined): string {
  const normalized = normalizeLineStudentCode(value ?? "");
  return normalized === "missingparent" ? "" : normalized;
}

function firstCodePart(code: string): string {
  return code.split(".")[0] ?? code;
}

function codeSuffix(code: string): string | null {
  const parts = code.split(".");
  return parts.length > 1 ? parts[parts.length - 1] || null : null;
}

export function buildSharedLineOaSearchCodes(codes: string[]): string[] {
  const bySuffix = new Map<string, string[]>();
  for (const code of uniqueNormalizedCodes(codes)) {
    const suffix = codeSuffix(code);
    if (!suffix) continue;
    bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), code]);
  }

  const shared: string[] = [];
  for (const [suffix, suffixCodes] of bySuffix.entries()) {
    if (suffixCodes.length < 2) continue;
    shared.push(`${suffixCodes.map(firstCodePart).join("/")}.${suffix}`);
  }
  return uniqueNormalizedCodes(shared);
}

export function buildLineOaResolverSearchCodes(
  row: { parentName: string; searchCode: string | null },
  rows: Array<{ parentName: string; searchCode: string | null }>,
): string[] {
  const parentGroup = normalizedParentGroup(row.parentName);
  const siblingCodes = parentGroup
    ? rows
      .filter((candidate) => normalizedParentGroup(candidate.parentName) === parentGroup)
      .map((candidate) => candidate.searchCode)
      .filter((code): code is string => Boolean(code))
    : [];
  const codes = uniqueNormalizedCodes([
    ...(row.searchCode ? [row.searchCode] : []),
    ...siblingCodes,
  ]);
  return uniqueNormalizedCodes([...codes, ...buildSharedLineOaSearchCodes(codes)]);
}

export function preferredLineOaSearchCode(student: LineStudentDirectoryRow): {
  code: string | null;
  matchedField: "nickname_code" | "student_key" | "student_name" | "none";
} {
  const nicknameCodes = uniqueNormalizedCodes([
    ...extractParentheticalCodes(student.studentName),
    ...extractParentheticalCodes(student.studentKey),
  ]);
  if (nicknameCodes[0]) return { code: nicknameCodes[0], matchedField: "nickname_code" };

  const keyCodes = uniqueNormalizedCodes(extractDottedCodes(student.studentKey));
  if (keyCodes[0]) return { code: keyCodes[0], matchedField: "student_key" };

  const nameCodes = uniqueNormalizedCodes(extractDottedCodes(student.studentName));
  if (nameCodes[0]) return { code: nameCodes[0], matchedField: "student_name" };

  return { code: null, matchedField: "none" };
}

export function buildLineOaResolverWorklist(students: LineStudentDirectoryRow[]) {
  const rows = students.map((student) => {
    const search = preferredLineOaSearchCode(student);
    return {
      wiseStudentId: student.wiseStudentId,
      studentKey: student.studentKey,
      studentName: student.studentName,
      parentName: student.parentName,
      searchCode: search.code,
      status: search.code ? "pending" as const : "needs_manual_code" as const,
      evidence: {
        source: "current_credit_control_snapshot",
        matchedField: search.matchedField,
        activated: student.activated,
        hasFutureSessions: student.hasFutureSessions,
        hasLivePackage: student.hasLivePackage,
      },
    };
  });
  return rows.map((row) => {
    const searchCodes = buildLineOaResolverSearchCodes(row, rows);
    return {
      ...row,
      searchCodes,
      evidence: {
        ...row.evidence,
        searchCodes,
      },
    };
  });
}

export function parseLineOaChatUrl(value: string | null | undefined): LineOaChatUrlParts | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "chat.line.biz") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "chat") return null;
  const [lineOaAccountId, , lineUserId] = parts;
  if (!LINE_USER_ID_PATTERN.test(lineOaAccountId) || !LINE_USER_ID_PATTERN.test(lineUserId)) {
    return null;
  }
  return { lineOaAccountId, lineUserId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function relationshipRoleFromText(value: string | null | undefined): LineOaRelationshipRole {
  const normalized = (value ?? "").normalize("NFKC").toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (/\b(mom|mum|mother|mama|mami)\b/u.test(normalized) || /แม่|คุณแม่/u.test(normalized)) return "mom";
  if (/\b(dad|father|papa|daddy)\b/u.test(normalized) || /พ่อ|คุณพ่อ/u.test(normalized)) return "dad";
  if (/\b(secretary|assistant|admin|pa)\b/u.test(normalized) || /เลขา|ผู้ช่วย/u.test(normalized)) return "secretary";
  return "other";
}

function candidateRelationshipRole(input: {
  relationshipRole?: unknown;
  adminNoteRaw?: unknown;
  chatTitle?: unknown;
}): LineOaRelationshipRole {
  const explicit = stringOrNull(input.relationshipRole);
  if (
    explicit === "mom" ||
    explicit === "dad" ||
    explicit === "secretary" ||
    explicit === "other" ||
    explicit === "unknown"
  ) {
    return explicit;
  }
  const noteRole = relationshipRoleFromText(stringOrNull(input.adminNoteRaw));
  if (noteRole !== "unknown") return noteRole;
  return relationshipRoleFromText(stringOrNull(input.chatTitle));
}

type LineOaResolverCandidateInput = {
  lineChatUrl?: string | null;
  chatTitle?: string | null;
  adminNoteRaw?: string | null;
  relationshipRole?: string | null;
  candidateRank?: number | null;
  captureMode?: string | null;
  matchMode?: string | null;
  searchCode?: string | null;
  siblingFanout?: boolean | null;
};

function candidateInputsFromEvidence(value: unknown): LineOaResolverCandidateInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object")
    .map((candidate) => ({
      lineChatUrl: stringOrNull(candidate.lineChatUrl),
      chatTitle: stringOrNull(candidate.chatTitle),
      adminNoteRaw: stringOrNull(candidate.adminNoteRaw),
      relationshipRole: stringOrNull(candidate.relationshipRole),
      candidateRank: numberOrNull(candidate.candidateRank),
      captureMode: stringOrNull(candidate.captureMode),
      matchMode: stringOrNull(candidate.matchMode),
      searchCode: stringOrNull(candidate.searchCode),
      siblingFanout: typeof candidate.siblingFanout === "boolean" ? candidate.siblingFanout : null,
    }));
}

export function normalizeLineOaResolverCandidateContacts(
  candidates: LineOaResolverCandidateInput[],
  fallback: {
    lineChatUrl?: string | null;
    chatTitle?: string | null;
    captureMode?: string | null;
    matchMode?: string | null;
    searchCode?: string | null;
    siblingFanout?: boolean;
  } = {},
): LineOaResolverCandidateContact[] {
  const inputs = candidates.length > 0 ? candidates : [{
    lineChatUrl: fallback.lineChatUrl ?? null,
    chatTitle: fallback.chatTitle ?? null,
    captureMode: fallback.captureMode ?? null,
    matchMode: fallback.matchMode ?? null,
    searchCode: fallback.searchCode ?? null,
    siblingFanout: fallback.siblingFanout ?? false,
  }];
  const seen = new Set<string>();
  const normalized: LineOaResolverCandidateContact[] = [];

  for (const [index, candidate] of inputs.entries()) {
    const url = candidate.lineChatUrl?.trim() ?? "";
    const urlParts = parseLineOaChatUrl(url);
    if (!urlParts || seen.has(urlParts.lineUserId)) continue;
    seen.add(urlParts.lineUserId);
    normalized.push({
      ...urlParts,
      lineChatUrl: url,
      chatTitle: candidate.chatTitle?.trim() || null,
      adminNoteRaw: candidate.adminNoteRaw?.trim() || null,
      relationshipRole: candidateRelationshipRole(candidate),
      candidateRank: candidate.candidateRank ?? index + 1,
      captureMode: candidate.captureMode?.trim() || fallback.captureMode?.trim() || null,
      matchMode: candidate.matchMode?.trim() || fallback.matchMode?.trim() || null,
      searchCode: candidate.searchCode?.trim() || fallback.searchCode?.trim() || null,
      ...(candidate.siblingFanout || fallback.siblingFanout ? { siblingFanout: true } : {}),
    });
  }

  return normalized;
}

async function refreshRunCounts(db: Database, runId: string): Promise<void> {
  const rows = await db
    .select()
    .from(schema.lineOaResolverRows)
    .where(eq(schema.lineOaResolverRows.runId, runId));
  const counts = countRows(rows);
  await db
    .update(schema.lineOaResolverRuns)
    .set({ ...counts, updatedAt: now() })
    .where(eq(schema.lineOaResolverRuns.id, runId));
}

async function getRunRows(db: Database, runId: string): Promise<ResolverRow[]> {
  return db
    .select()
    .from(schema.lineOaResolverRows)
    .where(eq(schema.lineOaResolverRows.runId, runId))
    .orderBy(schema.lineOaResolverRows.lineUserId, schema.lineOaResolverRows.studentName);
}

export async function getLineOaResolverRun(
  db: Database,
  runId: string,
): Promise<LineOaResolverRunDto | null> {
  const [run] = await db
    .select()
    .from(schema.lineOaResolverRuns)
    .where(eq(schema.lineOaResolverRuns.id, runId))
    .limit(1);
  if (!run) return null;
  return runToDto(run, await getRunRows(db, run.id));
}

export async function getLatestLineOaResolverRun(
  db: Database,
  actor: LineStudentLinkActor,
): Promise<LineOaResolverRunDto | null> {
  const normalized = normalizeActor(actor);
  const [run] = normalized.email
    ? await db
      .select()
      .from(schema.lineOaResolverRuns)
      .where(eq(schema.lineOaResolverRuns.createdByEmail, normalized.email))
      .orderBy(desc(schema.lineOaResolverRuns.createdAt))
      .limit(1)
    : await db
      .select()
      .from(schema.lineOaResolverRuns)
      .orderBy(desc(schema.lineOaResolverRuns.createdAt))
      .limit(1);
  if (!run) return null;
  return runToDto(run, await getRunRows(db, run.id));
}

export async function listLineOaResolverRuns(
  db: Database,
  limit = 20,
): Promise<LineOaResolverRunDto[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const runs = await db
    .select()
    .from(schema.lineOaResolverRuns)
    .orderBy(desc(schema.lineOaResolverRuns.createdAt))
    .limit(safeLimit);
  const rowSets = await Promise.all(runs.map((run) => getRunRows(db, run.id)));
  return runs.map((run, index) => runToDto(run, rowSets[index] ?? []));
}

export async function createLineOaResolverRun(
  db: Database,
  actor: LineStudentLinkActor,
): Promise<LineOaResolverRunCreateResult> {
  const normalized = normalizeActor(actor);
  const runId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${runId}.${secret}`;
  const worklist = buildLineOaResolverWorklist(await listCurrentLineStudents(db));
  const counts = {
    totalRows: worklist.length,
    pendingRows: worklist.filter((row) => row.status === "pending").length,
    matchedRows: 0,
    ambiguousRows: 0,
    noMatchRows: 0,
    errorRows: 0,
    needsManualCodeRows: worklist.filter((row) => row.status === "needs_manual_code").length,
    committedRows: 0,
  };

  const [run] = await db
    .insert(schema.lineOaResolverRuns)
    .values({
      id: runId,
      tokenHash: tokenHash(token),
      tokenPrefix: `${runId.slice(0, 8)}...${secret.slice(0, 6)}`,
      ...counts,
      createdByEmail: normalized.email,
      createdByName: normalized.name,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    })
    .returning();

  if (worklist.length > 0) {
    await db.insert(schema.lineOaResolverRows).values(worklist.map((row) => ({
      runId,
      wiseStudentId: row.wiseStudentId,
      studentKey: row.studentKey,
      studentName: row.studentName,
      parentName: row.parentName,
      searchCode: row.searchCode,
      status: row.status,
      evidence: row.evidence,
    })));
  }

  return {
    run: runToDto(run, await getRunRows(db, run.id)),
    token,
  };
}

export async function authenticateLineOaResolverToken(
  db: Database,
  token: string | null | undefined,
): Promise<RunRow | null> {
  if (!token?.trim()) return null;
  const [run] = await db
    .select()
    .from(schema.lineOaResolverRuns)
    .where(and(
      eq(schema.lineOaResolverRuns.tokenHash, tokenHash(token.trim())),
      gt(schema.lineOaResolverRuns.expiresAt, now()),
    ))
    .limit(1);
  return run ?? null;
}

export async function listLineOaResolverWorklistForToken(
  db: Database,
  token: string,
): Promise<{ runId: string; expiresAt: string; rows: LineOaResolverWorklistRow[] } | null> {
  const run = await authenticateLineOaResolverToken(db, token);
  if (!run) return null;
  const rows = await db
    .select()
    .from(schema.lineOaResolverRows)
    .where(eq(schema.lineOaResolverRows.runId, run.id))
    .orderBy(schema.lineOaResolverRows.studentName);
  return {
    runId: run.id,
    expiresAt: iso(run.expiresAt)!,
    rows: rows
      .filter((row) => row.status === "pending" && Boolean(row.searchCode))
      .map((row) => ({
        rowId: row.id,
        studentKey: row.studentKey,
        studentName: row.studentName,
        parentName: row.parentName,
        searchCode: row.searchCode!,
        searchCodes: buildLineOaResolverSearchCodes(row, rows),
      })),
  };
}

async function applyResolverCandidateRowUpdate(
  db: Database,
  input: {
    rowId: string;
    runId: string;
    status: Extract<LineOaResolverRowStatus, "matched" | "ambiguous">;
    candidates: LineOaResolverCandidateContact[];
    chatTitle: string | null;
    matchMode: string | null;
    captureMode: string | null;
    errorMessage: string | null;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  const [first] = input.candidates;
  await db
    .update(schema.lineOaResolverRows)
    .set({
      status: input.status,
      lineOaAccountId: first?.lineOaAccountId ?? null,
      lineUserId: first?.lineUserId ?? null,
      lineChatUrl: first?.lineChatUrl ?? null,
      chatTitle: input.chatTitle ?? first?.chatTitle ?? null,
      matchMode: input.matchMode,
      captureMode: input.captureMode,
      errorMessage: input.errorMessage,
      evidence: input.evidence,
      updatedAt: now(),
    })
    .where(and(
      eq(schema.lineOaResolverRows.id, input.rowId),
      eq(schema.lineOaResolverRows.runId, input.runId),
    ));
}

async function fanOutResolverCandidatesToSiblings(
  db: Database,
  input: {
    runId: string;
    sourceRow: ResolverRow;
    candidates: LineOaResolverCandidateContact[];
    searchCode: string | null;
    captureMode: string | null;
    matchMode: string | null;
  },
): Promise<void> {
  const parentGroup = normalizedParentGroup(input.sourceRow.parentName);
  if (!parentGroup || input.candidates.length === 0) return;

  const rows = await db
    .select()
    .from(schema.lineOaResolverRows)
    .where(eq(schema.lineOaResolverRows.runId, input.runId));
  const status = input.candidates.length > 1 ? "ambiguous" : "matched";

  for (const row of rows) {
    if (row.id === input.sourceRow.id || row.status === "committed") continue;
    if (normalizedParentGroup(row.parentName) !== parentGroup) continue;

    const candidates = input.candidates.map((candidate) => ({
      ...candidate,
      siblingFanout: true,
    }));
    const [first] = candidates;
    const existingEvidence = row.evidence ?? {};
    await applyResolverCandidateRowUpdate(db, {
      rowId: row.id,
      runId: input.runId,
      status,
      candidates,
      chatTitle: first?.chatTitle ?? null,
      matchMode: "sibling_fanout",
      captureMode: input.captureMode,
      errorMessage: null,
      evidence: {
        ...existingEvidence,
        source: "line_oa_resolver",
        candidateContacts: candidates,
        siblingFanout: true,
        sourceRowId: input.sourceRow.id,
        sourceStudentKey: input.sourceRow.studentKey,
        sourceSearchCode: input.searchCode,
      },
    });
  }
}

export async function updateLineOaResolverRowsFromExtension(
  db: Database,
  input: {
    token: string;
    runId: string;
    rows: Array<{
      rowId: string;
      status: Extract<LineOaResolverRowStatus, "matched" | "ambiguous" | "no_match" | "error">;
      lineChatUrl?: string | null;
      chatTitle?: string | null;
      candidates?: LineOaResolverCandidateInput[];
      matchMode?: string | null;
      captureMode?: string | null;
      errorMessage?: string | null;
      evidence?: Record<string, unknown>;
    }>;
  },
): Promise<LineOaResolverRunDto | null> {
  const run = await authenticateLineOaResolverToken(db, input.token);
  if (!run || run.id !== input.runId) return null;

  for (const row of input.rows) {
    const [existingRow] = await db
      .select()
      .from(schema.lineOaResolverRows)
      .where(and(
        eq(schema.lineOaResolverRows.id, row.rowId),
        eq(schema.lineOaResolverRows.runId, input.runId),
      ))
      .limit(1);
    if (!existingRow) continue;

    const candidates = normalizeLineOaResolverCandidateContacts(row.candidates ?? [], {
      lineChatUrl: row.lineChatUrl,
      chatTitle: row.chatTitle,
      captureMode: row.captureMode,
      matchMode: row.matchMode,
      searchCode: stringOrNull(row.evidence?.searchCode) ?? existingRow.searchCode,
    });

    if ((row.status === "matched" || row.status === "ambiguous") && candidates.length === 0) {
      await db
        .update(schema.lineOaResolverRows)
        .set({
          status: "error",
          errorMessage: row.status === "ambiguous"
            ? "Ambiguous rows require at least one valid LINE OA chat URL candidate."
            : "Matched rows require a valid LINE OA chat URL.",
          updatedAt: now(),
        })
        .where(and(
          eq(schema.lineOaResolverRows.id, row.rowId),
          eq(schema.lineOaResolverRows.runId, input.runId),
        ));
      continue;
    }

    if (row.status === "no_match" && parseLineOaChatUrl(stringOrNull(row.evidence?.extensionUrl))) {
      await db
        .update(schema.lineOaResolverRows)
        .set({
          status: "error",
          lineOaAccountId: null,
          lineUserId: null,
          lineChatUrl: null,
          chatTitle: row.chatTitle?.trim() || null,
          matchMode: "extension_context_guard",
          captureMode: row.captureMode?.trim() || null,
          errorMessage: "Extension was still on a LINE OA chat URL without capturing a candidate. Reset to the chat list and retry.",
          evidence: {
            source: "line_oa_resolver",
            ...(existingRow.evidence ?? {}),
            ...(row.evidence ?? {}),
          },
          updatedAt: now(),
        })
        .where(and(
          eq(schema.lineOaResolverRows.id, row.rowId),
          eq(schema.lineOaResolverRows.runId, input.runId),
        ));
      continue;
    }

    if ((row.status === "matched" || row.status === "ambiguous") && candidates.length > 0) {
      const [first] = candidates;
      const status = candidates.length > 1 || row.status === "ambiguous" ? "ambiguous" : "matched";
      const evidence = {
        source: "line_oa_resolver",
        ...(existingRow.evidence ?? {}),
        ...(row.evidence ?? {}),
        candidateContacts: candidates,
        originalUrl: first?.lineChatUrl,
        lineOaAccountId: first?.lineOaAccountId,
        lineUserId: first?.lineUserId,
      };
      await applyResolverCandidateRowUpdate(db, {
        rowId: row.rowId,
        runId: input.runId,
        status,
        candidates,
        chatTitle: row.chatTitle?.trim() || first?.chatTitle || null,
        matchMode: row.matchMode?.trim() || first?.matchMode || null,
        captureMode: row.captureMode?.trim() || first?.captureMode || null,
        errorMessage: row.errorMessage?.trim() || null,
        evidence,
      });
      await fanOutResolverCandidatesToSiblings(db, {
        runId: input.runId,
        sourceRow: existingRow,
        candidates,
        searchCode: first?.searchCode ?? existingRow.searchCode,
        captureMode: row.captureMode?.trim() || first?.captureMode || null,
        matchMode: row.matchMode?.trim() || first?.matchMode || null,
      });
      continue;
    }

    await db
      .update(schema.lineOaResolverRows)
      .set({
        status: row.status,
        lineOaAccountId: null,
        lineUserId: null,
        lineChatUrl: null,
        chatTitle: row.chatTitle?.trim() || null,
        matchMode: row.matchMode?.trim() || null,
        captureMode: row.captureMode?.trim() || null,
        errorMessage: row.errorMessage?.trim() || null,
        evidence: {
          source: "line_oa_resolver",
          ...(existingRow.evidence ?? {}),
          ...(row.evidence ?? {}),
        },
        updatedAt: now(),
      })
      .where(and(
        eq(schema.lineOaResolverRows.id, row.rowId),
        eq(schema.lineOaResolverRows.runId, input.runId),
      ));
  }

  await refreshRunCounts(db, input.runId);
  return getLineOaResolverRun(db, input.runId);
}

async function getOrCreateResolverContact(
  db: Database,
  input: { lineUserId: string; chatTitle: string | null },
): Promise<ContactRow> {
  const [existing] = await db
    .select()
    .from(schema.lineContacts)
    .where(eq(schema.lineContacts.lineUserId, input.lineUserId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(schema.lineContacts)
    .values({
      lineUserId: input.lineUserId,
      displayName: input.chatTitle || input.lineUserId,
      linkedStudentLabel: input.chatTitle,
      profileRaw: { source: "line_oa_resolver_stub" },
      firstSeenAt: now(),
      lastSeenAt: now(),
    })
    .returning();
  return created;
}

async function upsertResolverSuggestedLink(
  db: Database,
  input: {
    contactId: string;
    student: LineStudentDirectoryRow;
    row: ResolverRow;
    evidence: Record<string, unknown>;
  },
): Promise<LinkRow> {
  const [existing] = await db
    .select()
    .from(schema.lineContactStudentLinks)
    .where(and(
      eq(schema.lineContactStudentLinks.contactId, input.contactId),
      eq(schema.lineContactStudentLinks.studentKey, input.student.studentKey),
    ))
    .limit(1);
  const nextStatus = existing?.status === "verified" ? "verified" : "suggested";

  if (existing) {
    const [updated] = await db
      .update(schema.lineContactStudentLinks)
      .set({
        wiseStudentId: input.student.wiseStudentId,
        studentName: input.student.studentName,
        parentName: input.student.parentName,
        status: nextStatus,
        confidence: nextStatus === "verified" ? existing.confidence : 0.95,
        evidence: input.evidence,
        updatedAt: now(),
      })
      .where(eq(schema.lineContactStudentLinks.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(schema.lineContactStudentLinks)
    .values({
      contactId: input.contactId,
      wiseStudentId: input.student.wiseStudentId,
      studentKey: input.student.studentKey,
      studentName: input.student.studentName,
      parentName: input.student.parentName,
      status: "suggested",
      confidence: 0.95,
      evidence: input.evidence,
    })
    .returning();
  return created;
}

export async function commitLineOaResolverRun(
  db: Database,
  input: {
    runId: string;
    rowIds?: string[];
    selectedCandidates?: Array<{ rowId: string; lineUserId: string }>;
  },
): Promise<LineOaResolverCommitResult | null> {
  const [run] = await db
    .select()
    .from(schema.lineOaResolverRuns)
    .where(eq(schema.lineOaResolverRuns.id, input.runId))
    .limit(1);
  if (!run) return null;

  const rowIds = input.rowIds && input.rowIds.length > 0
    ? input.rowIds
    : input.selectedCandidates && input.selectedCandidates.length > 0
      ? [...new Set(input.selectedCandidates.map((candidate) => candidate.rowId))]
      : undefined;
  const selectedByRow = new Map<string, Set<string>>();
  for (const selected of input.selectedCandidates ?? []) {
    selectedByRow.set(selected.rowId, new Set([
      ...(selectedByRow.get(selected.rowId) ?? []),
      selected.lineUserId,
    ]));
  }

  const where = rowIds && rowIds.length > 0
    ? and(
      eq(schema.lineOaResolverRows.runId, input.runId),
      inArray(schema.lineOaResolverRows.status, ["matched", "ambiguous"]),
      inArray(schema.lineOaResolverRows.id, rowIds),
    )
    : and(
      eq(schema.lineOaResolverRows.runId, input.runId),
      inArray(schema.lineOaResolverRows.status, ["matched", "ambiguous"]),
    );
  const rows = await db.select().from(schema.lineOaResolverRows).where(where);
  const studentMap = new Map((await listCurrentLineStudents(db)).map((student) => [student.studentKey, student]));
  let committed = 0;
  let skipped = 0;

  for (const row of rows) {
    const student = studentMap.get(row.studentKey);
    const evidence = row.evidence as Record<string, unknown> | null;
    const selectedLineUserIds = selectedByRow.get(row.id);
    const candidates = normalizeLineOaResolverCandidateContacts(
      candidateInputsFromEvidence(evidence?.candidateContacts),
      {
        lineChatUrl: row.lineChatUrl,
        chatTitle: row.chatTitle,
        captureMode: row.captureMode,
        matchMode: row.matchMode,
        searchCode: row.searchCode,
      },
    ).filter((candidate) => !selectedLineUserIds || selectedLineUserIds.has(candidate.lineUserId));

    if (!student || candidates.length === 0) {
      skipped += 1;
      await db
        .update(schema.lineOaResolverRows)
        .set({
          status: "error",
          errorMessage: !student
            ? "Student no longer exists in current snapshot."
            : "No selected valid LINE OA chat URL candidates at commit.",
          updatedAt: now(),
        })
        .where(eq(schema.lineOaResolverRows.id, row.id));
      continue;
    }

    let firstContactId: string | null = null;
    let firstLinkId: string | null = null;
    const committedCandidates: Array<Record<string, unknown>> = [];

    for (const candidate of candidates) {
      const contact = await getOrCreateResolverContact(db, {
        lineUserId: candidate.lineUserId,
        chatTitle: candidate.chatTitle,
      });
      const linkEvidence = {
        source: "line_oa_resolver",
        lineOaAccountId: candidate.lineOaAccountId,
        lineUserId: candidate.lineUserId,
        originalUrl: candidate.lineChatUrl,
        searchCode: candidate.searchCode ?? row.searchCode,
        chatTitle: candidate.chatTitle,
        adminNoteRaw: candidate.adminNoteRaw,
        relationshipRole: candidate.relationshipRole,
        candidateRank: candidate.candidateRank,
        siblingFanout: candidate.siblingFanout ?? false,
        runId: row.runId,
        rowId: row.id,
        captureMode: candidate.captureMode ?? row.captureMode,
        matchMode: candidate.matchMode ?? row.matchMode,
        matchedCode: candidate.searchCode ?? row.searchCode,
        matchedField: evidence?.matchedField ?? "student_key",
        activated: student.activated,
        hasFutureSessions: student.hasFutureSessions,
        hasLivePackage: student.hasLivePackage,
      };
      const link = await upsertResolverSuggestedLink(db, {
        contactId: contact.id,
        student,
        row,
        evidence: linkEvidence,
      });
      if (!firstContactId) firstContactId = contact.id;
      if (!firstLinkId) firstLinkId = link.id;
      committed += 1;
      committedCandidates.push({
        lineUserId: candidate.lineUserId,
        contactId: contact.id,
        linkId: link.id,
        relationshipRole: candidate.relationshipRole,
      });
    }

    await db
      .update(schema.lineOaResolverRows)
      .set({
        status: "committed",
        committedContactId: firstContactId,
        committedLinkId: firstLinkId,
        evidence: {
          ...(evidence ?? {}),
          committedCandidates,
        },
        updatedAt: now(),
      })
      .where(eq(schema.lineOaResolverRows.id, row.id));
  }

  await refreshRunCounts(db, input.runId);
  const latest = await getLineOaResolverRun(db, input.runId);
  if (!latest) return null;
  await db
    .update(schema.lineOaResolverRuns)
    .set({
      status: latest.matchedRows === 0 && latest.ambiguousRows === 0 ? "committed" : "active",
      committedAt: latest.matchedRows === 0 && latest.ambiguousRows === 0 ? now() : null,
      updatedAt: now(),
    })
    .where(eq(schema.lineOaResolverRuns.id, input.runId));

  return {
    committed,
    skipped,
    run: (await getLineOaResolverRun(db, input.runId))!,
  };
}
