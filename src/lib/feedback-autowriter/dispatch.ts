import { getDb, type Database } from "@/lib/db";
import {
  autowriterAlertEmails,
  autowriterEnabled,
  autowriterLineTo,
  autowriterTranscriptsEnabled,
  autowriterWritesAllowedHere,
  openRouterApiKey,
  sonioxApiKey,
  wiseApiActorId,
} from "./config";
import { cleanUpSonioxJobs, markWebhookProcessed, processSession, runSweep, type AutowriterDeps, type SweepResult } from "./job";
import { runReviewJob, type ReviewJobResult } from "./review-job";
import { createWiseFeedbackOps } from "./run";
import { readControl } from "./store";
import { createSonioxClient } from "./soniox";

function productionDeps(db: Database, budgetMs: number): AutowriterDeps {
  return {
    db,
    ops: createWiseFeedbackOps(),
    apiKey: openRouterApiKey(),
    apiActorId: wiseApiActorId(),
    writesAllowedHere: autowriterWritesAllowedHere(),
    deadlineMs: Date.now() + budgetMs,
    alertRecipients: autowriterAlertEmails(),
    // The second pass needs both the switch and a Soniox key; with either missing, nothing is handed over.
    transcriptsEnabled: autowriterTranscriptsEnabled() && Boolean(sonioxApiKey()),
    soniox: sonioxClient(),
  };
}

function sonioxClient() {
  const key = sonioxApiKey();
  return key ? createSonioxClient(key) : null;
}

/** Backstop cron / Data Health run. Budget leaves headroom under maxDuration = 800. */
export async function runAutowriterJob(): Promise<SweepResult | { ok: true; skipped: true; reason: string }> {
  if (!autowriterEnabled()) {
    // Switched off, transcripts still leave Soniox on time (72 h review window, then deleted).
    const deps = productionDeps(getDb(), 740_000);
    if (deps.soniox) await cleanUpSonioxJobs(deps, deps.soniox);
    return { ok: true, skipped: true, reason: "FEEDBACK_AUTOWRITER_ENABLED is not true." };
  }
  return runSweep(productionDeps(getDb(), 740_000));
}

/**
 * Hourly review job of the operating loop (cron / Data Health). Reads our database only and never writes to Wise;
 * paused with the autowriter itself.
 */
export async function runAutowriterReviewJob(
  triggerSource: "cron" | "admin" = "cron",
): Promise<ReviewJobResult | { ok: true; skipped: true; reason: string }> {
  if (!autowriterEnabled()) {
    return { ok: true, skipped: true, reason: "FEEDBACK_AUTOWRITER_ENABLED is not true." };
  }
  if (!autowriterWritesAllowedHere()) {
    return { ok: true, skipped: true, reason: "Preview deployment: the review job never runs here." };
  }
  const db = getDb();
  const control = await readControl(db);
  return runReviewJob({
    db,
    apiActorId: wiseApiActorId(),
    writesAllowedHere: true,
    triggerSource,
    liveNow: control.mode === "live",
    disabledTutors: control.disabledTutors,
    channels: { emailRecipients: autowriterAlertEmails(), lineTo: autowriterLineTo() },
  });
}

/** Runs inside the webhook's `after()`: one session, same guarded path as the cron. */
export async function processWebhookTrigger(db: Database, webhookEventId: string, wiseSessionId: string): Promise<void> {
  if (!autowriterEnabled()) {
    await markWebhookProcessed(db, webhookEventId, "autowriter_disabled");
    return;
  }
  // 740 s = the 180 s readiness wait + one session's work (AUTOWRITER_SWEEP_MIN_REMAINING_MS), under maxDuration 800.
  const outcome = await processSession(productionDeps(db, 740_000), {
    wiseSessionId,
    trigger: "webhook",
    waitForReadyMs: 180_000,
  });
  await markWebhookProcessed(db, webhookEventId, outcome.detail ? `${outcome.result}:${outcome.detail}` : outcome.result);
}
