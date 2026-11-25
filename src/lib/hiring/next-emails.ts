import { bangkokDayStart, bangkokWeekStart, type LimitName, type QueueHold } from "./limits";
import type { HiringConfig, Stage } from "./model";

/**
 * Who gets which email next, and about when, from data the dashboard already has (Kevin, 25 Nov 2026).
 * - Queue rows: `holds` from the worker's own release function. Next = the next worker run. A daily or weekly limit
 *   ends at the Bangkok day or week start. A subject, waiting or not-booked limit has no date: it waits for a place.
 * - Written rows: an outbox row not yet delivered is "sending"; a failed or uncertain one is "retry".
 * - Reminders: the first send plus `remindDays`, the same clock and the same conditions as `runFollowUps`.
 * Times are estimates: the worker must be on, and a person can change the stage first.
 */
export type EmailKind = "form" | "form_reminder" | "visit_link" | "visit_reminder" | "call_link" | "call_reminder";
/** sending = written, not yet delivered; retry = failed, the worker tries again; check = uncertain, a person must look. */
export type WaitReason = "next_run" | "sending" | "retry" | "check" | "due" | LimitName;
export type NextEmail = {
  id: string;
  name: string;
  kind: EmailKind;
  subject: string | null;
  /** About when it goes. Null when it waits for a place to open. */
  at: Date | null;
  why: WaitReason;
  /** Queue place for a held row, 0 otherwise. */
  position: number;
  /** A reminder past its due time: it goes on the next run. */
  overdue?: boolean;
};

type Row = { key: string; status: string; sentAt: Date | string | null; workflowStage?: string | null };
const DAY = 86_400_000;
// Same time: what is already written first, then the queue, then reminders.
const ORDER: WaitReason[] = ["sending", "next_run", "due", "perDay", "perWeek", "retry", "check", "perSubject", "waiting", "unbooked"];

