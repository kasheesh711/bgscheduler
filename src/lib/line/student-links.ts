import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { matchNamesToDirectory, SUGGEST_SHORTLIST_MIN_SCORE } from "@/lib/line/name-matcher";
import { fetchLineFollowerIds, fetchLineProfile, type LineProfile } from "@/lib/line/client";

export type LineContactStudentLinkStatus = "suggested" | "verified" | "rejected";

export interface ParsedLineStudentCode {
  raw: string;
  code: string;
  normalized: string;
}

export interface LineStudentLinkActor {
  email?: string | null;
  name?: string | null;
}

export interface LineContactStudentLinkDto {
  id: string;
  contactId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  status: LineContactStudentLinkStatus;
  confidence: number | null;
  evidence: Record<string, unknown>;
  reviewedByEmail: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  validationAssignedToEmail: string | null;
  validationAssignedToName: string | null;
  validationAssignedRunId: string | null;
  validationAssignedAt: string | null;
  validationNote: string | null;
  createdAt: string;
  updatedAt: string;
  currentStudentActivated: boolean | null;
  currentStudentHasFutureSessions: boolean | null;
  currentStudentHasLivePackage: boolean | null;
}

export interface LineStudentDirectoryRow {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  activated: boolean;
  hasFutureSessions: boolean;
  hasLivePackage: boolean;
}

export type LineStudentMatchType = "student_name" | "student_key" | "nickname_code";
export type LineStudentSearchMatchType =
  | "exact_code"
  | "nickname_code"
  | "student_key"
  | "student_name"
  | "parent_name";

export interface LineStudentSearchRow extends LineStudentDirectoryRow {
  matchType: LineStudentSearchMatchType;
}

type LinkRow = typeof schema.lineContactStudentLinks.$inferSelect;

function now(): Date {
  return new Date();
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeActor(actor: LineStudentLinkActor): { email: string | null; name: string | null } {
  return {
    email: actor.email?.trim().toLowerCase() || null,
    name: actor.name?.trim() || null,
  };
}

export function normalizeLineStudentCode(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9.ก-๙]/g, "");
}

function cleanLineLabel(value: string): string {
  const labelOnly = value.split(/\s*=\s*/u)[0] ?? value;
  return labelOnly
    .normalize("NFKC")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/[✅☑✔✓]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\p{L}\s+/u, "")
    .trim();
}

function stripTrailingPreview(value: string): string {
  return value
    .replace(/\bsent a (photo|sticker|video|message)\b.*$/i, "")
    .replace(/\byou sent a (photo|sticker|video|message)\b.*$/i, "")
    .trim();
}

function codeFromPart(part: string, sharedSuffix: string | null): string | null {
  const cleaned = stripTrailingPreview(part)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}.]+$/u, "")
    .trim();
  if (!cleaned) return null;

  if (cleaned.includes(".")) return cleaned;
  return sharedSuffix ? `${cleaned}.${sharedSuffix}` : cleaned;
}

export function parseLineStudentCodes(label: string | null | undefined): ParsedLineStudentCode[] {
  const cleaned = cleanLineLabel(label ?? "");
  if (!cleaned) return [];

  const parts = cleaned
    .split(/\s*\/\s*|\s*,\s*|\s*&\s*|\s+\+\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const suffix = parts
    .map((part) => part.match(/\.([A-Za-z0-9ก-๙]+)\b/u)?.[1])
    .find((value): value is string => Boolean(value)) ?? null;

  const seen = new Set<string>();
  const result: ParsedLineStudentCode[] = [];
  for (const part of parts) {
    const code = codeFromPart(part, suffix);
    if (!code) continue;
    const normalized = normalizeLineStudentCode(code);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ raw: part, code, normalized });
  }
  return result;
}

function linkToDto(row: LinkRow, currentStudent?: LineStudentDirectoryRow | null): LineContactStudentLinkDto {
  return {
    id: row.id,
    contactId: row.contactId,
    wiseStudentId: row.wiseStudentId,
    studentKey: row.studentKey,
    studentName: row.studentName,
    parentName: row.parentName,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence ?? {},
    reviewedByEmail: row.reviewedByEmail,
    reviewedByName: row.reviewedByName,
    reviewedAt: iso(row.reviewedAt),
    validationAssignedToEmail: row.validationAssignedToEmail,
    validationAssignedToName: row.validationAssignedToName,
    validationAssignedRunId: row.validationAssignedRunId,
    validationAssignedAt: iso(row.validationAssignedAt),
    validationNote: row.validationNote,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    currentStudentActivated: currentStudent?.activated ?? null,
    currentStudentHasFutureSessions: currentStudent?.hasFutureSessions ?? null,
    currentStudentHasLivePackage: currentStudent?.hasLivePackage ?? null,
  };
}

