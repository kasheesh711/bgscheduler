import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveIdentities, extractNickname, getBaseName, isOnlineVariant, type AliasMapping, type IdentityGroup, type IdentityIssue } from "@/lib/normalization/identity";
import { getWiseTeacherUserId, getWiseTeacherDisplayName, getWiseSessionTeacherUserId, type WiseTeacher, type WiseSession } from "@/lib/wise/types";
import { isBlockingStatus } from "@/lib/normalization/sessions";

export const ONBOARDING_START = new Date("2026-09-05T17:00:00.000Z");
export function onboardingEnabled(now = new Date()): boolean {
  return now >= ONBOARDING_START;
}
export function validTutorEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return z.string().email().safeParse(normalized).success ? normalized : null;
}
export function scheduleRecipientEmail(contact?: { onsiteEmail?: string | null; onlineEmail?: string | null }): string | null {
  return validTutorEmail(contact?.onsiteEmail) ?? validTutorEmail(contact?.onlineEmail);
}
export interface AccountMapping {
  wiseTeacherId: string;
  wiseUserId: string | null;
  canonicalKey: string;
  displayName: string;
  isOnlineVariant: boolean;
  status?: string;
}
export interface Account extends AccountMapping { email: string | null; status: string }
export interface Contact {
  canonicalKey: string;
  displayName: string;
  onsiteEmail: string | null;
  onlineEmail: string | null;
  sourceNames: string[];
  active: boolean;
  wiseEmailState: Partial<Record<"onsiteEmail" | "onlineEmail", {
    mode: "wise" | "manual";
    lastValue: string | null;
    accountIds: string[];
  }>> & { identityBound?: boolean };
}
export interface OnboardingIssue { entityId: string; canonicalKey?: string; message: string }

