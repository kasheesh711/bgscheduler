import { IdentityGroup } from "./identity";
import { NormalizedSessionBlock } from "./sessions";

export type Modality = "online" | "onsite" | "both" | "unresolved";

export interface ModalityIssue {
  type: "modality";
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
}

/**
 * Derive modality for an identity group.
 *
 * Precedence:
 * 1. Structural evidence from group members (online/offline pairs)
 * 2. Session type evidence
 * 3. Location evidence from sessions
 * 4. Unresolved
 */
export function deriveModality(
  group: IdentityGroup,
  sessions: NormalizedSessionBlock[]
): { modality: Modality; issue: ModalityIssue | null } {
  // Step 1: Check if group has online/offline pair structure
  const hasOnline = group.members.some((m) => m.isOnlineVariant);
  const hasOffline = group.members.some((m) => !m.isOnlineVariant);

  if (hasOnline && hasOffline) {
    return { modality: "both", issue: null };
  }
  if (hasOnline && !hasOffline) {
    return { modality: "online", issue: null };
  }

  // Step 2: Check session type evidence
  const groupTeacherIds = new Set(group.members.map((m) => m.wiseTeacherId));
  const groupSessions = sessions.filter((s) => groupTeacherIds.has(s.wiseTeacherId));

  if (groupSessions.length > 0) {
    const types = new Set(groupSessions.map((s) => s.sessionType?.toLowerCase()).filter(Boolean));
    const locations = new Set(groupSessions.map((s) => s.location?.toLowerCase()).filter(Boolean));

    const hasOnlineEvidence =
      types.has("online") || locations.has("online") || locations.has("virtual");
    const hasOnsiteEvidence =
      types.has("onsite") ||
      types.has("in-person") ||
      types.has("offline") ||
      locations.has("onsite");

    if (hasOnlineEvidence && hasOnsiteEvidence) {
      return { modality: "both", issue: null };
    }
    if (hasOnlineEvidence) {
      return { modality: "online", issue: null };
    }
    if (hasOnsiteEvidence) {
      return { modality: "onsite", issue: null };
    }
  }

  // Step 3: If only offline members and no session evidence → assume onsite
  // but only for groups with a single non-online member (common default)
  if (!hasOnline && hasOffline && group.members.length === 1) {
    // Single offline record with no further evidence → unresolved (fail-closed)
    return {
      modality: "unresolved",
      issue: {
        type: "modality",
        entityType: "identity_group",
        entityId: group.canonicalKey,
        entityName: group.displayName,
        message: `Cannot determine modality for "${group.displayName}" — no online variant and insufficient session evidence`,
      },
    };
  }

  // Step 4: Unresolved
  return {
    modality: "unresolved",
    issue: {
      type: "modality",
      entityType: "identity_group",
      entityId: group.canonicalKey,
      entityName: group.displayName,
      message: `Cannot determine modality for "${group.displayName}" — insufficient evidence`,
    },
  };
}