async function activeCreditControlSnapshotId(db: Database): Promise<string | null> {
  const [snapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);
  return snapshot?.id ?? null;
}

export async function listCurrentLineStudents(db: Database): Promise<LineStudentDirectoryRow[]> {
  const snapshotId = await activeCreditControlSnapshotId(db);
  if (!snapshotId) return [];

  return listCurrentLineStudentsForSnapshot(db, snapshotId);
}

export async function listCurrentLineStudentsByKeys(
  db: Database,
  studentKeys: string[],
): Promise<LineStudentDirectoryRow[]> {
  const keys = [...new Set(studentKeys.filter(Boolean))];
  if (keys.length === 0) return [];

  const snapshotId = await activeCreditControlSnapshotId(db);
  if (!snapshotId) return [];

  return listCurrentLineStudentsForSnapshot(db, snapshotId, keys);
}

async function listCurrentLineStudentsForSnapshot(
  db: Database,
  snapshotId: string,
  studentKeys?: string[],
): Promise<LineStudentDirectoryRow[]> {
  const studentConditions = [eq(schema.creditControlStudents.snapshotId, snapshotId)];
  const packageConditions = [
    eq(schema.creditControlPackages.snapshotId, snapshotId),
    isNull(schema.creditControlPackages.excludedReason),
  ];
  const sessionConditions = [
    eq(schema.creditControlSessions.snapshotId, snapshotId),
    eq(schema.creditControlSessions.sessionKind, "future"),
    gte(schema.creditControlSessions.scheduledStartTime, now()),
  ];
  if (studentKeys && studentKeys.length > 0) {
    studentConditions.push(inArray(schema.creditControlStudents.studentKey, studentKeys));
    packageConditions.push(inArray(schema.creditControlPackages.studentKey, studentKeys));
    sessionConditions.push(inArray(schema.creditControlSessions.studentKey, studentKeys));
  }

  const [studentRows, livePackageRows, futureSessionRows] = await Promise.all([
    db
      .select({
        wiseStudentId: schema.creditControlStudents.wiseStudentId,
        studentKey: schema.creditControlStudents.studentKey,
        studentName: schema.creditControlStudents.studentName,
        parentName: schema.creditControlStudents.parentName,
        activated: schema.creditControlStudents.activated,
      })
      .from(schema.creditControlStudents)
      .where(and(...studentConditions)),
    db
      .select({ studentKey: schema.creditControlPackages.studentKey })
      .from(schema.creditControlPackages)
      .where(and(...packageConditions)),
    db
      .select({ studentKey: schema.creditControlSessions.studentKey })
      .from(schema.creditControlSessions)
      .where(and(...sessionConditions)),
  ]);

  const livePackageKeys = new Set(livePackageRows.map((row) => row.studentKey));
  const futureSessionKeys = new Set(futureSessionRows.map((row) => row.studentKey));

  return studentRows.map((student) => ({
    ...student,
    hasFutureSessions: futureSessionKeys.has(student.studentKey),
    hasLivePackage: livePackageKeys.has(student.studentKey),
  }));
}

async function currentStudentMap(db: Database): Promise<Map<string, LineStudentDirectoryRow>> {
  return new Map((await listCurrentLineStudents(db)).map((student) => [student.studentKey, student]));
}

