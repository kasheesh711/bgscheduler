/**
 * The pipeline board: every candidate in process from the HR call onward, one column for each step.
 * Built from the /api/hiring payload only. Pure: no reads, no writes.
 */
import { formatInTimeZone } from "date-fns-tz";
import { buildFunnel, percentile, roundTo, STUCK_RULES, type FunnelInput } from "./funnel";
import { ZONE } from "./model";
import { openHeadDecisions, type HeadDecisionRow } from "./role-views";

export type PipelineBoardInput = Omit<FunnelInput, "candidates" | "bookings"> & {
  candidates: (FunnelInput["candidates"][number] & { name: string; subjects: string[]; visitSubject: string | null })[];
  bookings: (FunnelInput["bookings"][number] & { interviewerKey: string | null })[];
  /** Head decisions, newest first. */
  headDecisions: HeadDecisionRow[];
};

export const PIPELINE_COLUMNS = [
  { key: "call", label: "HR call booked", owner: "Kevin" },
  { key: "form", label: "Form and visit link", owner: "Candidate" },
  { key: "visit", label: "Visit booked", owner: "Candidate" },
  { key: "marking", label: "Marking and mock scores", owner: "Head" },
  { key: "review", label: "Final review", owner: "Kevin, then Gift" },
  { key: "offer", label: "Offer and signing", owner: "Kevin" },
] as const;
export type PipelineColumnKey = (typeof PIPELINE_COLUMNS)[number]["key"];
export type PipelineCard = {
  id: string;
  name: string;
  subject: string;
  /** Whole days in the column. */
  days: number;
  stuck: boolean;
  note: string;
  /** Who does the next action. */
  owner: string;
};
export type PipelineColumn = {
  key: PipelineColumnKey;
  label: string;
  owner: string;
  count: number;
  stuck: number;
  /** `null` for an empty column. */
  medianDays: number | null;
  /** Stuck cards first, then the longest wait first. */
  cards: PipelineCard[];
};
export type PipelineBoard = { columns: PipelineColumn[]; bottleneck: PipelineColumnKey | null };

export const NEEDS_REVIEW = "Needs review";
const DAY = 86_400_000;
const CLOSED = ["rejected", "stopped", "no_reply", "no_booking"];
/** Stages that say a visit is booked or done. `paper_passed` has no visit ahead in the old flow. */
const VISIT_STAGES = ["onsite_booked", "paper_booked", "mock_booked", "paper_passed"];
const stuckAfter = (key: string) => STUCK_RULES.find((rule) => rule.key === key)?.days ?? null;
const dayTime = (at: Date | string) => formatInTimeZone(new Date(at), ZONE, "d MMM HH:mm");
const dayOnly = (at: Date | string) => formatInTimeZone(new Date(at), ZONE, "d MMM");

/**
 * Puts each candidate in process in one column, from the HR call onward. Closed and parked candidates, and candidates
 * before the HR call, are not on the board. A candidate whose step the data cannot tell goes in the column the stage
 * implies, with the note "Needs review".
 *
 * Bottleneck: the column with the most stuck cards (tie: the larger median days). When no card is stuck: a column that
 * holds at least 3 more cards than every other column, else `null`. The offer column is not in that count, because
 * the payload has no mark for a finished signing.
 */
