/**
 * LINE backlog identity recovery orchestrator (IDENT-07).
 *
 * Runs `runLineBacklogRecovery` which matches stored follower displayNames against
 * human-verified OA-resolver targets (~662 rows) using distinctive-token matching
 * and inserts suggested links into lineContactStudentLinks.
 *
 * Module dependency (no cycles):
 *   student-links.ts (base) ← backlog-matcher.ts ← backlog-recovery.ts → student-links.ts
 *
 * Fail-closed invariant: all inserts use status:"suggested" — NEVER status:"verified" (IDENT-02).
 * No DB imports outside this file's own logic; no LINE API calls (uses stored displayName).
 */
import { isNotNull } from "drizzle-orm";
import {
  buildTargetTokenIndex,
  matchFollowersToTargets,
  type BacklogMatchResult,
} from "@/lib/line/backlog-matcher";
import {
  listVerifiedResolverTargets,
  studentLinkEvidence,
} from "@/lib/line/student-links";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LineBacklogRecoveryResult {
  contactsScanned: number;
  targetsCount: number;
  matchedCount: number;
  insertedCount: number;
  dryRun: boolean;
  /** Populated only when dryRun=true — the would-be suggestions for review. */
  dryRunMatches?: BacklogMatchResult[];
}

// ─── Core orchestrator ────────────────────────────────────────────────────────

/**
 * Recover LINE backlog identity by matching stored follower displayNames against
 * human-verified OA-resolver targets using distinctive-token matching (IDENT-07).
 *
 * Steps:
 *   1. Load all non-null displayName contacts from lineContacts (stored from Phase 11 re-anchor).
 *   2. Load verified targets from listVerifiedResolverTargets (~662 rows).
 *   3. Build token index from targets via buildTargetTokenIndex.
 *   4. Match each contact displayName via matchFollowersToTargets.
 *   5. If dryRun: return matches without writing. Else: insert suggested links.
 *
 * Uses stored displayName from lineContacts — no fresh LINE API calls needed.
 * This keeps the combined C1 route within maxDuration=300.
 *
 * ALWAYS inserts status:"suggested" — NEVER status:"verified" (IDENT-02).
 * Ambiguous matches (confidence "ambiguous") insert with confidence=0.60 and evidence.ambiguous=true.
 * onConflictDoNothing prevents duplicate (contactId, studentKey) suggestions.
 *
 * @param db - Neon database instance
 * @param dryRun - When true, computes matches but does NOT write to the DB
 * @returns Result counts + optional dryRunMatches when dryRun=true
 */
export async function runLineBacklogRecovery({
  db,
  dryRun = false,
}: {
  db: Database;
  dryRun?: boolean;
}): Promise<LineBacklogRecoveryResult> {
  // Step 1: Load all contacts with a displayName from lineContacts
  const contacts = await db
    .select({
      id: schema.lineContacts.id,
      lineUserId: schema.lineContacts.lineUserId,
      displayName: schema.lineContacts.displayName,
    })
    .from(schema.lineContacts)
    .where(isNotNull(schema.lineContacts.displayName));

  // Step 2: Load verified targets (~662 rows)
  const targets = await listVerifiedResolverTargets(db);

  // Step 3: Build token index and lookup map
  const index = buildTargetTokenIndex(targets);
  const targetsByStudentKey = new Map(targets.map((t) => [t.studentKey, t]));

  // Step 4: Match contacts to targets.
  // lineContacts has userId + displayName — shape matches what matchFollowersToTargets expects.
  // raw: {} satisfies the LineProfile interface without unnecessary API calls.
  const followers = contacts.map((c) => ({
    userId: c.lineUserId,
    displayName: c.displayName ?? undefined,
    raw: {} as Record<string, unknown>,
  }));
  const matches = matchFollowersToTargets(followers, index, targetsByStudentKey);

  // Map lineUserId → contactId for insert
  const contactIdByUserId = new Map(contacts.map((c) => [c.lineUserId, c.id]));

  const result: LineBacklogRecoveryResult = {
    contactsScanned: contacts.length,
    targetsCount: targets.length,
    matchedCount: matches.length,
    insertedCount: 0,
    dryRun,
    dryRunMatches: dryRun ? matches : undefined,
  };

  if (dryRun) return result;

  // Step 5: Insert suggestions
  for (const match of matches) {
    const contactId = contactIdByUserId.get(match.lineUserId);
    if (!contactId) continue;

    const isAmbiguous = match.confidence === "ambiguous";
    const target = targetsByStudentKey.get(match.matchedStudentKey);
    if (!target) continue;

    await db
      .insert(schema.lineContactStudentLinks)
      .values({
        contactId,
        wiseStudentId: target.wiseStudentId,
        studentKey: target.studentKey,
        studentName: target.studentName,
        parentName: target.parentName,
        status: "suggested",          // ALWAYS suggested — NEVER verified from content (IDENT-02)
        confidence: isAmbiguous ? 0.60 : 0.95,
        evidence: studentLinkEvidence({
          source: "follower_profile",
          originalUrl: target.lineChatUrl,   // wires the "LINE" button in link-validation-panel.tsx
          ambiguous: isAmbiguous,
          tokens: match.tokens,
          displayName: match.displayName,
        }),
      })
      .onConflictDoNothing({
        target: [
          schema.lineContactStudentLinks.contactId,
          schema.lineContactStudentLinks.studentKey,
        ],
      });
    result.insertedCount += 1;
  }

  return result;
}
