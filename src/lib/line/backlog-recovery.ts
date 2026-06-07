/**
 * LINE backlog identity recovery orchestrator (IDENT-07).
 *
 * Runs `runLineBacklogRecovery` which fetches the FULL LINE follower roster
 * (fetchLineFollowerIds + fetchLineProfilesBatched), then matches fresh display names
 * against human-verified OA-resolver targets (~662 rows) using distinctive-token matching,
 * and inserts suggested links into lineContactStudentLinks.
 *
 * Why fresh-fetch instead of stored displayName (corrective change — Phase 12 deviation):
 * The stored lineContacts approach yielded only 41 high-confidence matches (lineContacts
 * has 788 rows with displayNames, many lacking a resolver-target match). The full-roster
 * path reaches the UAT-validated 229 matches because it covers all 1,962 OA followers,
 * not just those already upserted into lineContacts.
 *
 * Module dependency (no cycles):
 *   client.ts ← student-links.ts (base) ← backlog-matcher.ts ← backlog-recovery.ts → student-links.ts
 *
 * Fail-closed invariant: all inserts use status:"suggested" — NEVER status:"verified" (IDENT-02).
 * No DB reads for the scan (roster comes from LINE API); DB writes only on dryRun=false.
 */
import {
  fetchLineFollowerIds,
  fetchLineProfilesBatched,
} from "@/lib/line/client";
import {
  buildTargetTokenIndex,
  matchFollowersToTargets,
  type BacklogMatchResult,
} from "@/lib/line/backlog-matcher";
import {
  listVerifiedResolverTargets,
  studentLinkEvidence,
  upsertLineContactFromFollower,
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
 * Recover LINE backlog identity by fetching the full follower roster and matching
 * fresh display names against human-verified OA-resolver targets (IDENT-07).
 *
 * Steps:
 *   1. Paginate fetchLineFollowerIds to collect all follower userIds (full LINE roster).
 *   2. Batch-fetch LINE profiles via fetchLineProfilesBatched (concurrency 10; 404 → skipped).
 *   3. Load verified targets from listVerifiedResolverTargets (~662 rows).
 *   4. Build token index + match followers via matchFollowersToTargets.
 *   5. If dryRun: return matches without writing. Else: upsert contact + insert suggested links.
 *
 * Fresh-fetches the full LINE roster — not the stored lineContacts displayNames.
 * This reaches all 1,962 OA followers, yielding ~229 matches vs. ~41 from stored data.
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
  // Step 1: Paginate the full follower roster (read-only LINE API)
  const allUserIds: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page = await fetchLineFollowerIds(cursor);
    allUserIds.push(...page.userIds);
    cursor = page.next;
  } while (cursor);

  // Step 2: Batch-fetch profiles (404 → skipped). concurrency 10.
  const profiles = await fetchLineProfilesBatched(allUserIds, 10);

  // Step 3: Load verified targets (~662 rows)
  const targets = await listVerifiedResolverTargets(db);

  // Step 4: Build token index + lookup map + match the full roster
  const index = buildTargetTokenIndex(targets);
  const targetsByStudentKey = new Map(targets.map((t) => [t.studentKey, t]));
  const followers = [...profiles.values()].map((p) => ({
    userId: p.userId,
    displayName: p.displayName ?? undefined,
    raw: p.raw,
  }));
  const matches = matchFollowersToTargets(followers, index, targetsByStudentKey);

  const result: LineBacklogRecoveryResult = {
    contactsScanned: profiles.size,
    targetsCount: targets.length,
    matchedCount: matches.length,
    insertedCount: 0,
    dryRun,
    dryRunMatches: dryRun ? matches : undefined,
  };

  if (dryRun) return result;   // TRUE read-only — no DB writes

  // Step 5: Live: per match → upsert contact (get contactId) → insert suggestion
  for (const match of matches) {
    const target = targetsByStudentKey.get(match.matchedStudentKey);
    if (!target) continue;

    const contactId = await upsertLineContactFromFollower(
      db,
      match.lineUserId,
      profiles.get(match.lineUserId) ?? null,
    );
    if (!contactId) continue;

    const isAmbiguous = match.confidence === "ambiguous";
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
