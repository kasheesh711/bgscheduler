// Admissions Case Management — email notifications: transport, tiering, caps,
// weekly digests, and member invites (design §7, PRD CM-110..112 and §3.7).
//
// Transport mirrors the discipline of src/lib/classrooms/schedule-email.ts
// (env-driven config, plain fetch, reply-to, fail-loud error handling, and a
// per-send record capturing the provider email id), but speaks to the Resend
// API directly (design §7 "existing Resend pattern"). Every send is recorded
// in admissions_notification_log; `dedupeKey` rides the table's partial
// unique index so keyed sends happen exactly once. Two tiers exist (CM-110):
// "interrupt" (direct messages, T-7d/T-48h deadline reminders, invites) and
// "batch" (weekly digest). CM-111 caps interrupts at 3/recipient/day —
// overflow collapses into ONE combined email. CM-112: per-category
// notification_prefs downgrades apply to digest content only; deadline
// reminders have no pref key and can never be disabled (fail-closed).
// Cron orchestrators write admissions_notification_runs rows with the same
// single-flight guard as wise_activity_sync_runs (partial unique index on
// status='running'; stale rows failed after 30 minutes).

import { createHash } from "node:crypto";
import { and, count, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCaseMembers,
  admissionsCases,
  admissionsCaseTasks,
  admissionsCounselors,
  admissionsNotificationLog,
  admissionsNotificationOutbox,
  admissionsNotificationRuns,
  admissionsSelfReportSections,
  admissionsStudents,
} from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  listAnnouncementsForCase,
  type AdmissionsAnnouncementDto,
} from "./announcements";
import { getOpenDeadlinesInRange } from "./calendar";
import { isUuidShaped, normalizeAdmissionsEmail } from "./members";
import type { AdmissionsWriteDb } from "./audit";
import type { AdmissionsTaskOwner } from "./meetings";
import type { AdmissionsMemberDto, AdmissionsRole } from "./types";

// ── Constants ───────────────────────────────────────────────────────────

/** Resend REST endpoint (design §7 transport). */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Fallback sender when ADMISSIONS_EMAIL_FROM is not configured. */
const DEFAULT_FROM = "BeGifted Admissions <onboarding@resend.dev>";

/** Fallback reply-to (mirrors the schedule-email default). */
const DEFAULT_REPLY_TO = "kevhsh7@gmail.com";

/** Sign-in link included in invite emails (PRD §3.7 — the ONLY link/data). */
export const ADMISSIONS_SIGN_IN_URL =
  `${(process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://bgscheduler.vercel.app").replace(/\/$/, "")}/login?callbackUrl=/admissions`;

/** CM-111: max interrupt emails per recipient per Bangkok day before collapse. */
export const INTERRUPT_DAILY_CAP = 3;

/** Deadline reminder windows (CM-110): T-7d and T-48h before the due date. */
export const DEADLINE_REMINDER_WINDOWS: readonly DeadlineReminderWindow[] = ["7d", "2d"];

const WINDOW_OFFSET_DAYS: Record<DeadlineReminderWindow, number> = { "7d": 7, "2d": 2 };

// Range-based scan copy: an item can enter a window mid-range (e.g. created
// 5 days out, or delivered late after a missed run), so labels say "within".
const WINDOW_LABELS: Record<DeadlineReminderWindow, string> = {
  "7d": "within 7 days",
  "2d": "within 48 hours",
};

/** Digest lookback: content created in the past 7 days (CM-110 batch tier). */
const WEEKLY_DIGEST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Running rows older than this are marked failed before a new run starts. */
const STALE_RUNNING_NOTIFICATION_RUN_MS = 30 * 60 * 1000;

/** A claimed outbox row becomes reclaimable after this lease expires. */
const OUTBOX_PROCESSING_LEASE_MS = 15 * 60 * 1000;

/** Retry backoff by completed attempt; the final value is the permanent cap. */
const OUTBOX_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────────

/** Log category (mirrors the admissions_notification_log.category comment). */
export type AdmissionsNotificationCategory =
  | "deadline_reminder"
  | "direct_message"
  | "digest"
  | "invite"
  | "announcement";

/** Delivery tier (CM-110): interrupt = immediate; batch = weekly digest. */
export type AdmissionsNotificationTier = "interrupt" | "batch";

/** Reminder window relative to the item's due date (CM-110). */
export type DeadlineReminderWindow = "7d" | "2d";

/**
 * Per-category downgrade prefs (CM-112), derived from the schema column so
 * the shape can never drift. Absent key / null row = default tier; deadline
 * reminders deliberately have no key here and cannot be disabled.
 */
export type AdmissionsNotificationPrefs = NonNullable<
  (typeof admissionsCaseMembers.$inferSelect)["notificationPrefs"]
>;

/** Input for one transactional email send. */
export interface SendAdmissionsEmailInput {
  to: string;
  subject: string;
  html: string;
  category: AdmissionsNotificationCategory;
  tier: AdmissionsNotificationTier;
  /** Case scope for the log row; null/absent for cross-case sends. */
  caseId?: string | null;
  /** Exactly-once key: an already-logged key short-circuits to skipped. */
  dedupeKey?: string | null;
}

/** Outcome of sendAdmissionsEmail. */
export interface SendAdmissionsEmailResult {
  /** True when the dedupeKey was already logged and no email was sent. */
  skipped: boolean;
  /** Resend-assigned email id; null when skipped or missing from response. */
  resendEmailId: string | null;
  /** admissions_notification_log row id; null when skipped. */
  logId: string | null;
}

/** One planned deadline reminder for one recipient (CM-110 interrupt tier). */
export interface DeadlineReminderItem {
  caseId: string;
  /** Calendar item id (task/list-item/essay/sitting-suffixed id). */
  itemId: string;
  title: string;
  /** Due date, "YYYY-MM-DD" (Asia/Bangkok calendar). */
  date: string;
  window: DeadlineReminderWindow;
  /** Exactly-once key: "{itemId}:{window}:{recipientEmail}". */
  dedupeKey: string;
}

/** All deadline reminders owed to one recipient on this scan. */
export interface RecipientDeadlineReminders {
  recipientEmail: string;
  items: DeadlineReminderItem[];
}

/** One new task in a weekly digest. */
export interface DigestTaskItem {
  id: string;
  title: string;
  owner: AdmissionsTaskOwner;
  dueDate: string | null;
  createdAt: string;
}

/** One self-report section submitted during the digest window. */
export interface DigestSubmissionItem {
  sectionKey: string;
  submittedAt: string;
}

