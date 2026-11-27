/**
 * The hiring funnel, the time between steps and the stuck candidates, built from the /api/hiring payload only.
 * The rules copy .hillclimb/evidence/funnel.sql (18 Nov 2026), so the screen and that baseline count the same way,
 * with two on-purpose differences: a call still ahead counts days from its latest booking and is never stuck, and days
 * in stage are never below 0.
 * No stage-history table exists: a step counts when an event proves it or when the current stage implies it.
 */

type When = Date | string | null | undefined;
export type FunnelInput = {
  candidates: {
    id: string;
    stage: string;
    createdAt: When;
    seekJobId: string | null;
    preScreenRepliedAt: When;
    callReview: { good: { at: string } | null } | null;
  }[];
  /** Visit bookings (paper and mock), every status. */
  bookings: { candidateId: string; kind: string; status: string; startTime: When; createdAt: When }[];
  /** Confirmed HR calls. */
  calls: { candidateId: string; start: When }[];
  inviteOutbox: { key: string; status: string; sentAt: When }[];
  decisions: { candidateId: string; decision: string; status: string; sentAt: When }[];
  /** Audit actions that date a stage, plus `call-booked` for each HR call booking. */
  funnelEvents: { candidateId: string | null; action: string; at: When }[];
};

export const FUNNEL_AUDIT_ACTIONS = ["move-to-review", "no-reply", "no-booking", "invite_onsite", "onsite-release"];
export const FUNNEL_STEPS = [
  ["applied", "Applied"],
  ["contacted", "Contacted"],
  ["replied", "Replied to pre-screen"],
  ["onsite_invited", "Onsite invited"],
  ["visit_booked", "Visit booked"],
  ["visited", "Visited"],
  ["offer", "Offer"],
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number][0];
/** The time measure shown beside each step: from the step before it. */
export const STEP_TIMING: Record<Exclude<FunnelStep, "applied">, StepName> = {
  contacted: "applied_to_contacted",
  replied: "form_sent_to_replied",
  onsite_invited: "replied_to_onsite_invited",
  visit_booked: "onsite_invited_to_booked",
  visited: "booked_to_visit",
  offer: "visit_to_offer",
};
export type StepName =
  | "applied_to_contacted"
  | "call_link_to_call_booked"
  | "form_sent_to_replied"
  | "replied_to_onsite_invited"
  | "onsite_invited_to_booked"
  | "booked_to_visit"
  | "applied_to_visit"
  | "replied_to_visit"
  | "visit_to_offer";

const OLD_FLOW = ["paper_invited", "paper_booked", "paper_passed", "mock_booked"];
const DAY = 86_400_000;
const BANGKOK_MS = 7 * 3_600_000; // Bangkok has no daylight saving, so a fixed offset is exact.
export const WEEKS = 12;
/**
 * shortcut: dashboard() reads at most 2000 candidates (newest update first) and 2000 bookings, so above that the
 * funnel counts go low. The panel says so when the candidate list is full. Upgrade: aggregate in SQL when that happens.
 */
export const PAYLOAD_ROW_CAP = 2000;

/**
 * Per current stage: days after which a candidate is stuck (funnel.md; `null` = parked or closed, never stuck),
 * and the next action with its owner (service-blueprint.md RACI, "A" column).
 */
