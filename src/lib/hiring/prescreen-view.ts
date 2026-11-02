import { formatInTimeZone } from "date-fns-tz";
import { STAGE_LABELS } from "./insights";
import { isDecided, ZONE, type Stage } from "./model";

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
  const says = (label: string, tone: VisitEmail["tone"], error?: string | null): VisitEmail => ({ label, tone, sent, ...(error ? { error } : {}) });
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