/** Preserve established account ownership; never transfer a renamed account by nickname. */
export function resolveOnboardingIdentities(teachers: WiseTeacher[], aliases: AliasMapping[], prior: AccountMapping[]) {
  const legacy = resolveIdentities(teachers, aliases);
  const proposed = new Map(legacy.groups.flatMap(g => g.members.map(m => [m.wiseTeacherId, g.canonicalKey] as const)));
  const groups = new Map<string, IdentityGroup>();
  const issues: IdentityIssue[] = [];
  const blocked = new Set<string>();
  for (const teacher of teachers) {
    const name = getWiseTeacherDisplayName(teacher);
    const userId = getWiseTeacherUserId(teacher);
    const known = prior.filter(p => p.wiseTeacherId === teacher._id || (userId && p.wiseUserId === userId));
    const keys = [...new Set(known.map(p => p.canonicalKey))];
    const explicitAlias = aliases.find(a => a.fromKey.toLowerCase() === (extractNickname(name) ?? getBaseName(name)).toLowerCase());
    const twins = teachers.filter(t => getBaseName(getWiseTeacherDisplayName(t)).toLowerCase() === getBaseName(name).toLowerCase());
    const exactPair = twins.length === 2 && twins.filter(t => isOnlineVariant(getWiseTeacherDisplayName(t))).length === 1;
    const pairAnchor = exactPair ? twins.find(t => !isOnlineVariant(getWiseTeacherDisplayName(t)))! : teacher;
    const pairedKeys = exactPair ? [...new Set(prior.filter(p => twins.some(t => p.wiseTeacherId === t._id || (p.wiseUserId && p.wiseUserId === getWiseTeacherUserId(t)))).map(p => p.canonicalKey))] : [];
    const fallbackKey = pairedKeys.length === 1 ? pairedKeys[0] : `wise:${getWiseTeacherUserId(pairAnchor) ?? pairAnchor._id}`;
    const key = keys.length === 1 ? keys[0] : explicitAlias?.toKey ?? (extractNickname(name) ? proposed.get(teacher._id)! : fallbackKey);
    const group = groups.get(key) ?? { canonicalKey: key, displayName: key.startsWith("wise:") ? getBaseName(name) : key, members: [] };
    group.members.push({ wiseTeacherId: teacher._id, wiseUserId: userId, wiseDisplayName: name, isOnlineVariant: isOnlineVariant(name) });
    groups.set(key, group);
    if (keys.length > 1 || known.some(p => p.status === "identity_conflict" && p.displayName === name)) blocked.add(key);
  }
  for (const group of groups.values()) {
    const members = group.members;
    const knownIds = new Set(prior.filter(p => p.canonicalKey === group.canonicalKey).map(p => p.wiseTeacherId));
    const newcomers = members.filter(m => !knownIds.has(m.wiseTeacherId));
    // Existing mappings cannot silently acquire another person's nickname.
    const knownNames = prior.filter(p => p.canonicalKey === group.canonicalKey).map(p => getBaseName(p.displayName).toLowerCase());
    const baseNames = new Set(members.map(m => getBaseName(m.wiseDisplayName).toLowerCase()));
    const pair = members.length === 2 && members.filter(m => m.isOnlineVariant).length === 1;
    const explicitPair = members.every(m => aliases.some(a => a.toKey === group.canonicalKey && a.fromKey.toLowerCase() === (extractNickname(m.wiseDisplayName) ?? getBaseName(m.wiseDisplayName)).toLowerCase()));
    if ((members.length > 1 && !pair) || (newcomers.length > 0 && members.length > 1 && baseNames.size > 1 && !explicitPair)
      || newcomers.some(m => knownNames.length > 0 && !knownNames.includes(getBaseName(m.wiseDisplayName).toLowerCase()) && !explicitPair)) blocked.add(group.canonicalKey);
    const userIds = members.map(m => m.wiseUserId).filter(Boolean);
    if (new Set(userIds).size !== userIds.length) blocked.add(group.canonicalKey);
    if (blocked.has(group.canonicalKey)) issues.push({ type: "alias", entityType: "tutor_identity_group", entityId: group.canonicalKey, entityName: group.displayName,
      message: `identity_collision: ${group.displayName} has ambiguous Wise account ownership. Review the roster and identity aliases before allocation, delivery or teacher access.` });
  }
  // A user ID cannot belong to two different people even if names differ.
  for (const teacher of teachers) {
    const uid = getWiseTeacherUserId(teacher);
    if (!uid || teachers.filter(t => getWiseTeacherUserId(t) === uid).length < 2) continue;
    for (const group of groups.values()) if (group.members.some(m => m.wiseUserId === uid) && !blocked.has(group.canonicalKey)) {
      blocked.add(group.canonicalKey);
      issues.push({ type: "alias", entityType: "tutor_identity_group", entityId: group.canonicalKey, entityName: group.displayName, message: "identity_collision: Wise user ID belongs to multiple roster accounts. Review Wise account ownership." });
    }
  }
  for (const [key, group] of [...groups]) {
    if (!blocked.has(key)) continue;
    const newcomers = group.members.filter(m => !prior.some(p => p.wiseTeacherId === m.wiseTeacherId || (m.wiseUserId && p.wiseUserId === m.wiseUserId)));
    for (const member of newcomers) {
      const duplicateUser = member.wiseUserId && teachers.filter(t => getWiseTeacherUserId(t) === member.wiseUserId).length > 1;
      const safeKey = duplicateUser ? `wise:${member.wiseUserId}:${member.wiseTeacherId}` : `wise:${member.wiseUserId ?? member.wiseTeacherId}`;
      if (safeKey === key) continue;
      group.members = group.members.filter(m => m !== member);
      groups.set(safeKey, { canonicalKey: safeKey, displayName: getBaseName(member.wiseDisplayName), members: [member] });
      blocked.add(safeKey);
      issues.push({ type: "alias", entityType: "tutor_identity_group", entityId: safeKey, entityName: member.wiseDisplayName,
        message: "identity_collision: new account could not be paired safely. Correct its Wise identity before automatic activation." });
    }
    if (!group.members.length) groups.delete(key);
  }
  return { groups: [...groups.values()], issues: issues.filter(i => groups.has(i.entityId)), blocked };
}

export function unmanagedTeacherSessions(teachers: WiseTeacher[], sessions: WiseSession[]) {
  const ids = new Set(teachers.map(getWiseTeacherUserId).filter(Boolean));
  return sessions.filter(s => isBlockingStatus(s.meetingStatus) && !ids.has(getWiseSessionTeacherUserId(s))).map(s => ({
    sessionId: s._id, teacherUserId: getWiseSessionTeacherUserId(s) ?? null,
    message: `Wise session ${s._id} references teacher ${getWiseSessionTeacherUserId(s) ?? "unknown"} absent from the teacher roster. Restore/correct that teacher in Wise; the next sync will retry automatically.`,
  }));
}