export const STUCK_RULES: { key: string; stage: string; label: string; days: number | null; why: string; next: string; owner: string }[] = [
  // Kevin, 25 Nov 2026: nobody is stuck before the first email (the Next steps email). New and In review only count.
  { key: "new", stage: "new", label: "New", days: null, why: "Not emailed yet. The worker checks the gate each cycle.", next: "None. The queue sends the Next steps email.", owner: "Kevin" },
  { key: "new (call link sent, no call)", stage: "new", label: "New, call link sent", days: null, why: "Old HR call flow (calls ended 24 Nov 2026).", next: "None.", owner: "Kevin" },
  { key: "new (call booked)", stage: "new", label: "New, call booked", days: null, why: "Old HR call flow (calls ended 24 Nov 2026).", next: "None.", owner: "Kevin" },
  { key: "review", stage: "review", label: "In review", days: null, why: "Not emailed yet. It waits on a person.", next: "Read the record. Invite, move on or stop.", owner: "Kevin" },
  { key: "pre_screen", stage: "pre_screen", label: "Pre-screen", days: 7, why: "Form and reminder window.", next: "Candidate sends the form. The worker sends a reminder.", owner: "Kevin" },
  { key: "onsite_invited", stage: "onsite_invited", label: "Onsite invited", days: 7, why: "Invite link lifetime.", next: "Candidate books a visit.", owner: "Kevin" },
  { key: "onsite_booked", stage: "onsite_booked", label: "Onsite booked", days: 3, why: "The clock starts at the visit time. After the visit, a decision is due.", next: "Mark the paper and the mock, then send Hire or Reject.", owner: "Kevin" },
  { key: "paper_invited", stage: "paper_invited", label: "Paper invited (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: invite to a visit or stop.", owner: "Kevin" },
  { key: "paper_booked", stage: "paper_booked", label: "Paper booked (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: invite to a visit or stop.", owner: "Kevin" },
  { key: "paper_passed", stage: "paper_passed", label: "Paper passed (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: Hire or Reject.", owner: "Kevin" },
  { key: "mock_booked", stage: "mock_booked", label: "Mock booked (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: Hire or Reject.", owner: "Kevin" },
  { key: "no_reply", stage: "no_reply", label: "No reply", days: null, why: "Parked.", next: "None. Parked.", owner: "Kevin" },
  { key: "no_booking", stage: "no_booking", label: "No booking", days: null, why: "Parked.", next: "None. Parked.", owner: "Kevin" },
  { key: "hired", stage: "hired", label: "Hired", days: null, why: "Closed.", next: "Offer and onboarding. No process yet.", owner: "Needs review: no owner" },
  { key: "rejected", stage: "rejected", label: "Rejected", days: null, why: "Closed.", next: "None. Closed.", owner: "Kevin" },
  { key: "stopped", stage: "stopped", label: "Stopped", days: null, why: "Closed.", next: "None. Closed.", owner: "Kevin" },
  { key: "soft_rejected", stage: "soft_rejected", label: "Soft rejected", days: null, why: "Under the pass score and never emailed.", next: "None. Comes back by a click, or when a subject runs out of candidates at the pass score.", owner: "Kevin" },
];

/** Stages that have left the active pipeline: parked, closed, decided or soft rejected. */
export const CLOSED_STAGES = ["no_reply", "no_booking", "stopped", "hired", "rejected", "soft_rejected"];

type TimedMove = { from: number; to: number };
export type Stat = { n: number; median: number; p90: number; moves: Record<string, TimedMove> };
export type StageStat = {
  n: number;
  stuck: number;
  stuckAfterDays: number | null;
  sinceIsImportTime: number;
  medianDays: number;
  p90Days: number;
  stuckIds: string[];
};
export type GroupFunnel = {
  /** Candidates with a dated record for the step. First seen always has a record date. */
  documented: Record<FunnelStep, number>;
  reached: Record<FunnelStep, number>;
  /** Candidates whose last reached step is this one. The counts add up to `reached.applied`. */
  furthest: Record<FunnelStep, number>;
  /** Share of the step before, 3 places; `null` when the step before has nobody. */
  conv: Record<Exclude<FunnelStep, "applied">, number | null>;
  /**
   * The same people at both ends (Overview, 25 Nov 2026): candidates whose furthest step is this one or later. A skipped
   * step (call-first flow) still counts as passed, so `atLeast` never grows and step-to-step shares stay at or below 100%.
   */
  atLeast: Record<FunnelStep, number>;
  /** Ids whose furthest step is this one, split into still open and closed or parked. */
  stopped: Record<FunnelStep, { open: string[]; closed: string[] }>;
  stuck: number;
  /**
   * Weeks the group's applicants span: 1 for a week group; a month group is its part of the window, to now at most;
   * else from max(window start, first applicant) to now. At least 1.
   */
  weeks: number;
  stepDays: Partial<Record<StepName, Stat>>;
  currentStage: Record<string, StageStat>;
};
export type FunnelReport = {
  now: string;
  windowStart: string;
  excludedBeforeWindow: number;
  /** True when the payload holds PAYLOAD_ROW_CAP candidates: older rows were cut, so counts can be low. */
  capped: boolean;
  /** "all", "campaign:<seekJobId or tracker-only>", "month:<Bangkok month, 2026-11>", "week:<ISO week>". */
  groups: Record<string, GroupFunnel>;
  /** Every candidate in the payload, in the window or not: the stage key (a STUCK_RULES key), days in it and stuck. */
  byCandidate: Record<string, CandidateStage>;
};
export type CandidateStage = { stageKey: string; daysInStage: number; stuck: boolean; importDateOnly?: true };

