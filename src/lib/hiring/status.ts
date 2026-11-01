import { formatInTimeZone } from "date-fns-tz";
import { profileGate } from "./insights";
import type { LimitName, QueueHold } from "./limits";
import { ZONE, type HiringConfig, type PreScreen, type Stage } from "./model";
import { supportedVisitSubjects, topHiringSubject, visitSubject, type PreScreenAssessment } from "./scoring";

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
    stage: Stage;
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
  /** The current visit, or the latest confirmed old-flow booking, or null. */
  visit: { kind: "paper" | "mock"; startTime: Date | string; visitId?: string | null } | null;
  /** Label and value lines for the panel, from the visit's two rows. Empty for an old-flow booking. */
  visitFacts: [string, string][];
  /** In the onsite queue: the Queued filter shows it, and its pill stays Replied. */
  onsiteQueued: boolean;
};

type BookingRow = {
  candidateId: string;
  kind: "paper" | "mock";
  status: string;
  startTime: Date | string;
  endTime?: Date | string;
  visitId?: string | null;
  interviewerKey?: string | null;
  subjects?: string[];
};

function visitFacts(rows: BookingRow[]): [string, string][] {
  const exam = rows.find((b) => b.kind === "paper");
  const mock = rows.find((b) => b.kind === "mock");
  const at = (b?: BookingRow) => (b ? when(new Date(b.startTime), true) : "Not set");
  // A visit's rows always share one status.
  const { status } = rows[0];
  return [
    ["Exam", at(exam)],
    ["Mock", at(mock)],
    ["Head", mock?.interviewerKey ?? "Not set"],
    ["Subject", mock?.subjects?.[0] ?? "Not set"],
    ["Status", status === "no_show" ? "No-show" : status[0].toUpperCase() + status.slice(1)],
  ];
}

/** The pre-screen status and visit of every candidate, by candidate id. */
export function candidateExtras(
  candidates: (Parameters<typeof preScreenStatus>[0])[],
  outbox: (OutboxRow & { candidateId: string })[],
  bookings: BookingRow[],
  ready: Set<string>,
  now = new Date(),
  onsiteQueue = new Set<string>(),
) {
  // A visit shows until it ends. Old-flow bookings show as they always did.
  const confirmed = bookings
    .filter((b) => b.status === "confirmed" && (!b.visitId || new Date(b.endTime!) > now))
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const jobs = new Map<string, typeof outbox>();
  for (const j of outbox) jobs.set(j.candidateId, [...(jobs.get(j.candidateId) ?? []), j]);
  return new Map(
    candidates.map((c): [string, CandidateExtras] => {
      const latest = confirmed.find((b) => b.candidateId === c.id) ?? null;
      return [
        c.id,
        {
          pre: preScreenStatus(c, jobs.get(c.id) ?? [], ready.has(c.id)),
          // A visit reads as its exam, which starts it, until only the mock is left.
          visit: (latest?.visitId && confirmed.find((b) => b.visitId === latest.visitId && b.kind === "paper")) || latest,
          // All rows of the visit, because a finished exam leaves `confirmed` but is still part of it.
          visitFacts: latest?.visitId ? visitFacts(bookings.filter((b) => b.visitId === latest.visitId)) : [],
          onsiteQueued: onsiteQueue.has(c.id),
        },
      ];
    }),
  );
}

export const visitText = (visit: NonNullable<CandidateExtras["visit"]>) =>
  `${visit.visitId ? "Visit" : visit.kind === "paper" ? "Paper" : "Mock"} · ${when(new Date(visit.startTime), true)}`;

const LIMIT_WORDS: Record<LimitName, string> = {
  perDay: "daily limit",
  perWeek: "weekly limit",
  waiting: "waiting limit",
  unbooked: "not-booked limit",
  perSubject: "subject limit",
};
function limitText(hold: QueueHold, config: HiringConfig) {
  const limit = hold.limit!;
  const max = (hold.funnel === "pre_screen" ? config.preScreenLimits : config.onsiteLimits)[limit as "perWeek"];
  // The subject limit names its subject, so the cell tells which of the 18 is full.
  return { words: limit === "perSubject" ? `${hold.subject} limit` : LIMIT_WORDS[limit], max };
}

type HoldCandidate = Parameters<typeof profileGate>[0] & {
  stage: Stage;
  preScreen: PreScreen | null;
  preScreenAssessment: Pick<PreScreenAssessment, "subjects"> | null;
};
/**
 * Why a candidate has not been sent anything yet, from data the dashboard already has. `short` fits a table cell,
 * `long` is for the panel. A queue entry wins. Without one, a new candidate shows what the profile gate says,
 * and a scored reply shows that no pass score is set. No Wise call, no model call.
 */
export function holdNote(
  candidate: HoldCandidate,
  hold: QueueHold | undefined,
  config: HiringConfig,
): { short: string; long: string[] } | null {
  if (hold?.state === "next")
    return {
      short: "Next to send",
      long: [
        `Next to send in the ${hold.funnel === "pre_screen" ? "pre-screen" : "onsite"} queue.`,
        "It goes in the next worker cycle, if Automation and Messages are on.",
      ],
    };
  if (hold) {
    const { words, max } = limitText(hold, config);
    const prefix = hold.funnel === "pre_screen" ? "Queue" : "Onsite queue";
    return {
      short: `${prefix} ${hold.position} · ${words} ${max}`,
      long: [
        `Position ${hold.position} in the ${hold.funnel === "pre_screen" ? "pre-screen" : "onsite"} queue.`,
        `Held by the ${words} (${max}). To send more, raise the number in Rules and setup.`,
      ],
    };
  }
  if (candidate.stage === "new" && !candidate.preScreen) {
    const gate = profileGate(candidate, config);
    if (gate.eligible) return null;
    return {
      short: gate.short[0] + (gate.short.length > 1 ? ` +${gate.short.length - 1}` : ""),
      long: gate.reasons,
    };
  }
  const { preScreen: pre, preScreenAssessment: assessment, workRightsAnswer: answer } = candidate;
  if (pre && assessment && ["pre_screen", "no_reply"].includes(candidate.stage)) {
    if (config.preScreenThreshold === null)
      return {
        short: "Needs a pass score",
        long: ["No pass score is set, so no automatic onsite invitation can run. A click can still invite."],
      };
    // The queue's reply check waits here, because a setting can cure it.
    const supported = supportedVisitSubjects(pre, answer, assessment, config);
    if (supported.length && !visitSubject(pre, answer, assessment, config))
      return topHiringSubject(supported, config.subjectPriority)
        ? {
            short: "No head for this subject",
            long: [`No head covers the subject: ${supported.join(", ")}. Add a head in Rules and setup. The next cycle looks again.`],
          }
        : {
            short: "Subject not hiring",
            long: [`The subject is not open for hiring: ${supported.join(", ")}. Open it in Rules and setup. The next cycle looks again.`],
          };
  }
  return null;
}

/** The Mac worker does intake, scoring and new invitations. With automation on, an old run needs a visible warning. */
export function workerWarning(enabled: boolean, workerAt: Date | string | null, now = new Date()) {
  if (!enabled) return null;
  const tail = " Intake, scoring and new invitations wait until it runs again. Booking links still work.";
  if (!workerAt) return `Automation is on, but the worker has not run yet.${tail}`;
  const minutes = Math.floor((now.getTime() - new Date(workerAt).getTime()) / 60000);
  if (minutes <= 60) return null;
  const hours = Math.floor(minutes / 60);
  const ago = minutes < 120 ? `${minutes} minutes` : hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
  return `Automation is on, but the worker last ran ${ago} ago.${tail}`;
}