/** One recipient's role-shaped, pref-filtered weekly digest content. */
export interface RecipientWeeklyDigest {
  recipientEmail: string;
  role: AdmissionsRole;
  announcements: AdmissionsAnnouncementDto[];
  newTasks: DigestTaskItem[];
  sectionSubmissions: DigestSubmissionItem[];
}

/** One case's weekly digest: per-recipient content plus the subject name. */
export interface CaseWeeklyDigest {
  caseId: string;
  studentFirstName: string;
  /** Only recipients with at least one non-empty section are included. */
  recipients: RecipientWeeklyDigest[];
}

/** Input for a counselor→member direct message (CM-110 interrupt tier). */
export interface DirectMessageInput {
  caseId: string;
  recipientEmail: string;
  senderName: string;
  subject: string;
  /** Plain text; rendered into escaped HTML paragraphs. */
  body: string;
}

/** Outcome of a runDailyNotifications / runWeeklyDigest orchestrator pass. */
export interface AdmissionsNotificationRunResult {
  /** True when another run was already in flight (single-flight skip). */
  skipped: boolean;
  runId: string | null;
  runType: "daily" | "weekly";
  sentCount: number;
  skippedCount: number;
  errorSummary: string | null;
}

/** Result of one pending notification-outbox delivery pass. */
export interface AdmissionsOutboxDeliveryResult {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Payload persisted for a member-invite outbox row. */
export interface MemberInviteOutboxPayload extends Record<string, unknown> {
  studentFirstName: string;
}

/** Payload persisted for a counselor direct-message outbox row. */
export interface DirectMessageOutboxPayload extends Record<string, unknown> {
  senderName: string;
  subject: string;
  body: string;
}

/** Result of inserting, or idempotently finding, one outbox row. */
export interface QueuedAdmissionsOutboxRow {
  id: string;
  inserted: boolean;
}

// ── Shared helpers ──────────────────────────────────────────────────────

/** Minimal HTML escaping for email bodies (mirrors schedule-email.ts). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts).
 */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** UTC instants bounding the Bangkok calendar day containing `now`. */
function getBangkokDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(`${getBangkokDateKey(now)}T00:00:00+07:00`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Unique-violation detector scoped to one index (copies wise-activity sync). */
function isUniqueViolation(error: unknown, indexName: string): boolean {
  const candidate = error as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  return candidate?.code === "23505" ||
    candidate?.cause?.code === "23505" ||
    (candidate?.message ?? "").includes(indexName);
}

/**
 * The child's first name for invite copy (PRD §3.7): the preferred name when
 * set, else the first whitespace token of the full name, else "Student"
 * (never leak a full/legal name into an invite).
 */
export function deriveStudentFirstName(student: {
  fullName: string;
  preferredName: string | null;
}): string {
  const preferred = student.preferredName?.trim();
  if (preferred) return preferred.split(/\s+/)[0];
  const first = student.fullName.trim().split(/\s+/)[0];
  return first || "Student";
}

// ── Transport (CM-110) ──────────────────────────────────────────────────

interface ResendEmailResponse {
  id?: string;
  message?: string;
}

function resendIdempotencyKey(dedupeKey: string): string {
  return `admissions_${createHash("sha256").update(dedupeKey).digest("hex")}`;
}

/**
 * Sends one email through Resend and records it in
 * admissions_notification_log.
 *
 * 1. Dedupe short-circuit: when `dedupeKey` is set and a log row already
 *    carries it, skip the send entirely and return `{ skipped: true }`.
 * 2. Send via the Resend REST API (RESEND_API_KEY required; optional
 *    ADMISSIONS_EMAIL_FROM / ADMISSIONS_EMAIL_REPLY_TO overrides) — non-2xx
 *    responses throw with the provider message, mirroring the
 *    schedule-email error discipline.
 * 3. Insert the log row capturing the Resend email id. A concurrent run that
 *    won the partial unique dedupe index races here — that unique violation
 *    is reported as skipped instead of thrown (the key was sent exactly once).
 *
 * @returns whether the send was skipped plus the Resend/log ids.
 */
export async function sendAdmissionsEmail(
  input: SendAdmissionsEmailInput,
  db: Database = getDb(),
): Promise<SendAdmissionsEmailResult> {
  const to = normalizeAdmissionsEmail(input.to);
  if (!to) throw new Error("Notification recipient email is required");
  const dedupeKey = input.dedupeKey ?? null;

  if (dedupeKey) {
    const existing = await db
      .select({ id: admissionsNotificationLog.id })
      .from(admissionsNotificationLog)
      .where(eq(admissionsNotificationLog.dedupeKey, dedupeKey))
      .limit(1);
    if (existing.length > 0) {
      return { skipped: true, resendEmailId: null, logId: null };
    }
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.ADMISSIONS_EMAIL_FROM?.trim() || DEFAULT_FROM;
  const replyTo = process.env.ADMISSIONS_EMAIL_REPLY_TO?.trim() || DEFAULT_REPLY_TO;

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(dedupeKey
        ? { "Idempotency-Key": resendIdempotencyKey(dedupeKey) }
        : {}),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: input.subject,
      html: input.html,
      reply_to: replyTo,
    }),
  });

  const json = await response.json().catch(() => null) as ResendEmailResponse | null;
  if (!response.ok) {
    throw new Error(json?.message ?? `Resend returned HTTP ${response.status}`);
  }
  const resendEmailId = typeof json?.id === "string" && json.id.trim() ? json.id : null;

  try {
    const rows = await db
      .insert(admissionsNotificationLog)
      .values({
        caseId: input.caseId ?? null,
        recipientEmail: to,
        category: input.category,
        tier: input.tier,
        subject: input.subject,
        resendEmailId,
        dedupeKey,
        sentAt: new Date(),
      })
      .returning({ id: admissionsNotificationLog.id });
    return { skipped: false, resendEmailId, logId: rows[0]?.id ?? null };
  } catch (error) {
    if (dedupeKey && isUniqueViolation(error, "admissions_notification_log_dedupe_key_idx")) {
      return { skipped: true, resendEmailId, logId: null };
    }
    throw error;
  }
}

/**
 * Interrupt-tier emails already logged for this recipient during the current
 * Bangkok calendar day (feeds the CM-111 collapse decision).
 */
async function countInterruptEmailsToday(
  recipientEmail: string,
  now: Date,
  db: Database,
): Promise<number> {
  const { start, end } = getBangkokDayBounds(now);
  const rows = await db
    .select({ value: count() })
    .from(admissionsNotificationLog)
    .where(and(
      eq(admissionsNotificationLog.recipientEmail, recipientEmail),
      eq(admissionsNotificationLog.tier, "interrupt"),
      gte(admissionsNotificationLog.sentAt, start),
      lt(admissionsNotificationLog.sentAt, end),
    ));
  return rows[0]?.value ?? 0;
}