const ms = (value: When) => (value ? new Date(value).getTime() : null);
/** An existing booking with no creation date can still show a plan, but cannot date the booking step. */
export const bookingKnownAt = (booking: { createdAt: When }, now: Date) =>
  booking.createdAt == null || (ms(booking.createdAt) ?? Infinity) <= now.getTime();
const least = (...values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.min(...known) : null;
};
const greatest = (...values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.max(...known) : null;
};
/** Postgres `round(numeric, n)`: half away from zero. */
export const roundTo = (value: number, places: number) => {
  const f = 10 ** places;
  return (Math.sign(value) * Math.round(Math.abs(value) * f + 1e-9)) / f;
};
/** Postgres `percentile_cont`: linear between the two nearest ranks. */
export function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
const stat = (moves: Record<string, TimedMove>): Stat => {
  const days = Object.values(moves).map(move => (move.to - move.from) / DAY);
  return { n: days.length, median: roundTo(percentile(days, 0.5), 1), p90: roundTo(percentile(days, 0.9), 1), moves };
};

/** ISO week of the Bangkok calendar day, as "2026-W47". */
export function isoWeek(time: number) {
  const d = new Date(time + BANGKOK_MS);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  // Week 1 holds the first Thursday of the year, so the Thursday's day of the year gives the week.
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
/** Monday 00:00 Bangkok, 11 weeks before the week that holds `now`: twelve ISO weeks in all. */
export function windowStart(now: Date) {
  const local = new Date(now.getTime() + BANGKOK_MS);
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return monday - (WEEKS - 1) * 7 * DAY - BANGKOK_MS;
}

/** The half-open first-seen interval for this selected cohort, in Bangkok calendar time. */
export function cohortWindow(report: Pick<FunnelReport, "now" | "windowStart">, group: string) {
  const start = Date.parse(report.windowStart);
  const now = Date.parse(report.now);
  let from = start;
  let until = now;
  if (group.startsWith("month:")) {
    const [year, month] = group.slice(6).split("-").map(Number);
    from = Date.UTC(year, month - 1, 1) - BANGKOK_MS;
    until = Date.UTC(year, month, 1) - BANGKOK_MS;
  } else if (group.startsWith("week:")) {
    const [year, week] = group.slice(5).split("-W").map(Number);
    // January 4 always belongs to ISO week 1, even when its Monday is in December.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
    from = monday + (week - 1) * 7 * DAY - BANGKOK_MS;
    until = from + 7 * DAY;
  }
  return { from: Math.max(start, from), until: Math.min(now, until), clippedStart: from < start, clippedEnd: until > now };
}

type Row = {
  id: string;
  stage: string;
  campaign: string;
  week: string;
  firstSeen: number;
  documented: Record<FunnelStep, boolean>;
  reached: Record<FunnelStep, boolean>;
  stageKey: string;
  daysInStage: number;
  stuckAfter: number | null;
  stuck: boolean;
  sinceIsImport: boolean;
  steps: Partial<Record<StepName, TimedMove>>;
};

function minBy<T>(rows: T[], key: (row: T) => string | null, value: (row: T) => number | null, pick = least) {
  const out = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    const v = value(row);
    if (k === null || v === null) continue;
    const old = out.get(k);
    out.set(k, old === undefined ? v : pick(old, v)!);
  }
  return out;
}

