import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

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
  createdAt: string;
  updatedAt: string;
}

export interface LineStudentDirectoryRow {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
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
  return value
    .normalize("NFKC")
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
    .split(/\s*\/\s*|\s*,\s*|\s*&\s*|\s+\+\s+/)
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

function linkToDto(row: LinkRow): LineContactStudentLinkDto {
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
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

async function activeStudentRows(db: Database): Promise<LineStudentDirectoryRow[]> {
  const rows = await db
    .select({
      wiseStudentId: schema.creditControlStudents.wiseStudentId,
      studentKey: schema.creditControlStudents.studentKey,
      studentName: schema.creditControlStudents.studentName,
      parentName: schema.creditControlStudents.parentName,
    })
    .from(schema.creditControlStudents)
    .innerJoin(
      schema.creditControlSnapshots,
      eq(schema.creditControlStudents.snapshotId, schema.creditControlSnapshots.id),
    )
    .where(and(
      eq(schema.creditControlSnapshots.active, true),
      eq(schema.creditControlStudents.activated, true),
    ));

  return rows;
}

export function matchLineStudentCodesToStudents(
  parsedCodes: ParsedLineStudentCode[],
  students: LineStudentDirectoryRow[],
): Array<{ student: LineStudentDirectoryRow; parsed: ParsedLineStudentCode }> {
  const parsedByNormalized = new Map(parsedCodes.map((code) => [code.normalized, code]));
  return students
    .map((student) => ({
      student,
      parsed: parsedByNormalized.get(normalizeLineStudentCode(student.studentName)),
    }))
    .filter((match): match is { student: LineStudentDirectoryRow; parsed: ParsedLineStudentCode } => Boolean(match.parsed));
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
): Promise<LineContactStudentLinkDto[]> {
  const label = labelOverride ?? await contactLabel(db, contactId);
  const parsedCodes = parseLineStudentCodes(label);
  if (parsedCodes.length === 0) {
    return listLineContactStudentLinks(db, contactId);
  }

  const students = await activeStudentRows(db);
  const matches = matchLineStudentCodesToStudents(parsedCodes, students);

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
        evidence: {
          source: "line_display_name",
          parsedCodes,
          matchedCode: match.parsed.code,
          label,
        },
      })
      .onConflictDoNothing({
        target: [
          schema.lineContactStudentLinks.contactId,
          schema.lineContactStudentLinks.studentKey,
        ],
      });
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
  return rows.map(linkToDto);
}

export async function patchLineContactStudentLinkStatus(
  db: Database,
  input: {
    contactId: string;
    linkId: string;
    status: Extract<LineContactStudentLinkStatus, "verified" | "rejected">;
    actor: LineStudentLinkActor;
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
      updatedAt: now(),
    })
    .where(and(
      eq(schema.lineContactStudentLinks.id, input.linkId),
      eq(schema.lineContactStudentLinks.contactId, input.contactId),
    ))
    .returning();
  return row ? linkToDto(row) : null;
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
    ));
  return rows.map((row) => row.studentKey);
}

export async function hasVerifiedLineStudentLink(db: Database, contactId: string): Promise<boolean> {
  const keys = await listVerifiedLineStudentKeys(db, contactId);
  return keys.length > 0;
}
