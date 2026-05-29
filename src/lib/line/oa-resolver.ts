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
  return students.map((student) => {
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
    .where(and(
      eq(schema.lineOaResolverRows.runId, run.id),
      eq(schema.lineOaResolverRows.status, "pending"),
    ))
    .orderBy(schema.lineOaResolverRows.studentName);
  return {
    runId: run.id,
    expiresAt: iso(run.expiresAt)!,
    rows: rows
      .filter((row) => Boolean(row.searchCode))
      .map((row) => ({
        rowId: row.id,
        studentKey: row.studentKey,
        studentName: row.studentName,
        parentName: row.parentName,
        searchCode: row.searchCode!,
      })),
  };
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
    const urlParts = parseLineOaChatUrl(row.lineChatUrl);
    if (row.status === "matched" && !urlParts) {
      await db
        .update(schema.lineOaResolverRows)
        .set({
          status: "error",
          errorMessage: "Matched rows require a valid LINE OA chat URL.",
          updatedAt: now(),
        })
        .where(and(
          eq(schema.lineOaResolverRows.id, row.rowId),
          eq(schema.lineOaResolverRows.runId, input.runId),
        ));
      continue;
    }

    await db
      .update(schema.lineOaResolverRows)
      .set({
        status: row.status,
        lineOaAccountId: urlParts?.lineOaAccountId ?? null,
        lineUserId: urlParts?.lineUserId ?? null,
        lineChatUrl: row.lineChatUrl?.trim() || null,
        chatTitle: row.chatTitle?.trim() || null,
        matchMode: row.matchMode?.trim() || null,
        captureMode: row.captureMode?.trim() || null,
        errorMessage: row.errorMessage?.trim() || null,
        evidence: {
          source: "line_oa_resolver",
          ...(row.evidence ?? {}),
          ...(row.lineChatUrl ? { originalUrl: row.lineChatUrl } : {}),
          ...(urlParts ? {
            lineOaAccountId: urlParts.lineOaAccountId,
            lineUserId: urlParts.lineUserId,
          } : {}),
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
  },
): Promise<LineOaResolverCommitResult | null> {
  const [run] = await db
    .select()
    .from(schema.lineOaResolverRuns)
    .where(eq(schema.lineOaResolverRuns.id, input.runId))
    .limit(1);
  if (!run) return null;

  const where = input.rowIds && input.rowIds.length > 0
    ? and(
      eq(schema.lineOaResolverRows.runId, input.runId),
      eq(schema.lineOaResolverRows.status, "matched"),
      inArray(schema.lineOaResolverRows.id, input.rowIds),
    )
    : and(
      eq(schema.lineOaResolverRows.runId, input.runId),
      eq(schema.lineOaResolverRows.status, "matched"),
    );
  const rows = await db.select().from(schema.lineOaResolverRows).where(where);
  const studentMap = new Map((await listCurrentLineStudents(db)).map((student) => [student.studentKey, student]));
  let committed = 0;
  let skipped = 0;

  for (const row of rows) {
    const urlParts = parseLineOaChatUrl(row.lineChatUrl);
    const student = studentMap.get(row.studentKey);
    if (!urlParts || !student) {
      skipped += 1;
      await db
        .update(schema.lineOaResolverRows)
        .set({
          status: "error",
          errorMessage: !urlParts ? "Invalid LINE OA chat URL at commit." : "Student no longer exists in current snapshot.",
          updatedAt: now(),
        })
        .where(eq(schema.lineOaResolverRows.id, row.id));
      continue;
    }

    const contact = await getOrCreateResolverContact(db, {
      lineUserId: urlParts.lineUserId,
      chatTitle: row.chatTitle,
    });
    const evidence = {
      source: "line_oa_resolver",
      lineOaAccountId: urlParts.lineOaAccountId,
      lineUserId: urlParts.lineUserId,
      originalUrl: row.lineChatUrl,
      searchCode: row.searchCode,
      chatTitle: row.chatTitle,
      runId: row.runId,
      rowId: row.id,
      captureMode: row.captureMode,
      matchMode: row.matchMode,
      matchedCode: row.searchCode,
      matchedField: (row.evidence as Record<string, unknown> | null)?.matchedField ?? "student_key",
      activated: student.activated,
      hasFutureSessions: student.hasFutureSessions,
      hasLivePackage: student.hasLivePackage,
    };
    const link = await upsertResolverSuggestedLink(db, {
      contactId: contact.id,
      student,
      row,
      evidence,
    });

    await db
      .update(schema.lineOaResolverRows)
      .set({
        status: "committed",
        committedContactId: contact.id,
        committedLinkId: link.id,
        updatedAt: now(),
      })
      .where(eq(schema.lineOaResolverRows.id, row.id));
    committed += 1;
  }

  await refreshRunCounts(db, input.runId);
  const latest = await getLineOaResolverRun(db, input.runId);
  if (!latest) return null;
  await db
    .update(schema.lineOaResolverRuns)
    .set({
      status: latest.matchedRows === 0 ? "committed" : "active",
      committedAt: latest.matchedRows === 0 ? now() : null,
      updatedAt: now(),
    })
    .where(eq(schema.lineOaResolverRuns.id, input.runId));

  return {
    committed,
    skipped,
    run: (await getLineOaResolverRun(db, input.runId))!,
  };
}
