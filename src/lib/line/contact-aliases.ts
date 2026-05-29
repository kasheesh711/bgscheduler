import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { aiSchedulerModel, extractOutputText, isAiSchedulerConfigured } from "@/lib/ai/scheduler";
import { fetchLineProfile, type LineProfile } from "@/lib/line/client";
import {
  ensureLineContactStudentLinkSuggestions,
  listCurrentLineStudents,
  matchLineStudentCodesToStudents,
  parseLineStudentCodes,
  type LineStudentDirectoryRow,
  type ParsedLineStudentCode,
} from "@/lib/line/student-links";
import { updateLineContactLabels, updateLineContactProfile } from "@/lib/line/data";

export interface LineAliasExtractedRow {
  rowId: string;
  aliasLabel: string;
  latestMessagePreview: string | null;
  timeLabel: string | null;
  rawText: string;
}

export interface LineAliasContactForMatching {
  contactId: string;
  lineUserId: string;
  displayName: string | null;
  linkedStudentLabel: string | null;
  lastMessageText: string | null;
  lastMessageType?: string | null;
  lastMessageDirection?: "inbound" | "outbound" | null;
  lastMessageAt: string | null;
}

export interface LineAliasContactCandidate {
  contactId: string;
  lineUserId: string;
  displayName: string | null;
  linkedStudentLabel: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  score: number;
  reasons: string[];
}

export interface LineAliasSuggestedStudent {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  matchedCode: string;
  matchedField: string;
  activated: boolean;
  hasFutureSessions: boolean;
  hasLivePackage: boolean;
}

export interface LineAliasImportPreviewRow extends LineAliasExtractedRow {
  parsedCodes: ParsedLineStudentCode[];
  suggestedStudents: LineAliasSuggestedStudent[];
  contactCandidates: LineAliasContactCandidate[];
  autoSelectedContactId: string | null;
}

export interface LineAliasImportPreview {
  source: "text" | "image";
  rows: LineAliasImportPreviewRow[];
}

export interface LineAliasImportCommitResult {
  applied: Array<{
    contactId: string;
    aliasLabel: string;
    suggestedLinkCount: number;
  }>;
}

export interface LineContactProfileRefreshResult {
  total: number;
  refreshed: number;
  missing: number;
  failed: Array<{ lineUserId: string; error: string }>;
}

const openAiAliasExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aliasLabel", "latestMessagePreview", "timeLabel"],
        properties: {
          aliasLabel: { type: "string" },
          latestMessagePreview: { type: ["string", "null"] },
          timeLabel: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const aliasExtractionSchema = z.object({
  rows: z.array(z.object({
    aliasLabel: z.string().trim().min(1),
    latestMessagePreview: z.string().trim().nullable(),
    timeLabel: z.string().trim().nullable(),
  })),
});

function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.。…]+$/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function thaiCharCount(value: string): number {
  return [...value].filter((char) => /[ก-๙]/u.test(char)).length;
}

function latinCharCount(value: string): number {
  return [...value].filter((char) => /[A-Za-z0-9]/u.test(char)).length;
}

function stripLineTime(value: string): { text: string; timeLabel: string | null } {
  const timeMatch = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);
  return {
    text: value.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u, "").trim(),
    timeLabel: timeMatch?.[0] ?? null,
  };
}

function looksLikeAliasLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/^follow-?up$/i.test(trimmed)) return false;
  if (/^(line|website|parent|ops)$/i.test(trimmed)) return false;
  const latin = latinCharCount(trimmed);
  if (latin === 0) return false;
  if (trimmed.includes("/") || /\.[A-Za-z0-9ก-๙]+/u.test(trimmed)) return true;
  if (/[✅☑✔✓]/u.test(trimmed)) return true;
  if (/\([^)]+\)/u.test(trimmed) && thaiCharCount(trimmed) <= latin) return true;
  return latin >= 3 && thaiCharCount(trimmed) === 0 && trimmed.length <= 36;
}

function normalizePreview(value: string | null): string {
  const normalized = normalizeForMatch(value);
  const mediaMatch = normalized.match(/(sent(?:a|an)?(?:photo|image|sticker|video|file|audio|voice))$/u);
  return mediaMatch?.[1] ?? normalized;
}