export function buildPipelineBoard(data: PipelineBoardInput, now: Date): PipelineBoard {
  const nowMs = now.getTime();
  const funnel = buildFunnel(data, now).byCandidate;
  const daysSince = (at: Date | string) => Math.max(0, (nowMs - new Date(at).getTime()) / DAY);
  const heads = new Map(openHeadDecisions(data.headDecisions, data.decisions).map((d) => [d.candidateId!, d]));
  const callAt = new Map<string, number>();
  for (const call of data.calls) {
    if (!call.start) continue;
    callAt.set(call.candidateId, Math.max(callAt.get(call.candidateId) ?? 0, new Date(call.start).getTime()));
  }
  const visits = new Map<string, PipelineBoardInput["bookings"]>();
  for (const b of data.bookings) {
    if (b.status !== "confirmed" || !b.startTime || (b.kind !== "paper" && b.kind !== "mock")) continue;
    visits.set(b.candidateId, [...(visits.get(b.candidateId) ?? []), b]);
  }

  const cards = new Map<PipelineColumnKey, (PipelineCard & { exact: number })[]>(PIPELINE_COLUMNS.map((c) => [c.key, []]));
  for (const c of data.candidates) {
    const { id, stage } = c;
    if (CLOSED.includes(stage)) continue;
    const f = funnel[id];
    const good = c.callReview?.good ?? null;
    const head = heads.get(id);
    const mine = visits.get(id) ?? [];
    let place: { column: PipelineColumnKey; exact: number; stuck: boolean; note: string; owner: string } | null = null;
    const after = (exact: number, days: number | null) => days !== null && exact > days;

    if (stage === "hired") {
      const offer = data.decisions.find((d) => d.candidateId === id && d.decision === "hire" && d.status === "sent");
      // "hired" has no stuck rule, so an offer is never stuck.
      place = offer?.sentAt
        ? { column: "offer", exact: daysSince(offer.sentAt), stuck: false, note: `Offer sent ${dayOnly(offer.sentAt)}`, owner: "Kevin" }
        : { column: "offer", exact: f.daysInStage, stuck: false, note: NEEDS_REVIEW, owner: "Kevin" };
    } else if (head) {
      const yes = head.decision === "hire";
      const exact = daysSince(head.at);
      place = {
        column: "review",
        exact,
        // The same limit as a visit with no result: the decision is due.
        stuck: after(exact, stuckAfter("onsite_booked")),
        note: `${head.head || "Head"} said ${yes ? "Yes" : "No"}`,
        owner: yes ? "Kevin, then Gift" : "Kevin",
      };
    } else if (VISIT_STAGES.includes(stage)) {
      const ahead = mine.filter((b) => new Date(b.startTime!).getTime() > nowMs).sort((a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime());
      const headKey = (ahead.find((b) => b.kind === "mock") ?? mine.find((b) => b.kind === "mock"))?.interviewerKey ?? null;
      if (ahead.length)
        place = { column: "visit", exact: f.daysInStage, stuck: false, note: `Visit ${dayTime(ahead[0].startTime!)}${headKey ? ` · ${headKey}` : ""}`, owner: "Candidate" };
      else if (mine.length) {
        const last = Math.max(...mine.map((b) => new Date(b.startTime!).getTime()));
        place = { column: "marking", exact: f.daysInStage, stuck: f.stuck, note: `Visited ${dayOnly(new Date(last))}. No head decision.`, owner: headKey ?? "Head" };
      } else
        place = { column: stage === "paper_passed" ? "marking" : "visit", exact: f.daysInStage, stuck: f.stuck, note: NEEDS_REVIEW, owner: "Kevin" };
    } else if (stage === "onsite_invited" || stage === "paper_invited") {
      place = { column: "form", exact: f.daysInStage, stuck: f.stuck, note: "Waits for a visit booking", owner: "Candidate" };
    } else if (stage === "pre_screen") {
      // With or without a call: a score below the call score gets the form with no HR call.
      place = c.preScreenRepliedAt
        ? { column: "form", exact: f.daysInStage, stuck: f.stuck, note: "Form is in. Waits for a visit place.", owner: "Kevin" }
        : { column: "form", exact: f.daysInStage, stuck: f.stuck, note: "Waits for the form", owner: "Candidate" };
    } else if (good) {
      // The funnel clock for these stages starts at the application, so this column counts from the good call.
      const exact = daysSince(good.at);
      place = {
        column: "form",
        exact,
        stuck: after(exact, stuckAfter("pre_screen")),
        note: stage === "new" ? "Next steps email not sent yet" : NEEDS_REVIEW,
        owner: "Kevin",
      };
    } else if (f.stageKey === "new (call booked)") {
      const at = callAt.get(id)!;
      place = {
        column: "call",
        exact: f.daysInStage,
        stuck: f.stuck,
        note: at <= nowMs ? `Call was ${dayTime(new Date(at))}. Result not recorded.` : `Call ${dayTime(new Date(at))}`,
        owner: "Kevin",
      };
    }
    if (!place) continue;
    const { column, ...card } = place;
    cards.get(column)!.push({ id, name: c.name, subject: c.visitSubject ?? c.subjects[0] ?? "", days: Math.floor(card.exact), ...card });
  }

  const columns = PIPELINE_COLUMNS.map((column): PipelineColumn => {
    const list = cards.get(column.key)!.sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.exact - a.exact);
    return {
      ...column,
      count: list.length,
      stuck: list.filter((card) => card.stuck).length,
      medianDays: list.length ? roundTo(percentile(list.map((card) => card.days), 0.5), 1) : null,
      cards: list.map(({ id, name, subject, days, stuck, note, owner }) => ({ id, name, subject, days, stuck, note, owner })),
    };
  });
  const byStuck = [...columns].sort((a, b) => b.stuck - a.stuck || (b.medianDays ?? 0) - (a.medianDays ?? 0));
  const byCount = columns.filter((column) => column.key !== "offer").sort((a, b) => b.count - a.count);
  const bottleneck = byStuck[0].stuck > 0 ? byStuck[0].key : byCount[0].count - byCount[1].count >= 3 ? byCount[0].key : null;
  return { columns, bottleneck };
}
