// Progress Tests — resolve a teacher's login email to the set of tutor
// canonicalKeys whose progress-test rows they own.
//
// A tutor often has two Wise identities (an onsite account + a "… Online" one).
// When the two share an extracted nickname the Wise identity resolver merges
// them into ONE canonicalKey, so the onsite email already spans both. When they
// do NOT (no nickname, or inconsistent online naming in live Wise data) the
// identities split into two canonicalKeys; we bridge those via the merged
// tutor_contacts row's sourceNames matched against the active Wise snapshot's
// identity-group member display names. The teacher dashboard then filters rows by
// `mostFrequentTutorCanonicalKey ∈ <this set>`, so the main email surfaces the
// online account's tracking too (and vice-versa).

import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { normalizeTutorLookupKey } from "@/lib/leave-requests/matching";

/** Lower-cases + trims an email for case-insensitive comparison. */
function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Resolves a login email to every tutor canonicalKey the teacher owns.
 *
 * 1. Match active `tutor_contacts` rows by normalized onsite OR online email.
 * 2. Seed the result with those rows' canonicalKeys (covers nickname-merged
 *    identities, where one key already spans onsite + online).
 * 3. Bridge any split online/onsite identities: collect the matched rows'
 *    displayName + sourceNames as normalized full names, then add any active
 *    identity-group whose displayName or member wiseDisplayName matches —
 *    catching a separate "… Online" group keyed under a different canonicalKey.
 *
 * Used both at sign-in (to decide teacher eligibility) and per-request by the
 * dashboard GET route (resolved fresh so a new snapshot is reflected at once).
 *
 * @returns the unique set of canonicalKeys; empty when the email is unknown
 *   (→ fail-closed: the caller shows no rows / denies access).
 */
export async function resolveTeacherCanonicalKeys(
  email: string | null | undefined,
  db: Database = getDb(),
): Promise<string[]> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];

  const contacts = await db
    .select({
      canonicalKey: schema.tutorContacts.canonicalKey,
      displayName: schema.tutorContacts.displayName,
      onsiteEmail: schema.tutorContacts.onsiteEmail,
      onlineEmail: schema.tutorContacts.onlineEmail,
      sourceNames: schema.tutorContacts.sourceNames,
    })
    .from(schema.tutorContacts)
    .where(eq(schema.tutorContacts.active, true));

  const matched = contacts.filter(
    (contact) =>
      normalizeEmail(contact.onsiteEmail) === normalizedEmail ||
      normalizeEmail(contact.onlineEmail) === normalizedEmail,
  );
  if (matched.length === 0) return [];

  const keys = new Set<string>();
  const targetNames = new Set<string>();
  for (const contact of matched) {
    if (contact.canonicalKey) keys.add(contact.canonicalKey);
    for (const name of [contact.displayName, ...(contact.sourceNames ?? [])]) {
      const normalized = normalizeTutorLookupKey(name);
      if (normalized) targetNames.add(normalized);
    }
  }

  // Bridge to any split (un-merged) online/onsite identities via the active Wise
  // snapshot. A name match adds that identity's real canonicalKey even when it
  // differs from the contact's key (e.g. a no-nickname "David Smith Online").
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  if (activeSnapshot && targetNames.size > 0) {
    const groupRows = await db
      .select({
        canonicalKey: schema.tutorIdentityGroups.canonicalKey,
        groupDisplayName: schema.tutorIdentityGroups.displayName,
        memberDisplayName: schema.tutorIdentityGroupMembers.wiseDisplayName,
      })
      .from(schema.tutorIdentityGroupMembers)
      .innerJoin(
        schema.tutorIdentityGroups,
        eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id),
      )
      .where(and(
        eq(schema.tutorIdentityGroups.snapshotId, activeSnapshot.id),
        eq(schema.tutorIdentityGroupMembers.snapshotId, activeSnapshot.id),
      ));

    for (const row of groupRows) {
      if (!row.canonicalKey || keys.has(row.canonicalKey)) continue;
      if (
        targetNames.has(normalizeTutorLookupKey(row.groupDisplayName)) ||
        targetNames.has(normalizeTutorLookupKey(row.memberDisplayName))
      ) {
        keys.add(row.canonicalKey);
      }
    }
  }

  return [...keys];
}