async function findCurrentStudentByKey(
  db: Database,
  studentKey: string,
): Promise<LineStudentDirectoryRow | null> {
  const snapshotId = await activeCreditControlSnapshotId(db);
  if (!snapshotId) return null;

  const [student] = await db
    .select({
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentKey: schema.creditControlStudents.studentKey,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
      activated: schema.creditControlStudents.activated,
    })
    .from(schema.creditControlStudents)
    .where(and(
      eq(schema.creditControlStudents.snapshotId, snapshotId),
      eq(schema.creditControlStudents.studentKey, studentKey),
    ))
    .limit(1);
  if (!student) return null;

  const [livePackage] = await db
    .select({ studentKey: schema.creditControlPackages.studentKey })
    .from(schema.creditControlPackages)
    .where(and(
      eq(schema.creditControlPackages.snapshotId, snapshotId),
      eq(schema.creditControlPackages.studentKey, student.studentKey),
      isNull(schema.creditControlPackages.excludedReason),
    ))
    .limit(1);
  const [futureSession] = await db
    .select({ studentKey: schema.creditControlSessions.studentKey })
    .from(schema.creditControlSessions)
    .where(and(
      eq(schema.creditControlSessions.snapshotId, snapshotId),
      eq(schema.creditControlSessions.studentKey, student.studentKey),
      eq(schema.creditControlSessions.sessionKind, "future"),
      gte(schema.creditControlSessions.scheduledStartTime, now()),
    ))
    .limit(1);

  return {
    ...student,
    hasFutureSessions: Boolean(futureSession),
    hasLivePackage: Boolean(livePackage),
  };
}

export function nicknameCodes(value: string): string[] {
  const matches = [...value.matchAll(/\(([^)]+)\)/g)];
  return matches
    .map((match) => normalizeLineStudentCode(match[1] ?? ""))
    .filter(Boolean);
}

function matchParsedCodeForStudent(
  student: LineStudentDirectoryRow,
  parsedCodes: ParsedLineStudentCode[],
  parsedByNormalized: Map<string, ParsedLineStudentCode>,
): { parsed: ParsedLineStudentCode; matchType: LineStudentMatchType } | null {
  for (const nickname of nicknameCodes(student.studentName)) {
    const parsed = parsedByNormalized.get(nickname);
    if (parsed) return { parsed, matchType: "nickname_code" };
  }

  for (const nickname of nicknameCodes(student.studentKey)) {
    const parsed = parsedByNormalized.get(nickname);
    if (parsed) return { parsed, matchType: "student_key" };
  }

  const nameMatch = parsedByNormalized.get(normalizeLineStudentCode(student.studentName));
  if (nameMatch) return { parsed: nameMatch, matchType: "student_name" };

  const keyMatch = parsedByNormalized.get(normalizeLineStudentCode(student.studentKey));
  if (keyMatch) return { parsed: keyMatch, matchType: "student_key" };

  const normalizedName = normalizeLineStudentCode(student.studentName);
  const normalizedKey = normalizeLineStudentCode(student.studentKey);
  for (const parsed of parsedCodes) {
    if (!parsed.normalized.includes(".")) continue;
    if (normalizedKey.includes(parsed.normalized)) {
      return { parsed, matchType: "student_key" };
    }
    if (normalizedName.includes(parsed.normalized)) {
      return { parsed, matchType: "nickname_code" };
    }
  }

  return null;
}

export function matchLineStudentCodesToStudents(
  parsedCodes: ParsedLineStudentCode[],
  students: LineStudentDirectoryRow[],
): Array<{ student: LineStudentDirectoryRow; parsed: ParsedLineStudentCode; matchType: LineStudentMatchType }> {
  const parsedByNormalized = new Map(parsedCodes.map((code) => [code.normalized, code]));
  return students
    .map((student) => ({
      student,
      match: matchParsedCodeForStudent(student, parsedCodes, parsedByNormalized),
    }))
    .filter((match): match is {
      student: LineStudentDirectoryRow;
      match: { parsed: ParsedLineStudentCode; matchType: LineStudentMatchType };
    } => Boolean(match.match))
    .map((match) => ({
      student: match.student,
      parsed: match.match.parsed,
      matchType: match.match.matchType,
    }));
}

function helperTextParsedCodes(label: string | null): ParsedLineStudentCode[] {
  const helperText = label?.split(/\s*=\s*/u).slice(1).join(" ") ?? "";
  if (!helperText.trim()) return [];
  return parseLineStudentCodes(helperText)
    .filter((code) => code.normalized.includes("."));
}

async function linkDtosForRows(db: Database, rows: LinkRow[]): Promise<LineContactStudentLinkDto[]> {
  if (rows.length === 0) return [];
  const studentsByKey = await currentStudentMap(db);
  return rows.map((row) => linkToDto(row, studentsByKey.get(row.studentKey) ?? null));
}

