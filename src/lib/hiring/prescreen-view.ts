import { formatInTimeZone } from "date-fns-tz";
import { STAGE_LABELS } from "./insights";
import { isDecided, ZONE, type Stage } from "./model";
import { parseFormTimestamp } from "./status";

type OutboxRow = { key: string; status: string; sentAt: Date | string | null; error?: string | null };
type Person = {
  id: string;
  stage: Stage;
  preScreen: { submittedAt: string } | null;
  preScreenAssessment: unknown;
  preScreenHash: string | null;
  preScreenScore: number | null;
  preScreenOverride: { score: number } | null;
};
export type VisitEmail = {
  label: string;
  tone: "good" | "wait" | "bad" | "none";
  /** Any invitation has left, even if a newer row is waiting or failed. */
  sent: boolean;
  /** Bangkok days (yyyy-MM-dd) each sent invitation left, for the date filter. */
  sentDays: string[];
  error?: string | null;
};

const OLD_FLOW: Stage[] = ["paper_invited", "paper_booked", "paper_passed", "mock_booked"];
const isVisitInvite = (id: string, key: string) => key === `${id}:visit-invite` || key.startsWith(`${id}:visit-invite:`);

export const preScreenFinalScore = (c: Pick<Person, "preScreenScore" | "preScreenOverride">) => c.preScreenOverride?.score ?? c.preScreenScore;

/** The pre-screen list: anyone with a form row that was not cancelled before it left, or anyone with a reply. */
export function wasSentForm(c: Pick<Person, "id" | "preScreen">, outbox: OutboxRow[]) {
  return !!c.preScreen || outbox.some((row) => row.key === `${c.id}:pre-screen` && row.status !== "cancelled");
}

/**
 * The visit email from the outbox, because the stage changes when the email is queued, not when it leaves.
 * The dashboard reads outbox rows newest first. A candidate with no row gets the reason.
 */
export function visitEmail(c: Person, outbox: OutboxRow[], threshold: number | null, hold?: string): VisitEmail {
  const rows = outbox.filter((r) => isVisitInvite(c.id, r.key));
  const sent = rows.some((r) => r.status === "sent");
  const sentDays = rows.flatMap((r) => (r.status === "sent" && r.sentAt ? [formatInTimeZone(new Date(r.sentAt), ZONE, "yyyy-MM-dd")] : []));
  const says = (label: string, tone: VisitEmail["tone"], error?: string | null): VisitEmail => ({ label, tone, sent, sentDays, ...(error ? { error } : {}) });
  // A cancelled new link does not undo an email that already left.
  const row = rows.find((r) => r.status !== "cancelled") ?? rows[0];
  if (row) {
    if (row.status === "sent") return says(row.sentAt ? `Sent ${formatInTimeZone(new Date(row.sentAt), ZONE, "d MMM, HH:mm")}` : "Sent", "good");
    if (row.status === "pending" || row.status === "processing") return says("Queued", "wait");
    if (row.status === "failed") return says("Failed, will retry", "bad", row.error);
    if (row.status === "uncertain") return says("May have sent. Check first", "bad", row.error);
    if (row.status === "cancelled") return says("Cancelled", "none");
  }
  if (isDecided(c.stage)) return says(STAGE_LABELS[c.stage], "none");
  if (OLD_FLOW.includes(c.stage)) return says(`Old flow: ${STAGE_LABELS[c.stage]}`, "none");
  if (c.stage === "stopped") return says("Not sent: stopped", "none");
  if (!c.preScreen) return says(c.stage === "no_reply" ? "Not sent: no reply" : "Waiting for reply", "none");
  // A hash with no assessment means the evidence failed its check, and it stays that way until a person retries it.
  if (!c.preScreenAssessment) return c.preScreenHash ? says("Could not score", "bad") : says("Not scored yet", "wait");
  if (c.preScreenOverride) return says("A person decides", "wait");
  if (threshold === null) return says("No pass score set", "none");
  const score = preScreenFinalScore(c);
  if (score !== null && score < threshold) return says("Not sent: below pass score", "none");
  return says(hold ?? "Not sent", "wait");
}

type QueueEntry = {
  candidate: Person & { preScreenRepliedAt?: Date | string | null };
  outbox: OutboxRow[];
  booked: boolean;
};
type QueueGroup = "decision" | "waiting" | "invited" | "aside" | "held" | "closed";
const BOOKED_STAGES: Stage[] = ["onsite_booked", "paper_booked", "paper_passed", "mock_booked"];
const PENDING_EMAIL = ["pending", "processing", "failed", "uncertain"];
const daysSince = (now: Date, at: number) => Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));