export function buildNextEmails(
  input: {
    candidates: { id: string; name: string; email?: string | null; previouslyContacted?: boolean; stage: Stage; preScreen: unknown; subjects?: string[] | null; visitSubject?: string | null; inviteExpiresAt?: Date | string | null }[];
    holds: Record<string, QueueHold>;
    /** The worker's pre-screen order, so rows due on the same run keep the queue's rank. */
    preScreenOrder?: string[];
    outbox: Row[];
    inviteOutbox: Row[];
    config: Pick<HiringConfig, "preScreenFollowUp" | "onsiteFollowUp">;
  },
  now: Date,
  /** When the worker runs next (its last run + its 15-minute sleep). Defaults to now. */
  nextRun: Date = now,
): NextEmail[] {
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  const keys = new Map(input.outbox.map((r) => [r.key, r.status]));
  const rank = new Map((input.preScreenOrder ?? []).map((id, i) => [id, i + 1]));
  const out: NextEmail[] = [];
  const subjectOf = (c: { visitSubject?: string | null; subjects?: string[] | null }) => c.visitSubject ?? c.subjects?.[0] ?? null;

  for (const [id, hold] of Object.entries(input.holds)) {
    const c = byId.get(id);
    // The worker skips a closed record; so does the list.
    if (!c || ["stopped", "rejected", "hired"].includes(c.stage)) continue;
    const at =
      hold.state === "next" ? nextRun
      : hold.limit === "perDay" ? new Date(bangkokDayStart(now).getTime() + DAY)
      : hold.limit === "perWeek" ? new Date(bangkokWeekStart(now).getTime() + 7 * DAY)
      : null;
    out.push({
      id,
      name: c.name,
      kind: hold.funnel === "pre_screen" ? "form" : "visit_link",
      subject: hold.subject,
      at,
      why: hold.state === "next" ? "next_run" : hold.limit ?? "waiting",
      position: hold.state === "next" ? (rank.get(id) ?? 0) : hold.position,
    });
  }

  // Rows already written for a first send: they go (or need a look) before any queue row.
  const KIND_OF: [string, EmailKind][] = [[":pre-screen", "form"], [":visit-invite", "visit_link"], [":call-invite", "call_link"]];
  const queued = new Set(out.map((r) => `${r.id}:${r.kind}`));
  // The outbox (newest first) carries workflowStage: the worker cancels a row whose stage no longer matches.
  for (const row of input.outbox) {
    const kind: EmailKind | undefined = /:pre-screen-reminder$/.test(row.key)
      ? "form_reminder"
      : /:visit-reminder:/.test(row.key)
        ? "visit_reminder"
        : /:call-invite-reminder$/.test(row.key)
          ? "call_reminder"
          : KIND_OF.find(([k]) => row.key.endsWith(k) || (k === ":visit-invite" && row.key.includes(":visit-invite:")))?.[1];
    const why = ["pending", "processing"].includes(row.status) ? "sending" : row.status === "failed" ? "retry" : row.status === "uncertain" ? "check" : null;
    const id = row.key.split(":")[0];
    const c = byId.get(id);
    if (!kind || !why || !c || queued.has(`${id}:${kind}`) || (row.workflowStage && row.workflowStage !== c.stage)) continue;
    queued.add(`${id}:${kind}`);
    // A failed row waits for its retry time, which the dashboard does not read: no date.
    out.push({ id, name: c.name, kind, subject: subjectOf(c), at: why === "sending" ? nextRun : null, why, position: 0 });
  }

  // inviteOutbox is newest first; a cancelled row is not the current link.
  const sent = (prefix: string) => {
    const row = input.inviteOutbox.find((r) => r.key.startsWith(prefix) && r.status !== "cancelled");
    return row?.status === "sent" && row.sentAt ? new Date(row.sentAt) : null;
  };
  for (const c of input.candidates) {
    // No address, nothing goes. A SEEK contact cancels the form reminder (runFollowUps).
    if (c.email === null) continue;
    let kind: EmailKind | null = null;
    let first: Date | null = null;
    let days = 0;
    let expire = 0;
    const reminder = keys.get(`${c.id}:pre-screen-reminder`);
    if (c.stage === "pre_screen" && !c.preScreen && !reminder && !c.previouslyContacted) {
      kind = "form_reminder";
      first = sent(`${c.id}:pre-screen`);
      ({ remindDays: days, expireDays: expire } = input.config.preScreenFollowUp);
    } else if (c.stage === "onsite_invited" && c.inviteExpiresAt && new Date(c.inviteExpiresAt) > now) {
      // The worker sends a visit reminder only with a live link.
      kind = "visit_reminder";
      first = sent(`${c.id}:visit-invite`);
      ({ remindDays: days, expireDays: expire } = input.config.onsiteFollowUp);
      // A reminder for this link went out already (an older link's reminder does not count), or one is in flight.
      if (first && input.outbox.some((r) => r.key.startsWith(`${c.id}:visit-reminder:`) && (r.sentAt ? new Date(r.sentAt) >= first! : r.status !== "cancelled"))) first = null;
    }
    // Past the expiry the worker parks the candidate instead of reminding.
    if (!kind || !first || first.getTime() + expire * DAY <= now.getTime()) continue;
    const due = new Date(first.getTime() + days * DAY);
    // A visit reminder after the link dies never goes.
    if (kind === "visit_reminder" && c.inviteExpiresAt && due >= new Date(c.inviteExpiresAt)) continue;
    out.push({ id: c.id, name: c.name, kind, subject: subjectOf(c), at: due < nextRun ? nextRun : due, why: "due", position: 0, overdue: due < now });
  }

  return out.sort(
    (a, b) =>
      (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity) ||
      ORDER.indexOf(a.why) - ORDER.indexOf(b.why) ||
      a.position - b.position ||
      a.name.localeCompare(b.name),
  );
}