export function resolveLineStudentCodeMatches(
  label: string | null,
  students: LineStudentDirectoryRow[],
): {
  matches: Array<{ student: LineStudentDirectoryRow; parsed: ParsedLineStudentCode; matchType: LineStudentMatchType }>;
  evidenceSource: "line_display_name" | "admin_helper_text";
  parsedCodes: ParsedLineStudentCode[];
} {
  const parsedCodes = parseLineStudentCodes(label);
  const matches = parsedCodes.length > 0
    ? matchLineStudentCodesToStudents(parsedCodes, students)
    : [];
  if (matches.length > 0) {
    return { matches, evidenceSource: "line_display_name", parsedCodes };
  }

  const helperCodes = helperTextParsedCodes(label);
  if (helperCodes.length === 0) {
    return { matches: [], evidenceSource: "line_display_name", parsedCodes };
  }

  const helperMatches = matchLineStudentCodesToStudents(helperCodes, students);
  if (helperMatches.length === 0) {
    return { matches: [], evidenceSource: "line_display_name", parsedCodes };
  }

  return {
    matches: helperMatches,
    evidenceSource: "admin_helper_text",
    parsedCodes: helperCodes,
  };
}

export function studentLinkEvidence(input: {
  source:
    | "line_display_name"
    | "admin_helper_text"
    | "admin_search"
    | "message_content"
    | "line_followers"
    | "follower_profile";   // Phase 12: distinctive-token backlog recovery
  parsedCodes?: ParsedLineStudentCode[];
  matchedCode?: string;
  matchedField?: LineStudentMatchType;
  label?: string | null;
  student?: LineStudentDirectoryRow;
  originalUrl?: string | null;   // Phase 12: chat.line.biz URL from resolver target
  ambiguous?: boolean;           // Phase 12: true when multiple students matched
  tokens?: string[];             // Phase 12: distinctive tokens that fired the match
  displayName?: string;          // Phase 12: follower's LINE display name
}): Record<string, unknown> {
  return {
    source: input.source,
    ...(input.parsedCodes ? { parsedCodes: input.parsedCodes } : {}),
    ...(input.matchedCode ? { matchedCode: input.matchedCode } : {}),
    ...(input.matchedField ? { matchedField: input.matchedField } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.student ? {
      activated: input.student.activated,
      hasFutureSessions: input.student.hasFutureSessions,
      hasLivePackage: input.student.hasLivePackage,
    } : {}),
    ...(input.originalUrl !== undefined ? { originalUrl: input.originalUrl } : {}),
    ...(input.ambiguous !== undefined ? { ambiguous: input.ambiguous } : {}),
    ...(input.tokens ? { tokens: input.tokens } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };
}

async function contactLabel(db: Database, contactId: string): Promise<string | null> {
  const [row] = await db
    .select({
      displayName: schema.lineContacts.displayName,
      linkedStudentLabel: schema.lineContacts.linkedStudentLabel,
    })
    .from(schema.lineContacts)
    .where(eq(schema.lineContacts.id, contactId))
    .limit(1);
  return row ? [row.displayName, row.linkedStudentLabel].filter(Boolean).join(" ") : null;
}

export async function ensureLineContactStudentLinkSuggestions(
  db: Database,
  contactId: string,
  labelOverride?: string | null,
  names?: { studentName?: string | null; parentName?: string | null },
): Promise<LineContactStudentLinkDto[]> {
  const label = labelOverride ?? await contactLabel(db, contactId);
  const students = await listCurrentLineStudents(db);
  const { matches, evidenceSource, parsedCodes } = resolveLineStudentCodeMatches(label, students);

  for (const match of matches) {
    await db
      .insert(schema.lineContactStudentLinks)
      .values({
        contactId,
        wiseStudentId: match.student.wiseStudentId,
        studentKey: match.student.studentKey,
        studentName: match.student.studentName,
        parentName: match.student.parentName,
        status: "suggested",
        confidence: 0.95,
        evidence: studentLinkEvidence({
          source: evidenceSource,
          parsedCodes,
          matchedCode: match.parsed.code,
          matchedField: match.matchType,
          label,
          student: match.student,
        }),
      })
      .onConflictDoNothing({
        target: [
          schema.lineContactStudentLinks.contactId,
          schema.lineContactStudentLinks.studentKey,
        ],
      });
  }

  // Name-based matching — per IDENT-01 (source: "message_content")
  if (names) {
    const nameCandidates = matchNamesToDirectory(names, students);
    for (const candidate of nameCandidates) {
      if (candidate.score < SUGGEST_SHORTLIST_MIN_SCORE) continue;
      await db
        .insert(schema.lineContactStudentLinks)
        .values({
          contactId,
          wiseStudentId: candidate.student.wiseStudentId,
          studentKey: candidate.student.studentKey,
          studentName: candidate.student.studentName,
          parentName: candidate.student.parentName,
          status: "suggested",          // ALWAYS suggested — NEVER verified from content (IDENT-02)
          confidence: candidate.score / 100,
          evidence: studentLinkEvidence({
            source: "message_content",
            student: candidate.student,
          }),
          sourceKind: "message_content",
        })
        .onConflictDoNothing({
          target: [
            schema.lineContactStudentLinks.contactId,
            schema.lineContactStudentLinks.studentKey,
          ],
        });
    }
  }

  return listLineContactStudentLinks(db, contactId);
}

export async function listLineContactStudentLinks(
  db: Database,
  contactId: string,
): Promise<LineContactStudentLinkDto[]> {
  const rows = await db
    .select()
    .from(schema.lineContactStudentLinks)
    .where(eq(schema.lineContactStudentLinks.contactId, contactId))
    .orderBy(schema.lineContactStudentLinks.status, schema.lineContactStudentLinks.studentName);
  return linkDtosForRows(db, rows);
}

export async function listVerifiedLineContactStudentLinks(
  db: Database,
  contactId: string,
): Promise<LineContactStudentLinkDto[]> {
  const rows = await db
    .select()
    .from(schema.lineContactStudentLinks)
    .where(and(
      eq(schema.lineContactStudentLinks.contactId, contactId),
      eq(schema.lineContactStudentLinks.status, "verified"),
    ))
    .orderBy(schema.lineContactStudentLinks.studentName);
  return linkDtosForRows(db, rows);
}

function bestSearchMatch(
  student: LineStudentDirectoryRow,
  query: string,
): { matchType: LineStudentSearchMatchType; rank: number } | null {
  const normalizedQuery = normalizeLineStudentCode(query);
  if (!normalizedQuery) return null;
  const parsedCodes = parseLineStudentCodes(query);
  const exactCodes = new Set([normalizedQuery, ...parsedCodes.map((code) => code.normalized)]);
  const normalizedName = normalizeLineStudentCode(student.studentName);
  const normalizedKey = normalizeLineStudentCode(student.studentKey);
  const normalizedParent = normalizeLineStudentCode(student.parentName);
  const nicknames = new Set([
    ...nicknameCodes(student.studentName),
    ...nicknameCodes(student.studentKey),
  ]);

  for (const code of exactCodes) {
    if (nicknames.has(code)) return { matchType: "exact_code", rank: 50 };
  }
  for (const code of exactCodes) {
    if (normalizedKey === code) return { matchType: "student_key", rank: 45 };
    if (normalizedName === code) return { matchType: "student_name", rank: 44 };
  }
  for (const code of exactCodes) {
    if (code.includes(".") && normalizedKey.includes(code)) {
      return { matchType: "nickname_code", rank: 42 };
    }
    if (code.includes(".") && normalizedName.includes(code)) {
      return { matchType: "nickname_code", rank: 41 };
    }
  }
  if (normalizedKey.includes(normalizedQuery)) return { matchType: "student_key", rank: 35 };
  if (normalizedName.includes(normalizedQuery)) return { matchType: "student_name", rank: 34 };
  if (normalizedParent.includes(normalizedQuery)) return { matchType: "parent_name", rank: 25 };
  return null;
}

export function searchLineStudentRows(
  students: LineStudentDirectoryRow[],
  query: string,
  limit = 20,
): LineStudentSearchRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return students
    .map((student) => ({
      student,
      match: bestSearchMatch(student, trimmed),
    }))
    .filter((row): row is {
      student: LineStudentDirectoryRow;
      match: { matchType: LineStudentSearchMatchType; rank: number };
    } => Boolean(row.match))
    .sort((a, b) => (
      b.match.rank - a.match.rank
      || Number(b.student.activated) - Number(a.student.activated)
      || Number(b.student.hasFutureSessions) - Number(a.student.hasFutureSessions)
      || Number(b.student.hasLivePackage) - Number(a.student.hasLivePackage)
      || a.student.studentName.localeCompare(b.student.studentName)
    ))
    .slice(0, limit)
    .map(({ student, match }) => ({
      ...student,
      matchType: match.matchType,
    }));
}