// ── Direct messages (CM-110 interrupt) ──────────────────────────────────

/**
 * Sends a counselor→member direct message (interrupt tier, CM-110).
 * Transactional-outbox callers pass a stable dedupe key so a provider success
 * followed by a worker failure remains safe to retry.
 *
 * @returns the transport result.
 */
export async function notifyDirectMessage(
  input: DirectMessageInput,
  db: Database = getDb(),
  options: { dedupeKey?: string } = {},
): Promise<SendAdmissionsEmailResult> {
  if (!isUuidShaped(input.caseId)) throw new Error("NotFound");
  if (!input.subject.trim()) throw new Error("Direct message subject must not be empty");
  if (!input.body.trim()) throw new Error("Direct message body must not be empty");

  const paragraphs = input.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p style="margin:0 0 12px;">${escapeHtml(line)}</p>`)
    .join("");
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">
      <p style="margin:0 0 12px;">Message from ${escapeHtml(input.senderName)}:</p>
      ${paragraphs}
    </div>`;

  return sendAdmissionsEmail({
    to: input.recipientEmail,
    subject: input.subject.trim(),
    html,
    category: "direct_message",
    tier: "interrupt",
    caseId: input.caseId,
    dedupeKey: options.dedupeKey,
  }, db);
}

// ── Deadline reminders (CM-110/CM-111/CM-112) ───────────────────────────

/**
 * Scans every live (active/committed) case for OPEN calendar items due within
 * the next 7 Bangkok days and plans one reminder per assigned recipient.
 *
 * The scan is range-based, not exact-day: items due within 2 days plan the
 * "2d" window, items due within 7 days plan the "7d" window (most-urgent
 * window wins per day). Because the per-(item, window, recipient) dedupe key
 * makes re-sends idempotent, a missed daily run self-heals — the next run
 * still matches every item inside the window and delivers the reminders the
 * outage skipped (an item due tomorrow after a missed day still gets its
 * "2d" reminder). The item fetch is uncapped (getOpenDeadlinesInRange), so a
 * backlog of overdue items can never starve reminder targets out of a cap.
 *
 * 1. Compute the window bounds from `now`: [today, today+7] Bangkok days.
 * 2. Load active/committed, non-deleted cases; nothing live → [].
 * 3. Load all ACTIVE members for those cases in one query.
 * 4. Fetch every open dated item inside the window in ONE batched pass
 *    (completed items never remind) and assign each its most urgent window:
 *    date <= today+2 → "2d", else "7d".
 * 5. Route each item by ownerRole to the matching active member emails
 *    (student item → student members, counselor item → counselor members,
 *    parent item → parent members); ownerless items (ownerRole null, e.g.
 *    application deadlines) are skipped — CM-110 reminds only "items
 *    assigned to the recipient".
 * 6. notificationPrefs are deliberately ignored: deadline reminders have no
 *    pref key and can never be downgraded or disabled (CM-112, fail-closed).
 *
 * @returns per-recipient reminder plans, recipients and items in stable order.
 */
export async function buildDeadlineReminders(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<RecipientDeadlineReminders[]> {
  const todayKey = getBangkokDateKey(now);
  const windowBounds: Record<DeadlineReminderWindow, string> = {
    "2d": getBangkokDateKey(new Date(now.getTime() + WINDOW_OFFSET_DAYS["2d"] * DAY_MS)),
    "7d": getBangkokDateKey(new Date(now.getTime() + WINDOW_OFFSET_DAYS["7d"] * DAY_MS)),
  };

  const caseRows = await db
    .select({
      id: admissionsCases.id,
      familyPortalOpen: admissionsCases.familyPortalOpen,
    })
    .from(admissionsCases)
    .where(and(
      inArray(admissionsCases.status, ["active", "committed"]),
      isNull(admissionsCases.deletedAt),
    ));
  const caseIds = caseRows.map((row) => row.id);
  const familyPortalByCase = new Map(
    caseRows.map((row) => [row.id, row.familyPortalOpen]),
  );
  if (caseIds.length === 0) return [];

  const memberRows = await db
    .select()
    .from(admissionsCaseMembers)
    .where(and(
      inArray(admissionsCaseMembers.caseId, caseIds),
      eq(admissionsCaseMembers.status, "active"),
      or(
        ne(admissionsCaseMembers.role, "counselor"),
        sql<boolean>`EXISTS (
          SELECT 1 FROM ${admissionsCounselors}
          WHERE ${admissionsCounselors.email} = ${admissionsCaseMembers.email}
            AND ${admissionsCounselors.active} = true
        )`,
      ),
    ));
  const membersByCase = new Map<string, Array<{ email: string; role: AdmissionsRole }>>();
  for (const member of memberRows) {
    if (
      (member.role === "student" || member.role === "parent") &&
      familyPortalByCase.get(member.caseId) !== true
    ) {
      continue;
    }
    const list = membersByCase.get(member.caseId) ?? [];
    list.push({ email: member.email, role: member.role });
    membersByCase.set(member.caseId, list);
  }

  const items = await getOpenDeadlinesInRange(
    caseIds,
    { from: todayKey, to: windowBounds["7d"] },
    now,
    db,
  );

  const byRecipient = new Map<string, DeadlineReminderItem[]>();
  for (const item of items) {
    if (item.ownerRole === null) continue;
    const window: DeadlineReminderWindow =
      item.date <= windowBounds["2d"] ? "2d" : "7d";
    const recipients = (membersByCase.get(item.caseId) ?? [])
      .filter((member) => member.role === item.ownerRole);
    for (const recipient of recipients) {
      const planned = byRecipient.get(recipient.email) ?? [];
      planned.push({
        caseId: item.caseId,
        itemId: item.id,
        title: item.title,
        date: item.date,
        window,
        dedupeKey: `${item.id}:${window}:${recipient.email}`,
      });
      byRecipient.set(recipient.email, planned);
    }
  }

  return [...byRecipient.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([recipientEmail, items]) => ({
      recipientEmail,
      items: [...items].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
      }),
    }));
}