function fallbackMessagePreview(contact: LineAliasContactForMatching): string | null {
  if (contact.lastMessageText?.trim()) return contact.lastMessageText;
  const directionPrefix = contact.lastMessageDirection === "outbound" ? "You " : "";
  switch (contact.lastMessageType) {
    case "image":
      return `${directionPrefix}sent a photo`;
    case "sticker":
      return `${directionPrefix}sent a sticker`;
    case "video":
      return `${directionPrefix}sent a video`;
    case "file":
      return `${directionPrefix}sent a file`;
    case "audio":
      return `${directionPrefix}sent an audio`;
    default:
      return null;
  }
}

function rowId(index: number, aliasLabel: string): string {
  return `${index + 1}-${normalizeForMatch(aliasLabel).slice(0, 24) || "alias"}`;
}

function explicitTextRow(line: string): LineAliasExtractedRow | null {
  const parts = line.split(/\t|\s+\|\s+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || !looksLikeAliasLine(parts[0])) return null;
  return {
    rowId: rowId(0, parts[0]),
    aliasLabel: parts[0],
    latestMessagePreview: parts[1] ?? null,
    timeLabel: parts[2] ?? null,
    rawText: line,
  };
}

export function extractLineAliasRowsFromText(text: string): LineAliasExtractedRow[] {
  const explicitRows = text
    .split(/\r?\n/u)
    .map((line) => explicitTextRow(line))
    .filter((row): row is LineAliasExtractedRow => Boolean(row));
  if (explicitRows.length > 0) {
    return explicitRows.map((row, index) => ({ ...row, rowId: rowId(index, row.aliasLabel) }));
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows: LineAliasExtractedRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { text: possibleAlias, timeLabel } = stripLineTime(lines[index]);
    if (!looksLikeAliasLine(possibleAlias)) continue;

    let preview: string | null = null;
    let previewLineIndex = index + 1;
    while (previewLineIndex < lines.length) {
      const next = stripLineTime(lines[previewLineIndex]);
      if (looksLikeAliasLine(next.text)) break;
      if (!/^\d{1,2}:\d{2}$/u.test(lines[previewLineIndex])) {
        preview = next.text;
        break;
      }
      previewLineIndex += 1;
    }

    rows.push({
      rowId: rowId(rows.length, possibleAlias),
      aliasLabel: possibleAlias,
      latestMessagePreview: preview,
      timeLabel,
      rawText: preview ? `${lines[index]}\n${preview}` : lines[index],
    });
  }
  return rows;
}

function bangkokTimeLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function rankAliasContactCandidates(
  row: Pick<LineAliasExtractedRow, "aliasLabel" | "latestMessagePreview" | "timeLabel">,
  contacts: LineAliasContactForMatching[],
  preferredContactId?: string | null,
): LineAliasContactCandidate[] {
  const alias = normalizeForMatch(row.aliasLabel);
  const preview = normalizePreview(row.latestMessagePreview);
  const timeLabel = row.timeLabel?.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u)?.[0] ?? null;

  return contacts
    .map((contact) => {
      let score = 0;
      const reasons: string[] = [];
      const contactPreview = normalizePreview(fallbackMessagePreview(contact));
      const displayName = normalizeForMatch(contact.displayName);
      const linkedLabel = normalizeForMatch(contact.linkedStudentLabel);

      if (preview.length >= 8 && contactPreview) {
        if (contactPreview === preview) {
          score += 76;
          reasons.push("latest message exact match");
        } else if (contactPreview.includes(preview) || preview.includes(contactPreview)) {
          score += 68;
          reasons.push("latest message preview match");
        }
      }
      if (alias && linkedLabel && linkedLabel === alias) {
        score += 30;
        reasons.push("existing alias match");
      } else if (alias && displayName && displayName === alias) {
        score += 18;
        reasons.push("LINE profile display name match");
      }
      if (timeLabel) {
        const contactTime = bangkokTimeLabel(contact.lastMessageAt);
        if (contactTime === timeLabel) {
          score += 20;
          reasons.push("message time match");
        }
      }
      const hasRealEvidence = reasons.some((reason) => (
        reason !== "message time match" && reason !== "current review contact"
      ));
      if (preferredContactId && contact.contactId === preferredContactId && hasRealEvidence) {
        score += 6;
        reasons.push("current review contact");
      }

      return {
        ...contact,
        score,
        reasons,
      };
    })
    .filter((candidate) => candidate.score > 0 && candidate.reasons.some((reason) => (
      reason !== "message time match" && reason !== "current review contact"
    )))
    .sort((a, b) => b.score - a.score || a.displayName?.localeCompare(b.displayName ?? "") || 0)
    .slice(0, 5);
}

