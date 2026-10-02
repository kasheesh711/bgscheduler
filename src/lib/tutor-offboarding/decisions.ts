import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { TutorOffboardingError } from "./errors";
import type { DecisionRecord, OffboardingBand } from "./types";

export const SNOOZE_DAYS = [90, 365] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

const DAY_MS = 86_400_000;
type DecisionRow = typeof schema.tutorOffboardingDecisions.$inferSelect;

function toRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    canonicalKey: row.canonicalKey,
    note: row.note,
    snoozeUntil: row.snoozeUntil.toISOString(),
    likelihoodAtDecision: row.likelihoodAtDecision,
    bandAtDecision: row.bandAtDecision as OffboardingBand,
    reasons: row.reasons,
    decidedByEmail: row.decidedByEmail,
    decidedAt: row.decidedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByEmail: row.revokedByEmail,
  };
}

/** The newest `logLimit` decisions plus every open one, newest first. */
export async function listDecisions(db: Database = getDb(), now: Date = new Date(), logLimit = 200): Promise<DecisionRecord[]> {
  const table = schema.tutorOffboardingDecisions;
  const [open, recent] = await Promise.all([
    db.select().from(table).where(and(isNull(table.revokedAt), gt(table.snoozeUntil, now))),
    db.select().from(table).orderBy(desc(table.decidedAt)).limit(logLimit),
  ]);
  const byId = new Map([...recent, ...open].map((row) => [row.id, row]));
  return [...byId.values()].sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()).map(toRecord);
}

/** Records "Still with us" with the score it overrides (future labels). One open decision per person. */
export async function recordStillWithUs(db: Database, input: {
  canonicalKey: string;
  note: string | null;
  snoozeDays: SnoozeDays;
  actorEmail: string;
  score: { likelihood: number; band: OffboardingBand; reasons: string[] };
  now?: Date;
}): Promise<DecisionRecord> {
  const now = input.now ?? new Date();
  const table = schema.tutorOffboardingDecisions;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tutor_offboarding_decision:${input.canonicalKey}`}))`);
    const [open] = await tx.select({ id: table.id }).from(table)
      .where(and(eq(table.canonicalKey, input.canonicalKey), isNull(table.revokedAt), gt(table.snoozeUntil, now))).limit(1);
    if (open) throw new TutorOffboardingError("This tutor is already marked still with us.", 409);
    const [row] = await tx.insert(table).values({
      canonicalKey: input.canonicalKey,
      note: input.note,
      snoozeUntil: new Date(now.getTime() + input.snoozeDays * DAY_MS),
      likelihoodAtDecision: input.score.likelihood,
      bandAtDecision: input.score.band,
      reasons: input.score.reasons,
      decidedByEmail: input.actorEmail,
      decidedAt: now,
    }).returning();
    return toRecord(row);
  });
}

export async function revokeDecision(db: Database, input: { decisionId: string; actorEmail: string; now?: Date }): Promise<DecisionRecord> {
  const table = schema.tutorOffboardingDecisions;
  const [row] = await db.update(table).set({ revokedAt: input.now ?? new Date(), revokedByEmail: input.actorEmail })
    .where(and(eq(table.id, input.decisionId), isNull(table.revokedAt))).returning();
  if (!row) throw new TutorOffboardingError("That decision was not found or was already undone.", 404);
  return toRecord(row);
}
