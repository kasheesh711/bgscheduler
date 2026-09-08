import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export interface TutorMatch {
  tutorGroupId: string | null;
  tutorCanonicalKey: string | null;
  tutorDisplayName: string | null;
  matchConfidence: "email" | "name" | "unmatched";
  matchReason: string | null;
}

export interface TutorMatcher {
  snapshotId: string | null;
  match(input: { tutorName: string; tutorEmail: string | null }): TutorMatch;
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeTutorLookupKey(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bonline\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tutorNameAliases(value: string | null | undefined): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const aliases = new Set<string>([normalizeTutorLookupKey(text)]);
  const withoutOnline = text.replace(/\s+online$/i, "");
  aliases.add(normalizeTutorLookupKey(withoutOnline));
  const nickname = withoutOnline.match(/\(([^)]+)\)/)?.[1];
  if (nickname) aliases.add(normalizeTutorLookupKey(nickname));
  const firstName = withoutOnline.split(/\s+/)[0];
  if (firstName) aliases.add(normalizeTutorLookupKey(firstName));
  return [...aliases].filter(Boolean);
}

function emptyMatch(reason: string): TutorMatch {
  return {
    tutorGroupId: null,
    tutorCanonicalKey: null,
    tutorDisplayName: null,
    matchConfidence: "unmatched",
    matchReason: reason,
  };
}

export async function buildTutorMatcher(db: Database): Promise<TutorMatcher> {
  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  if (!activeSnapshot) {
    return {
      snapshotId: null,
      match: () => emptyMatch("No active Wise snapshot found."),
    };
  }

  const [groups, members, contacts, aliases] = await Promise.all([
    db
      .select()
      .from(schema.tutorIdentityGroups)
      .where(eq(schema.tutorIdentityGroups.snapshotId, activeSnapshot.id)),
    db
      .select()
      .from(schema.tutorIdentityGroupMembers)
      .where(eq(schema.tutorIdentityGroupMembers.snapshotId, activeSnapshot.id)),
    db
      .select()
      .from(schema.tutorContacts)
      .where(eq(schema.tutorContacts.active, true)),
    db.select().from(schema.tutorAliases),
  ]);

  const byCanonicalKey = new Map(groups.map((group) => [group.canonicalKey, group]));
  const byName = new Map<string, typeof groups[number] | null>();
  const byEmail = new Map<string, typeof groups[number] | null>();
  const byId = new Map(groups.map((group) => [group.id, group]));
  const addUnique = (map: typeof byName, key: string, group: typeof groups[number]) => {
    if (!map.has(key)) map.set(key, group);
    else if (map.get(key)?.canonicalKey !== group.canonicalKey) map.set(key, null);
  };

  for (const group of groups) {
    for (const alias of tutorNameAliases(group.displayName)) addUnique(byName, alias, group);
    for (const alias of tutorNameAliases(group.canonicalKey)) addUnique(byName, alias, group);
  }
  for (const member of members) {
    const group = byId.get(member.groupId);
    if (!group) continue;
    for (const alias of tutorNameAliases(member.wiseDisplayName)) addUnique(byName, alias, group);
  }
  for (const contact of contacts) {
    const group = byCanonicalKey.get(contact.canonicalKey);
    if (!group) continue;
    for (const email of [contact.primaryEmail, contact.onsiteEmail, contact.onlineEmail].map(normalizeEmail).filter(Boolean)) {
      addUnique(byEmail, email, group);
    }
    for (const alias of tutorNameAliases(contact.displayName)) addUnique(byName, alias, group);
    for (const sourceName of contact.sourceNames ?? []) {
      for (const alias of tutorNameAliases(sourceName)) addUnique(byName, alias, group);
    }
  }
  for (const alias of aliases) {
    const target = byName.get(normalizeTutorLookupKey(alias.toKey)) ?? byCanonicalKey.get(alias.toKey);
    if (target) addUnique(byName, normalizeTutorLookupKey(alias.fromKey), target);
  }

  return {
    snapshotId: activeSnapshot.id,
    match(input) {
      const email = normalizeEmail(input.tutorEmail);
      if (email) {
        const group = byEmail.get(email);
        if (group) {
          return {
            tutorGroupId: group.id,
            tutorCanonicalKey: group.canonicalKey,
            tutorDisplayName: group.displayName,
            matchConfidence: "email",
            matchReason: `Matched tutor contact email ${email}.`,
          };
        }
      }

      for (const alias of tutorNameAliases(input.tutorName)) {
        const group = byName.get(alias);
        if (group) {
          return {
            tutorGroupId: group.id,
            tutorCanonicalKey: group.canonicalKey,
            tutorDisplayName: group.displayName,
            matchConfidence: "name",
            matchReason: `Matched normalized tutor name "${alias}".`,
          };
        }
      }

      return emptyMatch("No active Wise tutor identity matched the submitted tutor name or email.");
    },
  };
}
