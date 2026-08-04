// ----------------------------------------------------------------------------
// Capability tokens for the public parent schedule page (/schedule/{token}).
//
// Threat model: the page is unauthenticated by design (a parent opens it from
// a LINE message), so the token IS the credential. Accordingly:
//   • 32 random bytes from crypto.randomBytes — not a uuid, not a hash of the
//     student key, nothing derivable from data an attacker could guess.
//   • Only the SHA-256 hash is persisted, so a database read cannot reconstruct
//     a live link (same discipline as line_oa_resolver_runs).
//   • Every token is scoped to exactly one (studentKey, monthKey) and expires.
//   • Resolution failures are indistinguishable to the caller — expired,
//     revoked, unknown and malformed all return null, so the public page cannot
//     be used as an oracle for which tokens ever existed.
// ----------------------------------------------------------------------------

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { isMonthKey } from "@/lib/calendar/month-grid";

/** Base64url of 32 bytes — 43 chars, no padding. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

export const DEFAULT_LINK_TTL_DAYS = 30;

export interface StudentScheduleLinkRecord {
  id: string;
  studentKey: string;
  wiseStudentId: string;
  studentName: string;
  monthKey: string;
  expiresAt: Date;
}

export function hashScheduleToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests, so a resolve cannot be timed to
 * recover a prefix. Length is pre-checked because timingSafeEqual throws on a
 * length mismatch.
 */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Mints a link for one student-month.
 *
 * @returns the raw token — the ONLY time it exists in plaintext. Persist
 *   nothing but the returned record; the caller is responsible for putting the
 *   token straight into the outbound message or the admin's clipboard.
 */
export async function mintStudentScheduleLink(
  db: Database,
  {
    studentKey,
    wiseStudentId,
    studentName,
    monthKey,
    createdByEmail = null,
    createdByLineUserId = null,
    sentToLineUserId = null,
    sentToGroupId = null,
    ttlDays = DEFAULT_LINK_TTL_DAYS,
    now = new Date(),
  }: {
    studentKey: string;
    wiseStudentId: string;
    studentName: string;
    monthKey: string;
    createdByEmail?: string | null;
    createdByLineUserId?: string | null;
    sentToLineUserId?: string | null;
    /** Set instead of sentToLineUserId when delivered into a LINE group. */
    sentToGroupId?: string | null;
    ttlDays?: number;
    now?: Date;
  },
): Promise<{ token: string; expiresAt: Date; id: string }> {
  if (!isMonthKey(monthKey)) {
    throw new Error(`Invalid month key: expected "YYYY-MM", got "${monthKey}"`);
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(schema.studentScheduleLinks)
    .values({
      tokenHash: hashScheduleToken(token),
      studentKey,
      wiseStudentId,
      studentName,
      monthKey,
      createdByEmail,
      createdByLineUserId,
      sentToLineUserId,
      sentToGroupId,
      expiresAt,
    })
    .returning({ id: schema.studentScheduleLinks.id });

  return { token, expiresAt, id: row.id };
}

/**
 * Resolves a raw token to its student-month grant and records the view.
 *
 * @returns the grant, or null for any failure mode (malformed, unknown,
 *   expired, revoked). Callers MUST render one identical "expired" page for
 *   null rather than distinguishing the cases.
 */
export async function resolveStudentScheduleLink(
  db: Database,
  token: string,
  now = new Date(),
): Promise<StudentScheduleLinkRecord | null> {
  if (!TOKEN_PATTERN.test(token)) return null;

  const tokenHash = hashScheduleToken(token);
  const [row] = await db
    .select({
      id: schema.studentScheduleLinks.id,
      tokenHash: schema.studentScheduleLinks.tokenHash,
      studentKey: schema.studentScheduleLinks.studentKey,
      wiseStudentId: schema.studentScheduleLinks.wiseStudentId,
      studentName: schema.studentScheduleLinks.studentName,
      monthKey: schema.studentScheduleLinks.monthKey,
      expiresAt: schema.studentScheduleLinks.expiresAt,
    })
    .from(schema.studentScheduleLinks)
    .where(and(
      eq(schema.studentScheduleLinks.tokenHash, tokenHash),
      isNull(schema.studentScheduleLinks.revokedAt),
      gt(schema.studentScheduleLinks.expiresAt, now),
    ))
    .limit(1);

  if (!row || !digestsMatch(row.tokenHash, tokenHash)) return null;

  // Best-effort view accounting; a failure here must not deny a valid parent.
  await db
    .update(schema.studentScheduleLinks)
    .set({
      viewCount: sql`${schema.studentScheduleLinks.viewCount} + 1`,
      lastViewedAt: now,
    })
    .where(eq(schema.studentScheduleLinks.id, row.id))
    .catch((error) => {
      console.error("[student-schedule] view accounting failed", error);
    });

  return {
    id: row.id,
    studentKey: row.studentKey,
    wiseStudentId: row.wiseStudentId,
    studentName: row.studentName,
    monthKey: row.monthKey,
    expiresAt: row.expiresAt,
  };
}

/** Revokes a single link by id. Idempotent — re-revoking keeps the first stamp. */
export async function revokeStudentScheduleLink(
  db: Database,
  linkId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(schema.studentScheduleLinks)
    .set({ revokedAt: now })
    .where(and(
      eq(schema.studentScheduleLinks.id, linkId),
      isNull(schema.studentScheduleLinks.revokedAt),
    ));
}

/** Absolute URL a parent opens. Base comes from env so previews link to themselves. */
export function studentScheduleLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/schedule/${token}`;
}