function renderReminderHtml(item: DeadlineReminderItem): string {
  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">
      <p style="margin:0 0 12px;"><strong>${escapeHtml(item.title)}</strong> is due
        <strong>${escapeHtml(item.date)}</strong> (${WINDOW_LABELS[item.window]}).</p>
      <p style="margin:0;">Sign in to review: <a href="${ADMISSIONS_SIGN_IN_URL}">${ADMISSIONS_SIGN_IN_URL}</a></p>
    </div>`;
}

function renderCombinedReminderHtml(items: DeadlineReminderItem[]): string {
  const rows = items
    .map((item) => `<li style="margin:0 0 8px;"><strong>${escapeHtml(item.title)}</strong> — due ${escapeHtml(item.date)} (${WINDOW_LABELS[item.window]})</li>`)
    .join("");
  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">
      <p style="margin:0 0 12px;">You have ${items.length} upcoming admissions deadlines:</p>
      <ul style="margin:0 0 12px;padding-left:20px;">${rows}</ul>
      <p style="margin:0;">Sign in to review: <a href="${ADMISSIONS_SIGN_IN_URL}">${ADMISSIONS_SIGN_IN_URL}</a></p>
    </div>`;
}

/**
 * Dedupe keys among `keys` that already carry a notification-log row — those
 * reminder windows were delivered before, either individually or covered by
 * an earlier combined email (recordCoveredReminder).
 */
async function findDeliveredDedupeKeys(
  keys: readonly string[],
  db: Database,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ dedupeKey: admissionsNotificationLog.dedupeKey })
    .from(admissionsNotificationLog)
    .where(inArray(admissionsNotificationLog.dedupeKey, [...keys]));
  return new Set(
    rows
      .map((row) => row.dedupeKey)
      .filter((key): key is string => typeof key === "string"),
  );
}

/**
 * Marks one reminder window delivered WITHOUT sending (a combined email
 * already carried it): inserts the per-item dedupe row so later daily scans
 * — which re-plan every open in-window item — never re-list the window. A
 * unique violation means a concurrent run recorded it first (fine).
 */
async function recordCoveredReminder(
  item: DeadlineReminderItem,
  recipientEmail: string,
  subject: string,
  db: Database,
): Promise<void> {
  try {
    await db
      .insert(admissionsNotificationLog)
      .values({
        caseId: item.caseId,
        recipientEmail,
        category: "deadline_reminder",
        tier: "interrupt",
        subject,
        resendEmailId: null,
        dedupeKey: item.dedupeKey,
        sentAt: new Date(),
      })
      .returning({ id: admissionsNotificationLog.id });
  } catch (error) {
    if (!isUniqueViolation(error, "admissions_notification_log_dedupe_key_idx")) {
      throw error;
    }
  }
}

/**
 * Delivers one recipient's planned reminders, applying the CM-111 daily cap.
 *
 * 1. Drop windows already delivered (per-item dedupe keys — the range scan
 *    re-plans every open in-window item daily, so this filter is what makes
 *    the daily re-plan idempotent); nothing pending → all skipped.
 * 2. Count today's interrupt-tier log rows for the recipient (Bangkok day).
 * 3. When already-sent + pending would exceed INTERRUPT_DAILY_CAP, collapse
 *    everything into ONE combined email (dedupe key
 *    "deadline-combined:{recipient}:{today}" keeps same-day re-runs
 *    idempotent) and record each covered item window (recordCoveredReminder)
 *    so tomorrow's scan does not re-send a near-identical combined email.
 * 4. Otherwise send one email per pending item with its own dedupe key.
 */
async function deliverDeadlineReminders(
  recipient: RecipientDeadlineReminders,
  now: Date,
  db: Database,
): Promise<{ sent: number; skipped: number }> {
  const todayKey = getBangkokDateKey(now);

  const delivered = await findDeliveredDedupeKeys(
    recipient.items.map((item) => item.dedupeKey),
    db,
  );
  const pending = recipient.items.filter((item) => !delivered.has(item.dedupeKey));
  const alreadyDelivered = recipient.items.length - pending.length;
  if (pending.length === 0) return { sent: 0, skipped: alreadyDelivered };

  const alreadySentToday = await countInterruptEmailsToday(recipient.recipientEmail, now, db);

  if (alreadySentToday + pending.length > INTERRUPT_DAILY_CAP) {
    const caseIds = new Set(pending.map((item) => item.caseId));
    const subject = `Reminder: ${pending.length} admissions deadlines coming up`;
    const result = await sendAdmissionsEmail({
      to: recipient.recipientEmail,
      subject,
      html: renderCombinedReminderHtml(pending),
      category: "deadline_reminder",
      tier: "interrupt",
      caseId: caseIds.size === 1 ? pending[0].caseId : null,
      dedupeKey: `deadline-combined:${recipient.recipientEmail}:${todayKey}`,
    }, db);
    if (result.skipped) return { sent: 0, skipped: recipient.items.length };
    for (const item of pending) {
      await recordCoveredReminder(item, recipient.recipientEmail, subject, db);
    }
    return { sent: 1, skipped: alreadyDelivered };
  }

  let sent = 0;
  let skipped = alreadyDelivered;
  for (const item of pending) {
    const result = await sendAdmissionsEmail({
      to: recipient.recipientEmail,
      subject: `Reminder: "${item.title}" is due ${item.date} (${WINDOW_LABELS[item.window]})`,
      html: renderReminderHtml(item),
      category: "deadline_reminder",
      tier: "interrupt",
      caseId: item.caseId,
      dedupeKey: item.dedupeKey,
    }, db);
    if (result.skipped) skipped += 1;
    else sent += 1;
  }
  return { sent, skipped };
}

// ── Weekly digest (CM-110 batch, CM-112 prefs) ──────────────────────────

/**
 * Assembles one case's weekly digest: announcements, new tasks, and
 * self-report section submissions from the past 7 days, shaped per recipient
 * role and filtered by notificationPrefs downgrades (CM-110/CM-112).
 *
 * 1. Load announcements via listAnnouncementsForCase (validates the case,
 *    throws "NotFound" for malformed/missing/deleted cases) and keep rows
 *    created inside the 7-day window.
 * 2. Resolve the student's first name (digest subject line).
 * 3. Load non-deleted tasks and submitted sections, filtering to the window
 *    in process (fail-closed: malformed rows are dropped, never guessed).
 * 4. Shape per active member role: counselors see everything; students see
 *    announcements + new tasks; parents see announcements only (§2.3 parent
 *    projection — no task/submission internals reach the parent surface).
 * 5. Apply prefs: "off" removes that category from the member's digest
 *    (announcements/tasks keys; section submissions ride the "comments" key
 *    — the digest's review-activity category). Null prefs = all defaults.
 * 6. Members whose shaped digest is entirely empty receive nothing.
 *
 * @returns the per-recipient digest payloads for the case.
 */
