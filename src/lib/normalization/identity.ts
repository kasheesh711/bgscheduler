import {
  WiseTeacher,
  getWiseTeacherDisplayName,
  getWiseTeacherUserId,
} from "@/lib/wise/types";

export interface IdentityGroup {
  canonicalKey: string;
  displayName: string;
  members: IdentityGroupMember[];
}

export interface IdentityGroupMember {
  wiseTeacherId: string;
  wiseUserId?: string;
  wiseDisplayName: string;
  isOnlineVariant: boolean;
}

export interface AliasMapping {
  fromKey: string;
  toKey: string;
}

export interface IdentityResolutionResult {
  groups: IdentityGroup[];
  issues: IdentityIssue[];
}

export interface IdentityIssue {
  type: "alias";
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
}

/**
 * Extract nickname from parenthetical in display name.
 * e.g. "Chinnakrit (Celeste) Channiti" → "Celeste"
 * e.g. "Usanee (Aey) Tortermpun Online" → "Aey"
 */
export function extractNickname(displayName: string): string | null {
  const match = displayName.match(/\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

/**
 * Check if a display name is an "Online" variant.
 * e.g. "Usanee (Aey) Tortermpun Online" → true
 */
export function isOnlineVariant(displayName: string): boolean {
  return /\bOnline\s*$/i.test(displayName.trim());
}

/**
 * Get the base name (without "Online" suffix) for pairing.
 */
export function getBaseName(displayName: string): string {
  return displayName.replace(/\s+Online\s*$/i, "").trim();
}

/**
 * Resolve tutor identities from Wise teacher records.
 *
 * Resolution order:
 * 1. Extract nickname from parenthetical
 * 2. Apply alias overrides
 * 3. Detect online/offline pairs and merge them
 * 4. Any teacher that doesn't resolve → data_issue
 */
export function resolveIdentities(
  wiseTeachers: WiseTeacher[],
  aliases: AliasMapping[]
): IdentityResolutionResult {
  const aliasMap = new Map<string, string>();
  for (const a of aliases) {
    aliasMap.set(a.fromKey.toLowerCase(), a.toKey);
  }

  // Step 1+2: Extract canonical keys for each teacher
  const teacherKeys: {
    teacher: WiseTeacher;
    nickname: string | null;
    canonicalKey: string | null;
    isOnline: boolean;
  }[] = [];

  for (const teacher of wiseTeachers) {
    const displayName = getWiseTeacherDisplayName(teacher);
    const nickname = extractNickname(displayName);
    const online = isOnlineVariant(displayName);

    let canonicalKey: string | null = null;

    if (nickname) {
      // Step 2: Check alias table
      const aliased = aliasMap.get(nickname.toLowerCase());
      canonicalKey = aliased ?? nickname;
    }

    teacherKeys.push({
      teacher,
      nickname,
      canonicalKey,
      isOnline: online,
    });
  }

  // Step 3: Group by canonical key and merge online/offline pairs
  const keyGroups = new Map<string, typeof teacherKeys>();

  for (const entry of teacherKeys) {
    if (!entry.canonicalKey) continue;

    const key = entry.canonicalKey.toLowerCase();
    if (!keyGroups.has(key)) {
      keyGroups.set(key, []);
    }
    keyGroups.get(key)!.push(entry);
  }

  const groups: IdentityGroup[] = [];
  const issues: IdentityIssue[] = [];
  const resolved = new Set<string>();

  for (const [, entries] of keyGroups) {
    // Pick display name from the non-online variant if available
    const baseEntry = entries.find((e) => !e.isOnline) ?? entries[0];
    const displayName =
      baseEntry.canonicalKey ??
      baseEntry.nickname ??
      getWiseTeacherDisplayName(baseEntry.teacher);

    const group: IdentityGroup = {
      canonicalKey: displayName,
      displayName,
      members: entries.map((e) => ({
        wiseTeacherId: e.teacher._id,
        wiseUserId: getWiseTeacherUserId(e.teacher),
        wiseDisplayName: getWiseTeacherDisplayName(e.teacher),
        isOnlineVariant: e.isOnline,
      })),
    };

    groups.push(group);
    for (const e of entries) {
      resolved.add(e.teacher._id);
    }
  }

  // Step 4: Any teacher without a nickname or canonical key → data issue
  for (const entry of teacherKeys) {
    if (resolved.has(entry.teacher._id)) continue;
    const displayName = getWiseTeacherDisplayName(entry.teacher);

    // Teacher couldn't be grouped — create an issue and a solo group
    issues.push({
      type: "alias",
      entityType: "teacher",
      entityId: entry.teacher._id,
      entityName: displayName,
      message: `Unable to resolve identity for teacher "${displayName}" — no nickname extracted and no alias match`,
    });

    // Still create a group so the teacher shows up in Needs Review
    groups.push({
      canonicalKey: displayName,
      displayName,
      members: [
        {
          wiseTeacherId: entry.teacher._id,
          wiseUserId: getWiseTeacherUserId(entry.teacher),
          wiseDisplayName: displayName,
          isOnlineVariant: false,
        },
      ],
    });
  }

  return { groups, issues };
}