export async function searchCurrentLineStudents(
  db: Database,
  query: string,
  limit = 20,
): Promise<LineStudentSearchRow[]> {
  return searchLineStudentRows(await listCurrentLineStudents(db), query, limit);
}

export const searchActiveLineStudents = searchCurrentLineStudents;

export async function createVerifiedLineContactStudentLink(
  db: Database,
  input: {
    contactId: string;
    studentKey: string;
    actor: LineStudentLinkActor;
  },
): Promise<LineContactStudentLinkDto | null> {
  const actor = normalizeActor(input.actor);
  const student = await findCurrentStudentByKey(db, input.studentKey);
  if (!student) return null;
  const evidence = studentLinkEvidence({ source: "admin_search", student });

  const [row] = await db
    .insert(schema.lineContactStudentLinks)
    .values({
      contactId: input.contactId,
      wiseStudentId: student.wiseStudentId,
      studentKey: student.studentKey,
      studentName: student.studentName,
      parentName: student.parentName,
      status: "verified",
      confidence: 1,
      evidence,
      reviewedByEmail: actor.email,
      reviewedByName: actor.name,
      reviewedAt: now(),
    })
    .onConflictDoUpdate({
      target: [
        schema.lineContactStudentLinks.contactId,
        schema.lineContactStudentLinks.studentKey,
      ],
      set: {
        wiseStudentId: student.wiseStudentId,
        studentName: student.studentName,
        parentName: student.parentName,
        status: "verified",
        confidence: 1,
        evidence,
        reviewedByEmail: actor.email,
        reviewedByName: actor.name,
        reviewedAt: now(),
        updatedAt: now(),
      },
    })
    .returning();
  return row ? linkToDto(row, student) : null;
}