export async function buildWeeklyDigest(
  caseId: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CaseWeeklyDigest> {
  const cutoff = new Date(now.getTime() - WEEKLY_DIGEST_LOOKBACK_MS);

  const announcements = (await listAnnouncementsForCase(caseId, db))
    .filter((row) => new Date(row.createdAt).getTime() >= cutoff.getTime());

  const studentRows = await db
    .select({
      fullName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
      familyPortalOpen: admissionsCases.familyPortalOpen,
      caseStatus: admissionsCases.status,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const studentRow = studentRows[0];
  if (!studentRow) throw new Error("NotFound");
  const studentFirstName = deriveStudentFirstName(studentRow);

  const taskRows = await db
    .select({
      id: admissionsCaseTasks.id,
      title: admissionsCaseTasks.title,
      owner: admissionsCaseTasks.owner,
      dueDate: admissionsCaseTasks.dueDate,
      createdAt: admissionsCaseTasks.createdAt,
    })
    .from(admissionsCaseTasks)
    .where(and(
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    ));
  const newTasks: DigestTaskItem[] = taskRows
    .filter((row) => row.createdAt.getTime() >= cutoff.getTime())
    .map((row) => ({
      id: row.id,
      title: row.title,
      owner: row.owner,
      dueDate: row.dueDate,
      createdAt: row.createdAt.toISOString(),
    }));

  const sectionRows = await db
    .select({
      sectionKey: admissionsSelfReportSections.sectionKey,
      submittedAt: admissionsSelfReportSections.submittedAt,
    })
    .from(admissionsSelfReportSections)
    .where(eq(admissionsSelfReportSections.caseId, caseId));
  const sectionSubmissions: DigestSubmissionItem[] = sectionRows
    .filter((row): row is { sectionKey: string; submittedAt: Date } =>
      row.submittedAt !== null && row.submittedAt.getTime() >= cutoff.getTime())
    .map((row) => ({
      sectionKey: row.sectionKey,
      submittedAt: row.submittedAt.toISOString(),
    }));

  const memberRows = await db
    .select()
    .from(admissionsCaseMembers)
    .where(and(
      eq(admissionsCaseMembers.caseId, caseId),
      eq(admissionsCaseMembers.status, "active"),
      or(
        ne(admissionsCaseMembers.role, "counselor"),
        sql<boolean>`EXISTS (
          SELECT 1 FROM ${admissionsCounselors}
          WHERE ${admissionsCounselors.email} = ${admissionsCaseMembers.email}
            AND ${admissionsCounselors.active} = true
        )`,
      ),
    ));

  const recipients: RecipientWeeklyDigest[] = [];
  for (const member of memberRows) {
    if (
      (member.role === "student" || member.role === "parent") &&
      (studentRow.familyPortalOpen !== true ||
        (studentRow.caseStatus !== "active" && studentRow.caseStatus !== "committed"))
    ) {
      continue;
    }
    const prefs = member.notificationPrefs;
    const roleAnnouncements = announcements;
    const roleTasks = member.role === "parent" ? [] : newTasks;
    const roleSubmissions = member.role === "counselor" ? sectionSubmissions : [];

    const digest: RecipientWeeklyDigest = {
      recipientEmail: member.email,
      role: member.role,
      announcements: prefs?.announcements === "off" ? [] : roleAnnouncements,
      newTasks: prefs?.tasks === "off" ? [] : roleTasks,
      sectionSubmissions: prefs?.comments === "off" ? [] : roleSubmissions,
    };
    if (
      digest.announcements.length === 0 &&
      digest.newTasks.length === 0 &&
      digest.sectionSubmissions.length === 0
    ) {
      continue;
    }
    recipients.push(digest);
  }

  return { caseId, studentFirstName, recipients };
}

function renderWeeklyDigestHtml(
  digest: RecipientWeeklyDigest,
  studentFirstName: string,
): string {
  const sections: string[] = [];
  if (digest.announcements.length > 0) {
    const rows = digest.announcements
      .map((row) => `<li style="margin:0 0 8px;"><strong>${escapeHtml(row.title)}</strong><br />${escapeHtml(row.body)}</li>`)
      .join("");
    sections.push(`<h3 style="margin:16px 0 8px;font-size:15px;">Announcements</h3><ul style="margin:0;padding-left:20px;">${rows}</ul>`);
  }
  if (digest.newTasks.length > 0) {
    const rows = digest.newTasks
      .map((task) => `<li style="margin:0 0 8px;">${escapeHtml(task.title)}${task.dueDate ? ` — due ${escapeHtml(task.dueDate)}` : ""}</li>`)
      .join("");
    sections.push(`<h3 style="margin:16px 0 8px;font-size:15px;">New tasks</h3><ul style="margin:0;padding-left:20px;">${rows}</ul>`);
  }
  if (digest.sectionSubmissions.length > 0) {
    const rows = digest.sectionSubmissions
      .map((submission) => `<li style="margin:0 0 8px;">Section submitted for review: ${escapeHtml(submission.sectionKey)}</li>`)
      .join("");
    sections.push(`<h3 style="margin:16px 0 8px;font-size:15px;">Submitted for review</h3><ul style="margin:0;padding-left:20px;">${rows}</ul>`);
  }

  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">
      <p style="margin:0 0 4px;">Weekly admissions update for ${escapeHtml(studentFirstName)}.</p>
      ${sections.join("")}
      <p style="margin:16px 0 0;">Sign in to review: <a href="${ADMISSIONS_SIGN_IN_URL}">${ADMISSIONS_SIGN_IN_URL}</a></p>
    </div>`;
}

// ── Member invites (PRD §3.7) ───────────────────────────────────────────

/**
 * Sends the bilingual (Thai-first) member invite email (PRD §3.7).
 *
 * The email deliberately contains ONLY the child's first name and the
 * sign-in link — no cohort, college, deadline, or any other case data.
 * Access activates only on exact email match at sign-in, so the invite
 * itself grants nothing. Outbox callers pass a per-invitation dedupe key;
 * direct/manual callers may omit one.
 *
 * @returns the transport result.
 */
export async function sendMemberInvite(
  member: Pick<AdmissionsMemberDto, "caseId" | "email">,
  studentFirstName: string,
  db: Database = getDb(),
  options: { dedupeKey?: string } = {},
): Promise<SendAdmissionsEmailResult> {
  const firstName = escapeHtml(studentFirstName.trim() || "Student");
  const subject = `คำเชิญเข้าใช้งานพอร์ทัลการสมัครมหาวิทยาลัยของ${studentFirstName.trim() || "Student"} — Invitation to ${studentFirstName.trim() || "Student"}'s university admissions portal`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;">
      <p style="margin:0 0 12px;">สวัสดีค่ะ/ครับ</p>
      <p style="margin:0 0 12px;">คุณได้รับเชิญให้เข้าใช้งานพอร์ทัลติดตามการสมัครเข้ามหาวิทยาลัยของ${firstName} กรุณาเข้าสู่ระบบด้วยอีเมลนี้ที่ลิงก์ด้านล่าง</p>
      <p style="margin:0 0 16px;"><a href="${ADMISSIONS_SIGN_IN_URL}">เข้าสู่ระบบ / Sign in</a></p>
      <p style="margin:0 0 12px;">Hello,</p>
      <p style="margin:0;">You have been invited to follow ${firstName}'s university admissions journey. Please sign in with this email address at the link above.</p>
    </div>`;

  return sendAdmissionsEmail({
    to: member.email,
    subject,
    html,
    category: "invite",
    tier: "interrupt",
    caseId: member.caseId,
    dedupeKey: options.dedupeKey,
  }, db);
}

/**
 * Resolves the case's student first name and sends an invite immediately.
 * Transactional membership flows use the outbox below; this helper remains
 * useful for direct delivery and focused transport tests.
 *
 * @returns the transport result.
 */
export async function sendMemberInviteForCase(
  member: AdmissionsMemberDto,
  db: Database = getDb(),
): Promise<SendAdmissionsEmailResult> {
  if (!isUuidShaped(member.caseId)) throw new Error("NotFound");

  const rows = await db
    .select({
      fullName: admissionsStudents.fullName,
      preferredName: admissionsStudents.preferredName,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .where(and(eq(admissionsCases.id, member.caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");

  return sendMemberInvite(member, deriveStudentFirstName(row), db);
}

// ── Transactional notification outbox ─────────────────────────────────

/**
 * Adds a member invitation using the caller's transaction. The surrounding
 * case/member write and this row therefore commit or roll back together.
 */
export async function queueMemberInviteOutbox(
  tx: AdmissionsWriteDb,
  input: {
    caseId: string;
    memberId: string;
    recipientEmail: string;
    studentFirstName: string;
    dedupeKey: string;
    now?: Date;
  },
): Promise<string> {
  const recipientEmail = normalizeAdmissionsEmail(input.recipientEmail);
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }
  if (!recipientEmail || !input.dedupeKey.trim()) {
    throw new Error("Notification outbox invite requires recipient and dedupe key");
  }

  const now = input.now ?? new Date();
  const payload: MemberInviteOutboxPayload = {
    studentFirstName: input.studentFirstName.trim() || "Student",
  };
  const rows = await tx
    .insert(admissionsNotificationOutbox)
    .values({
      caseId: input.caseId,
      memberId: input.memberId,
      recipientEmail,
      category: "invite",
      payload,
      dedupeKey: input.dedupeKey.trim(),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .returning({ id: admissionsNotificationOutbox.id });
  const row = rows[0];
  if (!row) throw new Error("Notification outbox insert returned no row");
  return row.id;
}

/**
 * Queues one counselor direct message in the caller's audited transaction.
 * The unique outbox dedupe key is derived from a client-generated UUID. A
 * replay with identical content resolves to the existing row; reusing the key
 * for different content fails closed.
 */
export async function queueDirectMessageOutbox(
  tx: AdmissionsWriteDb,
  input: {
    caseId: string;
    memberId: string;
    recipientEmail: string;
    senderName: string;
    subject: string;
    body: string;
    dedupeKey: string;
    now?: Date;
  },
): Promise<QueuedAdmissionsOutboxRow> {
  const recipientEmail = normalizeAdmissionsEmail(input.recipientEmail);
  const senderName = input.senderName.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();
  const dedupeKey = input.dedupeKey.trim();
  if (!isUuidShaped(input.caseId) || !isUuidShaped(input.memberId)) {
    throw new Error("NotFound");
  }
  if (!recipientEmail || !senderName || !subject || !body || !dedupeKey) {
    throw new Error("Invalid direct-message outbox payload");
  }
  if (senderName.length > 300 || subject.length > 300 || body.length > 20_000) {
    throw new Error("Invalid direct-message outbox payload");
  }

  const now = input.now ?? new Date();
  const payload: DirectMessageOutboxPayload = { senderName, subject, body };
  const inserted = await tx
    .insert(admissionsNotificationOutbox)
    .values({
      caseId: input.caseId,
      memberId: input.memberId,
      recipientEmail,
      category: "direct_message",
      payload,
      dedupeKey,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: admissionsNotificationOutbox.dedupeKey })
    .returning({ id: admissionsNotificationOutbox.id });
  if (inserted[0]) return { id: inserted[0].id, inserted: true };

  const existingRows = await tx
    .select({
      id: admissionsNotificationOutbox.id,
      caseId: admissionsNotificationOutbox.caseId,
      memberId: admissionsNotificationOutbox.memberId,
      recipientEmail: admissionsNotificationOutbox.recipientEmail,
      category: admissionsNotificationOutbox.category,
      payload: admissionsNotificationOutbox.payload,
    })
    .from(admissionsNotificationOutbox)
    .where(eq(admissionsNotificationOutbox.dedupeKey, dedupeKey))
    .limit(1);
  const existing = existingRows[0];
  const existingPayload = existing?.payload;
  if (
    !existing ||
    existing.caseId !== input.caseId ||
    existing.memberId !== input.memberId ||
    normalizeAdmissionsEmail(existing.recipientEmail) !== recipientEmail ||
    existing.category !== "direct_message" ||
    existingPayload.senderName !== payload.senderName ||
    existingPayload.subject !== payload.subject ||
    existingPayload.body !== payload.body
  ) {
    throw new Error("Conflict");
  }
  return { id: existing.id, inserted: false };
}

function parseMemberInvitePayload(payload: Record<string, unknown>): MemberInviteOutboxPayload {
  const studentFirstName = payload.studentFirstName;
  if (typeof studentFirstName !== "string" || !studentFirstName.trim()) {
    throw new Error("Invalid member-invite outbox payload");
  }
  return { studentFirstName: studentFirstName.trim() };
}

function parseDirectMessagePayload(payload: Record<string, unknown>): DirectMessageOutboxPayload {
  const senderName = payload.senderName;
  const subject = payload.subject;
  const body = payload.body;
  if (
    typeof senderName !== "string" || !senderName.trim() || senderName.trim().length > 300 ||
    typeof subject !== "string" || !subject.trim() || subject.trim().length > 300 ||
    typeof body !== "string" || !body.trim() || body.trim().length > 20_000
  ) {
    throw new Error("Invalid direct-message outbox payload");
  }
  return {
    senderName: senderName.trim(),
    subject: subject.trim(),
    body: body.trim(),
  };
}

function outboxRetryAt(now: Date, attemptCount: number): Date {
  const index = Math.min(
    Math.max(attemptCount - 1, 0),
    OUTBOX_RETRY_BACKOFF_MS.length - 1,
  );
  return new Date(now.getTime() + OUTBOX_RETRY_BACKOFF_MS[index]);
}

/**
 * Claims and delivers due outbox rows. The outbox dedupe key is also used by
 * the notification log, so retrying after a partial success never re-sends.
 */
export async function processAdmissionsNotificationOutbox(
  options: { ids?: readonly string[]; limit?: number; now?: Date } = {},
  db: Database = getDb(),
): Promise<AdmissionsOutboxDeliveryResult> {
  const now = options.now ?? new Date();
  const ids = options.ids?.filter(isUuidShaped) ?? [];
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  if (options.ids && ids.length === 0) {
    return { attempted: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  }

  const rows = await db
    .select()
    .from(admissionsNotificationOutbox)
    .where(and(
      inArray(admissionsNotificationOutbox.status, ["pending", "failed", "processing"]),
      lte(admissionsNotificationOutbox.nextAttemptAt, now),
      ...(options.ids ? [inArray(admissionsNotificationOutbox.id, ids)] : []),
    ))
    .limit(limit);

  const result: AdmissionsOutboxDeliveryResult = {
    attempted: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const row of rows) {
    const attemptCount = row.attemptCount + 1;
    const claimed = await db
      .update(admissionsNotificationOutbox)
      .set({
        status: "processing",
        attemptCount,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + OUTBOX_PROCESSING_LEASE_MS),
        lastError: null,
        updatedAt: now,
      })
      .where(and(
        eq(admissionsNotificationOutbox.id, row.id),
        inArray(admissionsNotificationOutbox.status, ["pending", "failed", "processing"]),
        lte(admissionsNotificationOutbox.nextAttemptAt, now),
      ))
      .returning({ id: admissionsNotificationOutbox.id });
    if (claimed.length === 0) continue;
    result.attempted += 1;

    try {
      if (!row.memberId || !row.caseId || !["invite", "direct_message"].includes(row.category)) {
        throw new Error(`Unsupported notification outbox category: ${row.category}`);
      }
      const members = await db
        .select({
          id: admissionsCaseMembers.id,
          caseId: admissionsCaseMembers.caseId,
          email: admissionsCaseMembers.email,
          role: admissionsCaseMembers.role,
          status: admissionsCaseMembers.status,
          familyPortalOpen: admissionsCases.familyPortalOpen,
          caseStatus: admissionsCases.status,
        })
        .from(admissionsCaseMembers)
        .innerJoin(admissionsCases, eq(admissionsCaseMembers.caseId, admissionsCases.id))
        .where(and(
          eq(admissionsCaseMembers.id, row.memberId),
          eq(admissionsCaseMembers.caseId, row.caseId),
          isNull(admissionsCases.deletedAt),
          or(
            ne(admissionsCaseMembers.role, "counselor"),
            sql<boolean>`EXISTS (
              SELECT 1 FROM ${admissionsCounselors}
              WHERE ${admissionsCounselors.email} = ${admissionsCaseMembers.email}
                AND ${admissionsCounselors.active} = true
            )`,
          ),
        ))
        .limit(1);
      const member = members[0];

      const emailMatches = member &&
        normalizeAdmissionsEmail(member.email) === normalizeAdmissionsEmail(row.recipientEmail);
      const inviteIsDeliverable = row.category === "invite" && member && emailMatches &&
        (member.status === "invited" || member.status === "bounced") &&
        member.familyPortalOpen === true &&
        ["active", "committed", "completed"].includes(member.caseStatus);
      const directMessageIsDeliverable = row.category === "direct_message" && member && emailMatches &&
        member.status === "active" &&
        ["active", "committed"].includes(member.caseStatus) &&
        (member.role === "counselor" || member.familyPortalOpen === true);

      // A membership/status/email/portal change can make a queued delivery
      // obsolete. Mark it terminal so retries never leak stale case content.
      if (!inviteIsDeliverable && !directMessageIsDeliverable) {
        await db
          .update(admissionsNotificationOutbox)
          .set({ status: "sent", sentAt: now, lastError: null, updatedAt: now })
          .where(eq(admissionsNotificationOutbox.id, row.id));
        result.skipped += 1;
        continue;
      }

      const delivery = row.category === "invite"
        ? await sendMemberInvite(
          { caseId: row.caseId, email: row.recipientEmail },
          parseMemberInvitePayload(row.payload).studentFirstName,
          db,
          { dedupeKey: row.dedupeKey },
        )
        : await notifyDirectMessage({
          caseId: row.caseId,
          recipientEmail: row.recipientEmail,
          ...parseDirectMessagePayload(row.payload),
        }, db, { dedupeKey: row.dedupeKey });
      await db
        .update(admissionsNotificationOutbox)
        .set({
          status: "sent",
          sentAt: now,
          providerMessageId: delivery.resendEmailId,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(admissionsNotificationOutbox.id, row.id));
      if (delivery.skipped) result.skipped += 1;
      else result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification delivery failed";
      await db
        .update(admissionsNotificationOutbox)
        .set({
          status: "failed",
          nextAttemptAt: outboxRetryAt(now, attemptCount),
          lastError: message.slice(0, 2000),
          updatedAt: now,
        })
        .where(eq(admissionsNotificationOutbox.id, row.id));
      result.failed += 1;
      result.errors.push(`${row.id}: ${message}`);
    }
  }

  return result;
}

/** Attempts just-committed outbox rows without ever failing the business write. */
export async function deliverAdmissionsOutboxBestEffort(
  ids: readonly string[],
  db: Database = getDb(),
): Promise<AdmissionsOutboxDeliveryResult> {
  try {
    return await processAdmissionsNotificationOutbox({ ids }, db);
  } catch (error) {
    console.error("Admissions notification outbox: immediate delivery failed", error);
    return {
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: ids.length,
      errors: [error instanceof Error ? error.message : "Immediate delivery failed"],
    };
  }
}

// ── Run orchestrators (design §7 cron) ──────────────────────────────────

/**
 * Fails abandoned running rows (started >30min ago) so a crashed run can
 * never wedge the single-flight guard (copies the wise-activity sweep).
 */
async function markAbandonedNotificationRuns(db: Database, now: Date): Promise<void> {
  await db
    .update(admissionsNotificationRuns)
    .set({
      status: "failed",
      finishedAt: now,
      errorSummary: "Notification run marked failed because it was still running after 30 minutes.",
    })
    .where(and(
      eq(admissionsNotificationRuns.status, "running"),
      lte(admissionsNotificationRuns.startedAt, new Date(now.getTime() - STALE_RUNNING_NOTIFICATION_RUN_MS)),
    ));
}

/**
 * Starts a run row under the single-flight guard: sweep stale rows, then
 * insert a running row. The partial unique index
 * admissions_notification_runs_single_running_idx rejects the insert while a
 * fresh running row exists — that unique violation means "skip", not "fail".
 *
 * @returns the run id, or null when another run is already in flight.
 */
async function startNotificationRun(
  runType: "daily" | "weekly",
  now: Date,
  db: Database,
): Promise<string | null> {
  await markAbandonedNotificationRuns(db, now);
  try {
    const rows = await db
      .insert(admissionsNotificationRuns)
      .values({ status: "running", runType, startedAt: now })
      .returning({ id: admissionsNotificationRuns.id });
    return rows[0]?.id ?? null;
  } catch (error) {
    if (isUniqueViolation(error, "admissions_notification_runs_single_running_idx")) {
      return null;
    }
    throw error;
  }
}

async function finishNotificationRun(
  db: Database,
  runId: string,
  outcome: {
    status: "success" | "failed";
    sentCount: number;
    skippedCount: number;
    errorSummary: string | null;
  },
): Promise<void> {
  await db
    .update(admissionsNotificationRuns)
    .set({
      status: outcome.status,
      finishedAt: new Date(),
      sentCount: outcome.sentCount,
      skippedCount: outcome.skippedCount,
      errorSummary: outcome.errorSummary,
    })
    .where(eq(admissionsNotificationRuns.id, runId));
}

function skippedRunResult(runType: "daily" | "weekly"): AdmissionsNotificationRunResult {
  return {
    skipped: true,
    runId: null,
    runType,
    sentCount: 0,
    skippedCount: 0,
    errorSummary: null,
  };
}

/**
 * Daily notification pass (cron orchestrator): T-7d/T-48h deadline reminders
 * with the CM-111 cap, recorded in admissions_notification_runs.
 *
 * 1. Single-flight: sweep stale running rows, insert a running row; a fresh
 *    running row (<30min) already in flight → return `{ skipped: true }`.
 * 2. Retry the transactional outbox, then plan reminders
 *    (buildDeadlineReminders) and deliver per recipient, applying the daily
 *    interrupt cap/collapse. Per-recipient failures are isolated
 *    (console.error + errorSummary), never abort the run — matching the sync
 *    orchestrator's fail-isolated discipline.
 * 3. Finalize the run row with sent/skipped counts. Only a top-level crash
 *    marks the run failed (and rethrows).
 *
 * @returns the run outcome with counts.
 */
export async function runDailyNotifications(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<AdmissionsNotificationRunResult> {
  const runId = await startNotificationRun("daily", now, db);
  if (runId === null) return skippedRunResult("daily");

  let sentCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];
  try {
    const outbox = await processAdmissionsNotificationOutbox({ now }, db);
    sentCount += outbox.sent;
    skippedCount += outbox.skipped;
    errors.push(...outbox.errors);

    const reminders = await buildDeadlineReminders(now, db);
    for (const recipient of reminders) {
      try {
        const outcome = await deliverDeadlineReminders(recipient, now, db);
        sentCount += outcome.sent;
        skippedCount += outcome.skipped;
      } catch (error) {
        console.error("Admissions daily notifications: recipient delivery failed", error);
        errors.push(`${recipient.recipientEmail}: ${error instanceof Error ? error.message : "delivery failed"}`);
      }
    }
    const errorSummary = errors.length > 0 ? errors.join("; ").slice(0, 2000) : null;
    await finishNotificationRun(db, runId, {
      status: "success",
      sentCount,
      skippedCount,
      errorSummary,
    });
    return { skipped: false, runId, runType: "daily", sentCount, skippedCount, errorSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daily notification run failed";
    await finishNotificationRun(db, runId, {
      status: "failed",
      sentCount,
      skippedCount,
      errorSummary: message,
    }).catch((finishError) => console.error("Admissions daily notifications: failed to finalize run", finishError));
    throw error;
  }
}

/**
 * Weekly digest pass (cron orchestrator, Sunday 18:00 Asia/Bangkok slot):
 * one batch-tier digest email per case member with fresh content.
 *
 * 1. Single-flight guard identical to runDailyNotifications.
 * 2. For every live (active/committed) case, assemble buildWeeklyDigest and
 *    send each recipient's digest (dedupe key
 *    "digest:{caseId}:{recipient}:{today}" makes same-day re-runs
 *    idempotent). Per-case failures are isolated, never abort the run.
 * 3. Finalize the run row with counts; a top-level crash marks it failed.
 *
 * @returns the run outcome with counts.
 */
export async function runWeeklyDigest(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<AdmissionsNotificationRunResult> {
  const runId = await startNotificationRun("weekly", now, db);
  if (runId === null) return skippedRunResult("weekly");

  let sentCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];
  const todayKey = getBangkokDateKey(now);
  try {
    const caseRows = await db
      .select({ id: admissionsCases.id })
      .from(admissionsCases)
      .where(and(
        inArray(admissionsCases.status, ["active", "committed"]),
        isNull(admissionsCases.deletedAt),
      ));

    for (const caseRow of caseRows) {
      try {
        const digest = await buildWeeklyDigest(caseRow.id, now, db);
        for (const recipient of digest.recipients) {
          const result = await sendAdmissionsEmail({
            to: recipient.recipientEmail,
            subject: `Weekly admissions update — ${digest.studentFirstName}`,
            html: renderWeeklyDigestHtml(recipient, digest.studentFirstName),
            category: "digest",
            tier: "batch",
            caseId: digest.caseId,
            dedupeKey: `digest:${digest.caseId}:${recipient.recipientEmail}:${todayKey}`,
          }, db);
          if (result.skipped) skippedCount += 1;
          else sentCount += 1;
        }
      } catch (error) {
        console.error("Admissions weekly digest: case delivery failed", error);
        errors.push(`${caseRow.id}: ${error instanceof Error ? error.message : "delivery failed"}`);
      }
    }
    const errorSummary = errors.length > 0 ? errors.join("; ").slice(0, 2000) : null;
    await finishNotificationRun(db, runId, {
      status: "success",
      sentCount,
      skippedCount,
      errorSummary,
    });
    return { skipped: false, runId, runType: "weekly", sentCount, skippedCount, errorSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Weekly digest run failed";
    await finishNotificationRun(db, runId, {
      status: "failed",
      sentCount,
      skippedCount,
      errorSummary: message,
    }).catch((finishError) => console.error("Admissions weekly digest: failed to finalize run", finishError));
    throw error;
  }
}