function autoSelectedContactId(candidates: LineAliasContactCandidate[]): string | null {
  const [first, second] = candidates;
  if (!first || first.score < 80) return null;
  if (!second || first.score - second.score >= 20) return first.contactId;
  return null;
}

function suggestedStudentsForAlias(
  aliasLabel: string,
  students: LineStudentDirectoryRow[],
): { parsedCodes: ParsedLineStudentCode[]; suggestedStudents: LineAliasSuggestedStudent[] } {
  const parsedCodes = parseLineStudentCodes(aliasLabel);
  const matches = matchLineStudentCodesToStudents(parsedCodes, students);
  return {
    parsedCodes,
    suggestedStudents: matches.map((match) => ({
      wiseStudentId: match.student.wiseStudentId,
      studentKey: match.student.studentKey,
      studentName: match.student.studentName,
      parentName: match.student.parentName,
      matchedCode: match.parsed.code,
      matchedField: match.matchType,
      activated: match.student.activated,
      hasFutureSessions: match.student.hasFutureSessions,
      hasLivePackage: match.student.hasLivePackage,
    })),
  };
}

export function buildLineAliasImportPreviewRows(input: {
  extractedRows: LineAliasExtractedRow[];
  contacts: LineAliasContactForMatching[];
  students: LineStudentDirectoryRow[];
  preferredContactId?: string | null;
}): LineAliasImportPreviewRow[] {
  return input.extractedRows.map((row) => {
    const contactCandidates = rankAliasContactCandidates(row, input.contacts, input.preferredContactId);
    const { parsedCodes, suggestedStudents } = suggestedStudentsForAlias(row.aliasLabel, input.students);
    return {
      ...row,
      parsedCodes,
      suggestedStudents,
      contactCandidates,
      autoSelectedContactId: autoSelectedContactId(contactCandidates),
    };
  });
}

function asDataUrl(input: { bytes: Buffer; mimeType: string }): string {
  return `data:${input.mimeType};base64,${input.bytes.toString("base64")}`;
}

async function extractLineAliasRowsFromImage(input: {
  bytes: Buffer;
  mimeType: string;
}): Promise<LineAliasExtractedRow[]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !isAiSchedulerConfigured()) {
    throw new Error("AI scheduler is not configured");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: aiSchedulerModel(),
      store: false,
      input: [
        {
          role: "system",
          content: "Extract visible LINE Desktop chat-list rows for BeGifted admin alias import. Return strict JSON only.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Extract each visible chat row from this LINE Desktop screenshot.",
                "aliasLabel must preserve the exact visible staff-renamed label, including Unicode icons/checkmarks/prefixes.",
                "latestMessagePreview should be the gray preview text for that row when visible, otherwise null.",
                "timeLabel should be the visible HH:mm or date text when visible, otherwise null.",
                "Ignore scrollbar, unread dots, follow-up badges, and avatars.",
              ].join("\n"),
            },
            {
              type: "input_image",
              image_url: asDataUrl(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "line_desktop_alias_rows",
          strict: true,
          schema: openAiAliasExtractionJsonSchema,
        },
        verbosity: "low",
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `OpenAI returned HTTP ${response.status}`);
  }

  const parsed = aliasExtractionSchema.parse(JSON.parse(extractOutputText(payload)));
  return parsed.rows.map((row, index) => ({
    rowId: rowId(index, row.aliasLabel),
    aliasLabel: row.aliasLabel,
    latestMessagePreview: row.latestMessagePreview || null,
    timeLabel: row.timeLabel || null,
    rawText: [row.aliasLabel, row.latestMessagePreview, row.timeLabel].filter(Boolean).join("\n"),
  }));
}

