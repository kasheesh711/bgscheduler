import { formatInTimeZone } from "date-fns-tz";
import { ZONE } from "./model";

export type PreScreenState = "Not sent" | "Queued" | "Sent" | "Reminded" | "Replied" | "No reply" | "Earlier contact";
export type PreScreenResult = {
  status: PreScreenState;
  sentAt: Date | null;
  remindedAt: Date | null;
  repliedAt: string | null;
};
type OutboxRow = {
  key: string;
  status: string;
  sentAt: Date | string | null;
  workflowStage?: string | null;
};

const asDate = (value: Date | string | null | undefined) => (value ? new Date(value) : null);

/** One pre-screen status per candidate, from the stage, the response and this candidate's outbox rows. */
export function preScreenStatus(
  candidate: {
    id: string;
    // A string compare, because the no_reply stage is not in the Stage type yet.
    stage: string;
    previouslyContacted: boolean;
    preScreen: { submittedAt: string } | null;
  },
  outbox: OutboxRow[],
  ready: boolean,
): PreScreenResult {
  const row = (suffix: string) => outbox.find((j) => j.key === `${candidate.id}:${suffix}`);
  const first = row("pre-screen");
  const reminder = row("pre-screen-reminder");
  const sentAt = first?.status === "sent" ? asDate(first.sentAt) : null;
  const remindedAt = reminder?.status === "sent" ? asDate(reminder.sentAt) : null;
  const repliedAt = candidate.preScreen?.submittedAt ?? null;
  // A failed or uncertain send may still have reached the candidate, so it stays Queued.
  // The worker cancels a row whose stage no longer matches the candidate's.
  const queued =
    ready ||
    (!!first &&
      ["pending", "processing", "failed", "uncertain"].includes(first.status) &&
      first.workflowStage === candidate.stage);
  const status: PreScreenState = candidate.preScreen
    ? "Replied"
    : candidate.stage === "no_reply"
      ? "No reply"
      : remindedAt
        ? "Reminded"
        : sentAt
          ? "Sent"
          : queued
            ? "Queued"
            : candidate.previouslyContacted
              ? "Earlier contact"
              : "Not sent";
  return { status, sentAt, remindedAt, repliedAt };
}

/** The tracker writes `d/m/yyyy, H:mm:ss` in GMT. Anything else returns null. */
export function parseFormTimestamp(value: string) {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [day, month, year, hour, minute, second] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  // Date.UTC rolls 31/02 over to March, so a round trip rejects it.
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? date : null;
}

const when = (date: Date, time: boolean) => formatInTimeZone(date, ZONE, time ? "d MMM, HH:mm" : "d MMM");

/** The dates under a status pill, in Bangkok time. */
export function preScreenNote(r: PreScreenResult, time = false) {
  const replied = r.repliedAt ? parseFormTimestamp(r.repliedAt) : null;
  const parts = [
    r.sentAt && `sent ${when(r.sentAt, time)}`,
    r.remindedAt && `reminded ${when(r.remindedAt, time)}`,
    replied && `replied ${when(replied, time)}`,
  ].filter(Boolean) as string[];
  if (!parts.length) return r.status === "Replied" ? "Replied" : "";
  const text = parts.join(" · ");
  return text[0].toUpperCase() + text.slice(1);
}

export type CandidateExtras = {
  pre: PreScreenResult;
  /** The latest confirmed booking, or null. */
  visit: { kind: "paper" | "mock"; startTime: Date | string } | null;
};

/** The pre-screen status and visit of every candidate, by candidate id. */
export function candidateExtras(
  candidates: (Parameters<typeof preScreenStatus>[0])[],
  outbox: (OutboxRow & { candidateId: string })[],
  bookings: { candidateId: string; kind: "paper" | "mock"; status: string; startTime: Date | string }[],
  ready: Set<string>,
) {
  const confirmed = bookings
    .filter((b) => b.status === "confirmed")
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const jobs = new Map<string, typeof outbox>();
  for (const j of outbox) jobs.set(j.candidateId, [...(jobs.get(j.candidateId) ?? []), j]);
  return new Map(
    candidates.map((c): [string, CandidateExtras] => [
      c.id,
      {
        pre: preScreenStatus(c, jobs.get(c.id) ?? [], ready.has(c.id)),
        visit: confirmed.find((b) => b.candidateId === c.id) ?? null,
      },
    ]),
  );
}

export const visitText = (visit: NonNullable<CandidateExtras["visit"]>) =>
  `${visit.kind === "paper" ? "Paper" : "Mock"} · ${when(new Date(visit.startTime), true)}`;
