import { getDb, type Database } from "@/lib/db";
import {
  autowriterAlertEmails,
  autowriterEnabled,
  autowriterWritesAllowedHere,
  openRouterApiKey,
  wiseApiActorId,
} from "./config";
import { markWebhookProcessed, processSession, runSweep, type AutowriterDeps, type SweepResult } from "./job";
import { createWiseFeedbackOps } from "./run";

function productionDeps(db: Database, budgetMs: number): AutowriterDeps {
  return {
    db,
    ops: createWiseFeedbackOps(),
    apiKey: openRouterApiKey(),
    apiActorId: wiseApiActorId(),
    writesAllowedHere: autowriterWritesAllowedHere(),
    deadlineMs: Date.now() + budgetMs,
    alertRecipients: autowriterAlertEmails(),
  };
}

/** Backstop cron / Data Health run. Budget leaves headroom under maxDuration = 800. */
export async function runAutowriterJob(): Promise<SweepResult | { ok: true; skipped: true; reason: string }> {
  if (!autowriterEnabled()) {
    return { ok: true, skipped: true, reason: "FEEDBACK_AUTOWRITER_ENABLED is not true." };
  }
  return runSweep(productionDeps(getDb(), 740_000));
}

/** Runs inside the webhook's `after()`: one session, same guarded path as the cron. */
export async function processWebhookTrigger(db: Database, webhookEventId: string, wiseSessionId: string): Promise<void> {
  if (!autowriterEnabled()) {
    await markWebhookProcessed(db, webhookEventId, "autowriter_disabled");
    return;
  }
  const outcome = await processSession(productionDeps(db, 720_000), {
    wiseSessionId,
    trigger: "webhook",
    waitForReadyMs: 180_000,
  });
  await markWebhookProcessed(db, webhookEventId, outcome.detail ? `${outcome.result}:${outcome.detail}` : outcome.result);
}