export function buildFunnel(data: FunnelInput, now: Date): FunnelReport {
  const nowMs = now.getTime();
  const start = windowStart(now);
  // A dated outcome can occur at the snapshot. A scheduled start can still lie ahead.
  const observed = (value: When) => {
    const time = ms(value);
    return time !== null && time <= nowMs ? time : null;
  };
  const sent = minBy(data.inviteOutbox.filter((o) => o.status === "sent"), (o) => o.key, (o) => observed(o.sentAt));
  // The newest visit link, a re-sent one (`:visit-invite:<n>`) included: the onsite-invited clock starts there.
  const latestVisitLink = minBy(
    data.inviteOutbox.filter((o) => o.status === "sent" && o.key.includes(":visit-invite")),
    (o) => o.key.split(":")[0],
    (o) => observed(o.sentAt),
    greatest,
  );
  const event = (action: string, pick = least) =>
    minBy(data.funnelEvents.filter((e) => e.action === action), (e) => e.candidateId, (e) => observed(e.at), pick);
  const reviewAt = event("move-to-review", greatest);
  const noReplyAt = event("no-reply", greatest);
  const noBookingAt = event("no-booking", greatest);
  const callBooked = event("call-booked");
  const callRebooked = event("call-booked", greatest);
  const onsiteAudit = minBy(
    data.funnelEvents.filter((e) => e.action === "invite_onsite" || e.action === "onsite-release"),
    (e) => e.candidateId,
    (e) => observed(e.at),
  );
  const callStart = minBy(data.calls, (c) => c.candidateId, (c) => ms(c.start), greatest);
  const visits = data.bookings.filter((b) => (b.kind === "paper" || b.kind === "mock") && bookingKnownAt(b, now));
  const visitBooked = minBy(visits, (b) => b.candidateId, (b) => ms(b.createdAt));
  const visitAt = minBy(
    visits.filter((b) => b.status === "confirmed"),
    (b) => b.candidateId,
    (b) => observed(b.startTime),
  );
  const offerAt = minBy(
    data.decisions.filter((d) => d.decision === "hire" && d.status === "sent"),
    (d) => d.candidateId,
    (d) => observed(d.sentAt),
  );

  let excluded = 0;
  const rows: Row[] = [];
  const byCandidate: Record<string, CandidateStage> = {};
  for (const c of data.candidates) {
    const id = c.id;
    const created = ms(c.createdAt)!;
    const replied = observed(c.preScreenRepliedAt);
    const callInv = sent.get(`${id}:call-invite`) ?? null;
    const formSent = sent.get(`${id}:pre-screen`) ?? null;
    const visitInv = sent.get(`${id}:visit-invite`) ?? onsiteAudit.get(id) ?? null;
    const callGood = observed(c.callReview?.good?.at);
    const callAt = callStart.get(id) ?? null;
    const booked = visitBooked.get(id) ?? null;
    const visited = visitAt.get(id) ?? null;
    const offer = offerAt.get(id) ?? null;
    const review = reviewAt.get(id) ?? null;
    const firstSeen = least(created, replied, callInv, formSent)!;
    const stage = c.stage;
    const callOpen = callGood === null;
    const reached: Record<FunnelStep, boolean> = {
      applied: true,
      contacted:
        callInv !== null || callGood !== null || formSent !== null || replied !== null ||
        ["pre_screen", "no_reply", ...OLD_FLOW, "onsite_invited", "onsite_booked", "no_booking", "hired"].includes(stage),
      replied: replied !== null,
      onsite_invited:
        visitInv !== null || booked !== null || [...OLD_FLOW, "onsite_invited", "onsite_booked", "no_booking", "hired"].includes(stage),
      visit_booked: booked !== null || ["paper_booked", "paper_passed", "mock_booked", "onsite_booked", "hired"].includes(stage),
      visited: visited !== null || ["paper_passed", "hired"].includes(stage),
      offer: offer !== null || stage === "hired",
    };
    let stageEvent: number | null = null;
    // Keep the existing fallback age for the funnel. Overview labels a missing stage event separately.
    const callAhead = callAt !== null && callAt > nowMs;
    if (stage === "new") {
      if (callAt !== null && callOpen) stageEvent = callAhead ? (callRebooked.get(id) ?? callInv) : callAt;
      else if (callOpen) stageEvent = callInv;
    } else if (stage === "review") stageEvent = review;
    else if (stage === "pre_screen") stageEvent = formSent;
    else if (stage === "no_reply") stageEvent = noReplyAt.get(id) ?? null;
    else if (stage === "onsite_invited") stageEvent = latestVisitLink.get(id) ?? visitInv;
    else if (stage === "no_booking") stageEvent = noBookingAt.get(id) ?? null;
    else if (stage === "onsite_booked") stageEvent = visited ?? booked;
    const since = stageEvent ?? (stage === "new" ? firstSeen : created);
    const stageKey =
      stage === "new" && callAt !== null && callOpen
        ? "new (call booked)"
        : stage === "new" && callInv !== null && callOpen
          ? "new (call link sent, no call)"
          : stage;
    const rule = STUCK_RULES.find((r) => r.key === stageKey)?.days ?? null;
    // The stuck clock starts at the visit or call time, so nobody is stuck before it.
    const stuckAfter = (stage === "onsite_booked" && visited === null) || (stageKey === "new (call booked)" && callAhead) ? null : rule;
    const daysInStage = Math.max(0, (nowMs - since) / DAY);
    const stuck = stuckAfter !== null && daysInStage > stuckAfter;
    byCandidate[id] = { stageKey, daysInStage, stuck, ...(stageEvent === null && { importDateOnly: true as const }) };
    if (firstSeen < start) excluded++;
    if (firstSeen < start || firstSeen >= nowMs) continue;
    const steps: Partial<Record<StepName, TimedMove>> = {};
    const contact = least(callInv, formSent, callGood);
    if (contact !== null && contact >= firstSeen) steps.applied_to_contacted = { from: firstSeen, to: contact };
    if (callBooked.has(id) && callInv !== null) steps.call_link_to_call_booked = { from: callInv, to: callBooked.get(id)! };
    if (replied !== null && formSent !== null && replied > formSent) steps.form_sent_to_replied = { from: formSent, to: replied };
    if (visitInv !== null && replied !== null && visitInv > replied) steps.replied_to_onsite_invited = { from: replied, to: visitInv };
    if (booked !== null && visitInv !== null && booked >= visitInv) steps.onsite_invited_to_booked = { from: visitInv, to: booked };
    if (visited !== null && booked !== null) steps.booked_to_visit = { from: booked, to: visited };
    if (visited !== null) steps.applied_to_visit = { from: firstSeen, to: visited };
    if (visited !== null && replied !== null && visited > replied) steps.replied_to_visit = { from: replied, to: visited };
    if (offer !== null && visited !== null && offer >= visited) steps.visit_to_offer = { from: visited, to: offer };
    rows.push({
      id,
      stage,
      campaign: c.seekJobId ?? "tracker-only",
      week: isoWeek(firstSeen),
      firstSeen,
      reached,
      documented: {
        applied: true, contacted: callInv !== null || formSent !== null || callGood !== null,
        replied: replied !== null, onsite_invited: visitInv !== null || (latestVisitLink.has(id) && reached.onsite_invited),
        visit_booked: booked !== null, visited: visited !== null, offer: offer !== null,
      },
      stageKey,
      daysInStage,
      stuckAfter,
      stuck,
      sinceIsImport: (stage === "review" && review === null) || [...OLD_FLOW, "stopped"].includes(stage),
      steps,
    });
  }

  const keys = new Map<string, Row[]>([["all", rows]]);
  for (const row of rows)
    for (const g of [`campaign:${row.campaign}`, `month:${new Date(row.firstSeen + BANGKOK_MS).toISOString().slice(0, 7)}`, `week:${row.week}`]) {
      const list = keys.get(g) ?? [];
      list.push(row);
      keys.set(g, list);
    }
  // A month group divides by the month's own days in the window, so that months compare. Bangkok midnight of day 1.
  const monthStart = (g: string, add: number) => Date.UTC(Number(g.slice(6, 10)), Number(g.slice(11)) - 1 + add, 1) - BANGKOK_MS;
  const weeksOf = (g: string, list: Row[]) => {
    if (g.startsWith("week:")) return 1;
    const span = g.startsWith("month:")
      ? Math.min(nowMs, monthStart(g, 1)) - Math.max(start, monthStart(g, 0))
      : nowMs - Math.max(start, Math.min(...list.map((r) => r.firstSeen)));
    return Math.max(1, span / (7 * DAY));
  };
  const groups = Object.fromEntries([...keys].map(([g, list]) => [g, summarize(list, weeksOf(g, list))]));
  return {
    now: now.toISOString(),
    windowStart: new Date(start).toISOString(),
    excludedBeforeWindow: excluded,
    capped: data.candidates.length >= PAYLOAD_ROW_CAP,
    groups,
    byCandidate,
  };
}

