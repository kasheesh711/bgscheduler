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
  const byName = new Map<string, typeof groups[number]>();
  const byEmail = new Map<string, typeof groups[number]>();

  for (const group of groups) {
    for (const alias of tutorNameAliases(group.displayName)) byName.set(alias, group);
    for (const alias of tutorNameAliases(group.canonicalKey)) byName.set(alias, group);
  }
  for (const member of members) {
    const group = byCanonicalKey.get(groups.find((item) => item.id === member.groupId)?.canonicalKey ?? "");
    if (!group) continue;
    for (const alias of tutorNameAliases(member.wiseDisplayName)) byName.set(alias, group);
  }
  for (const contact of contacts) {
    const group = byCanonicalKey.get(contact.canonicalKey);
    if (!group) continue;
    for (const email of [contact.onsiteEmail, contact.onlineEmail].map(normalizeEmail).filter(Boolean)) {
      byEmail.set(email, group);
    }
    for (const alias of tutorNameAliases(contact.displayName)) byName.set(alias, group);
    for (const sourceName of contact.sourceNames ?? []) {
      for (const alias of tutorNameAliases(sourceName)) byName.set(alias, group);
    }
  }
  for (const alias of aliases) {
    const target = byName.get(normalizeTutorLookupKey(alias.toKey)) ?? byCanonicalKey.get(alias.toKey);
    if (target) byName.set(normalizeTutorLookupKey(alias.fromKey), target);
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
