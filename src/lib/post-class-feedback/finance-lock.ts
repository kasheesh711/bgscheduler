import "server-only";

import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";

const POST_CLASS_FINANCE_LOCK_KEY = "post_class_feedback_finance";

/**
 * Serialize finance-period transitions, deduction decisions, payout
 * publication, compensation, exceptions, and date rolling under one durable
 * PostgreSQL transaction lock.
 */
export async function lockPostClassFinance(db: Database): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${POST_CLASS_FINANCE_LOCK_KEY}))`,
  );
}