function summarize(rows: Row[], weeks: number): GroupFunnel {
  const reached = Object.fromEntries(
    FUNNEL_STEPS.map(([step]) => [step, rows.filter((r) => r.reached[step]).length]),
  ) as Record<FunnelStep, number>;
  // A step can be skipped (the call-first flow has no form reply), so the last reached step is counted per candidate.
  const furthest = Object.fromEntries(FUNNEL_STEPS.map(([step]) => [step, 0])) as Record<FunnelStep, number>;
  for (const r of rows) furthest[FUNNEL_STEPS.findLast(([step]) => r.reached[step])?.[0] ?? "applied"] += 1;
  const conv = Object.fromEntries(
    FUNNEL_STEPS.slice(1).map(([step], i) => {
      const before = reached[FUNNEL_STEPS[i][0]];
      return [step, before ? roundTo(reached[step] / before, 3) : null];
    }),
  ) as GroupFunnel["conv"];
  const stepDays: GroupFunnel["stepDays"] = {};
  for (const name of Object.values(STEP_TIMING).concat(["call_link_to_call_booked", "applied_to_visit", "replied_to_visit"]) as StepName[]) {
    const moves: Record<string, TimedMove> = {};
    for (const row of rows) {
      const move = row.steps[name];
      if (move) moves[row.id] = move;
    }
    if (Object.keys(moves).length) stepDays[name] = stat(moves);
  }
  const currentStage: Record<string, StageStat> = {};
  for (const key of new Set(rows.map((r) => r.stageKey))) {
    const list = rows.filter((r) => r.stageKey === key);
    const days = list.map((r) => r.daysInStage);
    const afters = list.flatMap((r) => (r.stuckAfter === null ? [] : [r.stuckAfter]));
    currentStage[key] = {
      n: list.length,
      stuck: list.filter((r) => r.stuck).length,
      stuckAfterDays: afters.length ? Math.max(...afters) : null,
      sinceIsImportTime: list.filter((r) => r.sinceIsImport).length,
      medianDays: roundTo(percentile(days, 0.5), 1),
      p90Days: roundTo(percentile(days, 0.9), 1),
      stuckIds: list.filter((r) => r.stuck).map((r) => r.id),
    };
  }
  const closedStages = new Set(CLOSED_STAGES);
  const stopped = Object.fromEntries(FUNNEL_STEPS.map(([step]) => [step, { open: [] as string[], closed: [] as string[] }])) as GroupFunnel["stopped"];
  for (const r of rows) {
    const last = FUNNEL_STEPS.findLast(([step]) => r.reached[step])?.[0] ?? "applied";
    stopped[last][closedStages.has(r.stage) ? "closed" : "open"].push(r.id);
  }
  let running = 0;
  const atLeast = {} as Record<FunnelStep, number>;
  for (const [step] of [...FUNNEL_STEPS].reverse()) atLeast[step] = running += furthest[step];
  const documented = Object.fromEntries(FUNNEL_STEPS.map(([step]) => [step, rows.filter(row => row.documented[step]).length])) as Record<FunnelStep, number>;
  return { documented, reached, furthest, conv, atLeast, stopped, stuck: rows.filter((r) => r.stuck).length, weeks, stepDays, currentStage };
}