export async function loadLineAliasContactsForMatching(db: Database): Promise<LineAliasContactForMatching[]> {
  const rows = await db
    .select({
      contactId: schema.lineContacts.id,
      lineUserId: schema.lineContacts.lineUserId,
      displayName: schema.lineContacts.displayName,
      linkedStudentLabel: schema.lineContacts.linkedStudentLabel,
      lastMessageText: schema.lineMessages.text,
      lastMessageType: schema.lineMessages.messageType,
      lastMessageDirection: schema.lineMessages.direction,
      lastMessageAt: schema.lineMessages.eventTimestamp,
    })
    .from(schema.lineMessages)
    .innerJoin(schema.lineContacts, eq(schema.lineMessages.contactId, schema.lineContacts.id))
    .orderBy(desc(schema.lineMessages.createdAt))
    .limit(800);

  const seen = new Set<string>();
  const contacts: LineAliasContactForMatching[] = [];
  for (const row of rows) {
    if (seen.has(row.contactId)) continue;
    seen.add(row.contactId);
    contacts.push({
      contactId: row.contactId,
      lineUserId: row.lineUserId,
      displayName: row.displayName,
      linkedStudentLabel: row.linkedStudentLabel,
      lastMessageText: row.lastMessageText,
      lastMessageType: row.lastMessageType,
      lastMessageDirection: row.lastMessageDirection,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    });
  }
  return contacts;
}

export async function previewLineAliasImport(input: {
  db: Database;
  text?: string | null;
  image?: { bytes: Buffer; mimeType: string } | null;
  preferredContactId?: string | null;
}): Promise<LineAliasImportPreview> {
  const source = input.image ? "image" : "text";
  const extractedRows = input.image
    ? await extractLineAliasRowsFromImage(input.image)
    : extractLineAliasRowsFromText(input.text ?? "");
  const [contacts, students] = await Promise.all([
    loadLineAliasContactsForMatching(input.db),
    listCurrentLineStudents(input.db),
  ]);
  return {
    source,
    rows: buildLineAliasImportPreviewRows({
      extractedRows,
      contacts,
      students,
      preferredContactId: input.preferredContactId,
    }),
  };
}

export async function commitLineAliasImport(input: {
  db: Database;
  rows: Array<{ contactId: string; aliasLabel: string }>;
}): Promise<LineAliasImportCommitResult> {
  const applied: LineAliasImportCommitResult["applied"] = [];
  for (const row of input.rows) {
    const aliasLabel = row.aliasLabel.trim();
    if (!aliasLabel) continue;
    await updateLineContactLabels(input.db, row.contactId, { linkedStudentLabel: aliasLabel });
    const links = await ensureLineContactStudentLinkSuggestions(input.db, row.contactId, aliasLabel);
    applied.push({
      contactId: row.contactId,
      aliasLabel,
      suggestedLinkCount: links.filter((link) => link.status === "suggested").length,
    });
  }
  return { applied };
}

export async function refreshAllLineContactProfiles(input: {
  db: Database;
  fetchProfile?: (lineUserId: string) => Promise<LineProfile | null>;
}): Promise<LineContactProfileRefreshResult> {
  const contacts = await input.db
    .select({ lineUserId: schema.lineContacts.lineUserId })
    .from(schema.lineContacts)
    .orderBy(desc(schema.lineContacts.lastSeenAt));
  const fetchProfile = input.fetchProfile ?? fetchLineProfile;
  const result: LineContactProfileRefreshResult = {
    total: contacts.length,
    refreshed: 0,
    missing: 0,
    failed: [],
  };

  for (const contact of contacts) {
    try {
      const profile = await fetchProfile(contact.lineUserId);
      if (!profile) {
        result.missing += 1;
        continue;
      }
      await updateLineContactProfile(input.db, contact.lineUserId, profile);
      result.refreshed += 1;
    } catch (error) {
      result.failed.push({
        lineUserId: contact.lineUserId,
        error: error instanceof Error ? error.message : "Profile refresh failed",
      });
    }
  }

  return result;
}