export async function patchLineContactStudentLinkStatus(
  db: Database,
  input: {
    contactId: string;
    linkId: string;
    status: Extract<LineContactStudentLinkStatus, "verified" | "rejected">;
    actor: LineStudentLinkActor;
    note?: string | null;
  },
): Promise<LineContactStudentLinkDto | null> {
  const actor = normalizeActor(input.actor);
  const [row] = await db
    .update(schema.lineContactStudentLinks)
    .set({
      status: input.status,
      reviewedByEmail: actor.email,
      reviewedByName: actor.name,
      reviewedAt: now(),
      validationNote: input.note?.trim() || null,
      updatedAt: now(),
    })
    .where(and(
      eq(schema.lineContactStudentLinks.id, input.linkId),
      eq(schema.lineContactStudentLinks.contactId, input.contactId),
    ))
    .returning();
  if (!row) return null;
  const studentsByKey = await currentStudentMap(db);
  return linkToDto(row, studentsByKey.get(row.studentKey) ?? null);
}

export async function listVerifiedLineStudentKeys(
  db: Database,
  contactId: string,
): Promise<string[]> {
  const rows = await db
    .select({ studentKey: schema.lineContactStudentLinks.studentKey })
    .from(schema.lineContactStudentLinks)
    .where(and(
      eq(schema.lineContactStudentLinks.contactId, contactId),
      eq(schema.lineContactStudentLinks.status, "verified"),
      eq(schema.lineContactStudentLinks.isPhantom, false),   // NEW per IDENT-05: excludes quarantined phantom rows
    ));
  return rows.map((row) => row.studentKey);
}

export async function hasVerifiedLineStudentLink(db: Database, contactId: string): Promise<boolean> {
  const keys = await listVerifiedLineStudentKeys(db, contactId);
  return keys.length > 0;
}

// ── LINE Followers Re-anchor Job ────────────────────────────────────────────

export interface LineFollowersReanchorResult {
  followerCount: number;
  upsertedContacts: number;
  suggestionsCreated: number;
  errors: string[];
}