export function preScreenQueue<T extends QueueEntry>(
  pool: T[],
  now: Date,
  threshold: number | null,
  holds: Readonly<Record<string, { state: "next" | "held" }>>,
) {
  const rows = pool.flatMap((entry) => {
    const { candidate, outbox } = entry;
    const { id, stage } = candidate;
    const form = outbox.find((row) => row.key === `${id}:pre-screen`);
    const visitRows = outbox.filter((row) => isVisitInvite(id, row.key));
    const replied = !!(candidate.preScreen || candidate.preScreenRepliedAt);
    const booked = entry.booked || BOOKED_STAGES.includes(stage);
    if (!replied && !booked && !wasSentForm(candidate, outbox) && !visitRows.some((row) => row.status !== "cancelled")
      && !(stage === "stopped" && (form || visitRows.length))) return [];

    const sentAt = form?.status === "sent" && form.sentAt ? new Date(form.sentAt).getTime() : NaN;
    const days = Number.isFinite(sentAt) ? daysSince(now, sentAt) : null;
    const received = candidate.preScreenRepliedAt ? new Date(candidate.preScreenRepliedAt).getTime() : NaN;
    const submittedAt = parseFormTimestamp(candidate.preScreen?.submittedAt ?? "")?.getTime() ?? NaN;
    const replyAt = Number.isFinite(received) ? received : Number.isFinite(submittedAt) ? submittedAt : Infinity;
    const replyDays = Number.isFinite(replyAt) ? daysSince(now, replyAt) : null;
    const pendingVisitEmail = visitRows.some((row) => PENDING_EMAIL.includes(row.status));
    const email = visitEmail(candidate, outbox, threshold);
    const failed = [visitRows.find((row) => row.status !== "cancelled"), form]
      .find((row) => row?.status === "failed" || row?.status === "uncertain");
    const score = preScreenFinalScore(candidate);
    const below = threshold !== null && score !== null && score < threshold;
    let group: QueueGroup | null = null;
    let fact = "Form queued";
    if (stage === "stopped" || isDecided(stage)) {
      group = "closed";
      fact = STAGE_LABELS[stage];
    } else if (stage === "soft_rejected") {
      group = "aside";
      fact = "Below pass score";
    } else if (booked || pendingVisitEmail || email.sent || stage === "onsite_invited" || stage === "paper_invited" || stage === "no_booking") {
      group = "invited";
      fact = stage === "no_booking" ? "No booking" : booked ? "Visit booked" : email.label === "Queued" ? "Invite queued" : "Invited";
    } else if (holds[id]?.state === "held") {
      group = "held";
      fact = "Capacity hold";
    } else if (replied) {
      group = "decision";
      fact = below ? "Below pass score"
        : replyDays === null ? "Reply received"
          : replyDays === 0 ? "Replied today" : `Replied ${replyDays} ${replyDays === 1 ? "day" : "days"} ago`;
    } else if (form?.status === "sent") {
      group = "waiting";
      fact = days === null ? "Waiting for reply" : `Awaiting reply · ${days} ${days === 1 ? "day" : "days"}`;
    }
    if (failed && group !== "closed") fact = failed.status === "uncertain" ? "Check email delivery" : "Email failed";
    return [{ ...entry, form, group, fact, score, below, overdue: days !== null && days >= 3,
      days, replyAt, replyDays, email, emailLogKey: failed?.key, pendingVisitEmail,
      canInviteAfterStop: visitRows.every((row) => row.status === "cancelled") }];
  });
  const decision = rows.filter((row) => row.group === "decision")
    .sort((a, b) => (a.replyAt === b.replyAt ? 0 : a.replyAt - b.replyAt) || a.candidate.id.localeCompare(b.candidate.id));
  const waiting = rows.filter((row) => row.group === "waiting").sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  const aside = rows.filter((row) => row.group === "aside");
  const invited = rows.filter((row) => row.group === "invited");
  const held = rows.filter((row) => row.group === "held");
  const closed = rows.filter((row) => row.group === "closed");
  return { decision, waiting, aside, invited, held, closed, all: [...decision, ...waiting, ...aside, ...invited, ...held, ...closed, ...rows.filter((row) => !row.group)] };
}

export const PRE_SCREEN_FILTERS = ["All", "Replied", "No reply", "Passed", "Below pass score", "Visit email sent"] as const;
export type PreScreenListFilter = (typeof PRE_SCREEN_FILTERS)[number];

export function matchesPreScreenList(c: Person, filter: PreScreenListFilter, threshold: number | null, email: VisitEmail) {
  const score = preScreenFinalScore(c);
  switch (filter) {
    case "All":
      return true;
    case "Replied":
      return !!c.preScreen;
    case "No reply":
      return !c.preScreen;
    case "Passed":
      return threshold !== null && score !== null && score >= threshold;
    case "Below pass score":
      return threshold !== null && score !== null && score < threshold;
    case "Visit email sent":
      return email.sent;
  }
}

/** Any invitation sent in the date range counts. Empty ends are open. */
export function sentBetween(email: Pick<VisitEmail, "sentDays">, from: string, to: string) {
  if (!from && !to) return true;
  return email.sentDays.some((day) => (!from || day >= from) && (!to || day <= to));
}
