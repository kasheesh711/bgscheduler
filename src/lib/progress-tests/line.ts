// Progress Tests — verified parent LINE contact resolution for dashboard rows.
//
// Reuses the Leave Requests resolution exactly: a student is linked to a parent
// LINE account via line_contact_student_links (status 'verified'), and the staff
// chat URL is derived from the link's evidence by trustedLineChatUrlFromEvidence
// (validates the chat.line.biz host + the lineUserId). Verified links only — we
// never surface an unconfirmed account for parent outreach.

import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { trustedLineChatUrlFromEvidence } from "@/lib/leave-requests/data";
import type { ParentLineContact } from "./types";

/**
 * Resolves verified parent LINE contacts for a set of progress-tests student keys.
 *
 * 1. One batched query over line_contact_student_links (status 'verified') joined
 *    to line_contacts, filtered to the requested studentKeys.
 * 2. Derive the chat URL from the link's evidence (validated against the
 *    contact's lineUserId). When a student has multiple verified links, the first
 *    encountered wins (stable: ordered by contact id in the join).
 *
 * @returns a Map from studentKey to its ParentLineContact (verified links only).
 */
export async function getVerifiedLineContactsByStudentKey(
  studentKeys: string[],
  db: Database = getDb(),
): Promise<Map<string, ParentLineContact>> {
  const keys = [...new Set(studentKeys.filter((key) => key.length > 0))];
  if (keys.length === 0) return new Map();

  const rows = await db
    .select({
      studentKey: schema.lineContactStudentLinks.studentKey,
      evidence: schema.lineContactStudentLinks.evidence,
      lineUserId: schema.lineContacts.lineUserId,
      displayName: schema.lineContacts.displayName,
    })
    .from(schema.lineContactStudentLinks)
    .innerJoin(
      schema.lineContacts,
      eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id),
    )
    .where(
      and(
        eq(schema.lineContactStudentLinks.status, "verified"),
        inArray(schema.lineContactStudentLinks.studentKey, keys),
      ),
    );

  const byKey = new Map<string, ParentLineContact>();
  for (const row of rows) {
    if (!row.lineUserId || byKey.has(row.studentKey)) continue;
    byKey.set(row.studentKey, {
      displayName: row.displayName ?? null,
      lineUserId: row.lineUserId,
      chatUrl: trustedLineChatUrlFromEvidence(row.evidence, row.lineUserId),
    });
  }
  return byKey;
}