export function planTutorContacts(teachers: WiseTeacher[], groups: IdentityGroup[], blocked: Set<string>, existing: Contact[], previousAccounts: Account[]) {
  const issues: OnboardingIssue[] = [];
  const memberKeys = new Map(groups.flatMap(g => g.members.map(m => [m.wiseTeacherId, g.canonicalKey] as const)));
  const accountCandidates: Account[] = teachers.map(t => {
    const key = memberKeys.get(t._id)!;
    const email = validTutorEmail(typeof t.userId === "object" ? t.userId.email : null);
    return { wiseTeacherId: t._id, wiseUserId: getWiseTeacherUserId(t) ?? null, canonicalKey: key, displayName: getWiseTeacherDisplayName(t), isOnlineVariant: isOnlineVariant(getWiseTeacherDisplayName(t)), email, status: blocked.has(key) ? "identity_conflict" : email ? "active" : "invalid_email" };
  });
  const emailOwners = new Map<string, Set<string>>();
  const addOwner = (email: string | null, key: string) => { if (email) emailOwners.set(email, new Set([...(emailOwners.get(email) ?? []), key])); };
  for (const a of accountCandidates) addOwner(a.email, a.canonicalKey);
  for (const c of existing) for (const field of ["onsiteEmail", "onlineEmail"] as const) {
    // A previous Wise value being removed is not an independent configured owner.
    if (c.wiseEmailState?.[field]?.mode !== "wise" || c[field] !== c.wiseEmailState[field]?.lastValue) addOwner(validTutorEmail(c[field]), c.canonicalKey);
  }
  for (const a of accountCandidates) {
    if (a.email && (emailOwners.get(a.email)?.size ?? 0) > 1) a.status = "email_conflict";
    if (a.status !== "active") issues.push({ entityId: a.wiseTeacherId, canonicalKey: a.canonicalKey,
      message: `${a.displayName}: ${a.status}. Correct the teacher identity/email in Wise or retain an explicitly configured recipient; automatic delivery and access from this account are blocked.` });
  }
  const currentIds = new Set(accountCandidates.map(a => a.wiseTeacherId));
  const accounts = [...accountCandidates, ...previousAccounts.filter(a => !currentIds.has(a.wiseTeacherId)).map(a => ({ ...a, email: null, status: "absent" }))];
  const existingByKey = new Map(existing.map(c => [c.canonicalKey, c]));
  const keys = new Set([...groups.map(g => g.canonicalKey), ...existing.filter(c => Object.keys(c.wiseEmailState ?? {}).length > 0).map(c => c.canonicalKey)]);
  const contacts: Contact[] = [];
  let created = 0, updated = 0;
  for (const key of [...keys].sort()) {
    const old = existingByKey.get(key);
    const group = groups.find(g => g.canonicalKey === key);
    const contact: Contact = old ? structuredClone(old) : { canonicalKey: key, displayName: group!.displayName, onsiteEmail: null, onlineEmail: null, sourceNames: [], active: true, wiseEmailState: { identityBound: true } };
    contact.wiseEmailState ??= {};
    for (const field of ["onsiteEmail", "onlineEmail"] as const) {
      const state = contact.wiseEmailState[field];
      // Detect edits under the promotion transaction's row lock, including clearing a field.
      if (state?.mode === "wise" && contact[field] !== state.lastValue) {
        contact.wiseEmailState[field] = { ...state, mode: "manual" };
        continue;
      }
      if (!contact.active || state?.mode === "manual" || (!state && contact[field])) continue;
      const candidates = accounts.filter(a => a.canonicalKey === key && a.status === "active" && a.isOnlineVariant === (field === "onlineEmail"));
      const emails = [...new Set(candidates.map(a => a.email).filter((e): e is string => !!e))];
      const next = emails.length === 1 ? emails[0] : null;
      contact[field] = next;
      if (state || next) contact.wiseEmailState[field] = { mode: "wise", lastValue: next, accountIds: candidates.map(a => a.wiseTeacherId).sort() };
    }
    // Imported contacts use durable keys for access, never name-bridging.
    if (!old) contact.sourceNames = group!.members.map(m => m.wiseDisplayName).sort();
    if (!old) created++;
    else if (!isDeepStrictEqual(contact, old)) updated++;
    contacts.push(contact);
  }
  return { accounts, contacts, issues, counts: { created, updated, blocked: contacts.filter(c => groups.some(g => g.canonicalKey === c.canonicalKey) && c.active && (!scheduleRecipientEmail(c) || blocked.has(c.canonicalKey))).length } };
}