/**
 * Re-anchor job for IDENT-03: seeds correct-namespace contacts from the OA's
 * real followers list. Idempotent — re-running creates no duplicate contacts.
 *
 * Step 1: Paginate fetchLineFollowerIds to collect all follower userIds.
 * Step 2: For each follower, fetch LINE profile + upsert contact (onConflictDoNothing).
 * Step 3: Run ensureLineContactStudentLinkSuggestions with names=undefined per follower.
 *         Followers have no AI-extracted state at re-anchor time, so only the
 *         display-name/dotted-code suggestion path runs. Name-based matching fires
 *         per-message in Plan 11-03 for real messaging contacts.
 */
export async function runLineFollowersReanchor({ db }: { db: Database }): Promise<LineFollowersReanchorResult> {
  // Step 1: Paginate fetchLineFollowerIds to collect all userIds
  const allUserIds: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await fetchLineFollowerIds(cursor);
    allUserIds.push(...page.userIds);
    cursor = page.next;
  } while (cursor);

  const result: LineFollowersReanchorResult = {
    followerCount: allUserIds.length,
    upsertedContacts: 0,
    suggestionsCreated: 0,
    errors: [],
  };

  // Step 2: For each follower, fetchProfile + upsert contact + run matcher
  for (const userId of allUserIds) {
    try {
      const profile = await fetchLineProfile(userId).catch(() => null);
      const contactId = await upsertLineContactFromFollower(db, userId, profile);
      if (contactId) {
        result.upsertedContacts += 1;
        // Step 3: Run the existing suggestion pipeline (display-name/dotted-code path only).
        // No AI-extracted names for followers re-anchor — pass names=undefined.
        const before = await db
          .select({ id: schema.lineContactStudentLinks.id })
          .from(schema.lineContactStudentLinks)
          .where(eq(schema.lineContactStudentLinks.contactId, contactId));
        await ensureLineContactStudentLinkSuggestions(
          db,
          contactId,
          profile?.displayName ?? null,
          undefined, // No AI-extracted names for followers re-anchor (display-name path only)
        ).catch(() => undefined);
        const after = await db
          .select({ id: schema.lineContactStudentLinks.id })
          .from(schema.lineContactStudentLinks)
          .where(eq(schema.lineContactStudentLinks.contactId, contactId));
        result.suggestionsCreated += after.length - before.length;
      }
    } catch (err) {
      result.errors.push(`${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Returns human-verified OA-resolver rows (those with committedLinkId IS NOT NULL).
 * These are the ground-truth targets for the Phase 12 backlog identity recovery (IDENT-07).
 * VerifiedResolverTarget is defined in backlog-matcher.ts (canonical home).
 *
 * Step 1: Query lineOaResolverRows WHERE committedLinkId IS NOT NULL.
 * Step 2: Return rows shaped as VerifiedResolverTarget[].
 */
export async function listVerifiedResolverTargets(
  db: Database,
): Promise<import("@/lib/line/backlog-matcher").VerifiedResolverTarget[]> {
  return db
    .select({
      studentName: schema.lineOaResolverRows.studentName,
      parentName: schema.lineOaResolverRows.parentName,
      searchCode: schema.lineOaResolverRows.searchCode,
      lineChatUrl: schema.lineOaResolverRows.lineChatUrl,
      wiseStudentId: schema.lineOaResolverRows.wiseStudentId,
      studentKey: schema.lineOaResolverRows.studentKey,
    })
    .from(schema.lineOaResolverRows)
    .where(isNotNull(schema.lineOaResolverRows.committedLinkId));
}

/**
 * Upsert a line_contact from the followers list — idempotent on lineUserId unique index.
 * Returns the contact id, or null if the contact could not be found after insert.
 */
async function upsertLineContactFromFollower(
  db: Database,
  lineUserId: string,
  profile: LineProfile | null,
): Promise<string | null> {
  const values = {
    lineUserId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
  };
  const inserted = await db
    .insert(schema.lineContacts)
    .values(values)
    .onConflictDoNothing({ target: schema.lineContacts.lineUserId })
    .returning({ id: schema.lineContacts.id });
  if (inserted.length > 0) return inserted[0].id;
  // Contact already exists — fetch its id
  const existing = await db
    .select({ id: schema.lineContacts.id })
    .from(schema.lineContacts)
    .where(eq(schema.lineContacts.lineUserId, lineUserId))
    .limit(1);
  return existing[0]?.id ?? null;
}
