import type { Database } from '@/lib/db';
import type { CronJobHealth } from '@/lib/data-health/types';
import { feedbackGmailAccessToken, feedbackMailboxStatus } from './gmail-credentials';
import { loadNightlyReminderHealth } from './nightly-reminder-health';
import { dispatchReminderAlerts, queueReminderAlert } from './reminder-line';

export async function monitorNightlyReminders(db: Database, now = new Date(), job?: CronJobHealth) {
  let failure: string | null = null;
  let detail = 'Nightly feedback reminders are healthy.';
  try {
    let health = await loadNightlyReminderHealth(db, now);
    if (health.mode !== 'live' && !health.unresolvedDeliveries) {
      await dispatchReminderAlerts(db, now); return { active: false, failing: false };
    }
    const hour = (now.getUTCHours() + 7) % 24;
    let mailbox = await feedbackMailboxStatus(db);
    if (health.mode === 'live' && hour === 21 && (!mailbox.refreshedAt || now.getTime() - Date.parse(mailbox.refreshedAt) >= 15 * 60_000)) {
      try { await feedbackGmailAccessToken(true, db); }
      catch { failure = 'Gmail preflight failed. Check the mailbox connection and renew authorization before 22:00 Bangkok.'; }
      mailbox = await feedbackMailboxStatus(db);
      health = await loadNightlyReminderHealth(db, now);
    }
    if (health.mode === 'live' && (!mailbox.connected || mailbox.lastError)) failure ??= 'Gmail authorization needs attention. Check the Class Feedback connection.';
    if (health.status === 'failing') failure ??= health.detail;
    if (health.mode === 'live' && job && ['failing', 'stale', 'unknown'].includes(job.status)) failure ??= `The nightly reminder job is ${job.status}. ${job.healthDetail}`;
    detail = health.detail;
  } catch { failure = 'Nightly reminder health could not be checked. Review Data Health.'; }
  await queueReminderAlert(!failure, failure ?? detail, db, now);
  await dispatchReminderAlerts(db, now);
  return { active: true, failing: Boolean(failure) };
}
