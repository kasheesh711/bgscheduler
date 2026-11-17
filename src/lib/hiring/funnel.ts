/**
 * The hiring funnel, the time between steps and the stuck candidates, built from the /api/hiring payload only.
 * The rules copy .hillclimb/evidence/funnel.sql (18 Nov 2026), so the screen and that baseline count the same way.
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
const WEEKS = 12;
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
  { key: "new", stage: "new", label: "New, no call link", days: 14, why: "The worker checks the gate each cycle. Two weeks means a setting holds it.", next: "Check the gate reason. Change the rules or stop the candidate.", owner: "Kevin" },
  { key: "new (call link sent, no call)", stage: "new", label: "New, call link sent", days: 7, why: "A call link lasts 14 days. A week with no booking is a stall.", next: "Candidate books the HR call.", owner: "HR" },
  { key: "new (call booked)", stage: "new", label: "New, call booked", days: 3, why: "After the call time, HR must record the result.", next: "Record the call result on 2 Calls.", owner: "HR" },
  { key: "review", stage: "review", label: "In review", days: 7, why: "It waits on a person.", next: "Read the record. Invite, move on or stop.", owner: "HR" },
  { key: "pre_screen", stage: "pre_screen", label: "Pre-screen", days: 7, why: "Form and reminder window.", next: "Candidate sends the form. The worker sends a reminder.", owner: "HR" },
  { key: "onsite_invited", stage: "onsite_invited", label: "Onsite invited", days: 7, why: "Invite link lifetime.", next: "Candidate books a visit.", owner: "Kevin" },
  { key: "onsite_booked", stage: "onsite_booked", label: "Onsite booked", days: 3, why: "The clock starts at the visit time. After the visit, a decision is due.", next: "Mark the paper and the mock, then send Hire or Reject.", owner: "Kevin" },
  { key: "paper_invited", stage: "paper_invited", label: "Paper invited (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: invite to a visit or stop.", owner: "Kevin" },
  { key: "paper_booked", stage: "paper_booked", label: "Paper booked (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: invite to a visit or stop.", owner: "Kevin" },
  { key: "paper_passed", stage: "paper_passed", label: "Paper passed (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: Hire or Reject.", owner: "Kevin" },
  { key: "mock_booked", stage: "mock_booked", label: "Mock booked (old flow)", days: 14, why: "Old tracker row with no decision.", next: "Decide: Hire or Reject.", owner: "Kevin" },
  { key: "no_reply", stage: "no_reply", label: "No reply", days: null, why: "Parked.", next: "None. Parked.", owner: "HR" },
  { key: "no_booking", stage: "no_booking", label: "No booking", days: null, why: "Parked.", next: "None. Parked.", owner: "Kevin" },
  { key: "hired", stage: "hired", label: "Hired", days: null, why: "Closed.", next: "Offer and onboarding. No process yet.", owner: "Needs review: no owner" },
  { key: "rejected", stage: "rejected", label: "Rejected", days: null, why: "Closed.", next: "None. Closed.", owner: "Kevin" },
  { key: "stopped", stage: "stopped", label: "Stopped", days: null, why: "Closed.", next: "None. Closed.", owner: "Kevin" },
];

export type Stat = { n: number; median: number; p90: number };
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
  reached: Record<FunnelStep, number>;
  /** Share of the step before, 3 places; `null` when the step before has nobody. */
  conv: Record<Exclude<FunnelStep, "applied">, number | null>;
  stuck: number;
  stepDays: Partial<Record<StepName, Stat>>;
  currentStage: Record<string, StageStat>;
};
export type FunnelReport = {
  now: string;
  windowStart: string;
  excludedBeforeWindow: number;
  /** True when the payload holds PAYLOAD_ROW_CAP candidates: older rows were cut, so counts can be low. */
  capped: boolean;
  /** "all", "campaign:<seekJobId or tracker-only>", "week:<ISO week>". */
  groups: Record<string, GroupFunnel>;
};

const ms = (value: When) => (value ? new Date(value).getTime() : null);
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
const stat = (values: number[]): Stat => ({
  n: values.length,
  median: roundTo(percentile(values, 0.5), 1),
  p90: roundTo(percentile(values, 0.9), 1),
});

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

type Row = {
  id: string;
  stage: string;
  campaign: string;
  week: string;
  reached: Record<FunnelStep, boolean>;
  stageKey: string;
  daysInStage: number;
  stuckAfter: number | null;
  stuck: boolean;
  sinceIsImport: boolean;
  steps: Partial<Record<StepName, number>>;
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
  const sent = minBy(data.inviteOutbox.filter((o) => o.status === "sent"), (o) => o.key, (o) => ms(o.sentAt));
  const event = (action: string, pick = least) =>
    minBy(data.funnelEvents.filter((e) => e.action === action), (e) => e.candidateId, (e) => ms(e.at), pick);
  const reviewAt = event("move-to-review", greatest);
  const noReplyAt = event("no-reply", greatest);
  const noBookingAt = event("no-booking", greatest);
  const callBooked = event("call-booked");
  const onsiteAudit = minBy(
    data.funnelEvents.filter((e) => e.action === "invite_onsite" || e.action === "onsite-release"),
    (e) => e.candidateId,
    (e) => ms(e.at),
  );
  const callStart = minBy(data.calls, (c) => c.candidateId, (c) => ms(c.start), greatest);
  const visits = data.bookings.filter((b) => b.kind === "paper" || b.kind === "mock");
  const visitBooked = minBy(visits, (b) => b.candidateId, (b) => ms(b.createdAt));
  const visitAt = minBy(
    visits.filter((b) => b.status === "confirmed" && (ms(b.startTime) ?? Infinity) < nowMs),
    (b) => b.candidateId,
    (b) => ms(b.startTime),
  );
  const offerAt = minBy(
    data.decisions.filter((d) => d.decision === "hire" && d.status === "sent"),
    (d) => d.candidateId,
    (d) => ms(d.sentAt),
  );

  let excluded = 0;
  const rows: Row[] = [];
  for (const c of data.candidates) {
    const id = c.id;
    const created = ms(c.createdAt)!;
    const replied = ms(c.preScreenRepliedAt);
    const callInv = sent.get(`${id}:call-invite`) ?? null;
    const formSent = sent.get(`${id}:pre-screen`) ?? null;
    const visitInv = sent.get(`${id}:visit-invite`) ?? onsiteAudit.get(id) ?? null;
    const callGood = ms(c.callReview?.good?.at);
    const callAt = callStart.get(id) ?? null;
    const booked = visitBooked.get(id) ?? null;
    const visited = visitAt.get(id) ?? null;
    const offer = offerAt.get(id) ?? null;
    const review = reviewAt.get(id) ?? null;
    const firstSeen = least(created, replied, callInv, formSent)!;
    if (firstSeen < start) excluded++;
    if (firstSeen < start || firstSeen >= nowMs) continue;
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
    let since = created;
    if (stage === "new") since = callAt !== null && callOpen ? callAt : callInv !== null && callOpen ? callInv : firstSeen;
    else if (stage === "review") since = review ?? created;
    else if (stage === "pre_screen") since = formSent ?? created;
    else if (stage === "no_reply") since = noReplyAt.get(id) ?? created;
    else if (stage === "onsite_invited") since = visitInv ?? created;
    else if (stage === "no_booking") since = noBookingAt.get(id) ?? created;
    else if (stage === "onsite_booked") since = visited ?? booked ?? created;
    const stageKey =
      stage === "new" && callAt !== null && callOpen
        ? "new (call booked)"
        : stage === "new" && callInv !== null && callOpen
          ? "new (call link sent, no call)"
          : stage;
    const rule = STUCK_RULES.find((r) => r.key === stageKey)?.days ?? null;
    const stuckAfter = stage === "onsite_booked" && visited === null ? null : rule;
    const daysInStage = (nowMs - since) / DAY;
    const steps: Partial<Record<StepName, number>> = {};
    const days = (a: number, b: number) => (b - a) / DAY;
    const contact = least(callInv, formSent, callGood);
    if (contact !== null && contact >= firstSeen) steps.applied_to_contacted = days(firstSeen, contact);
    if (callBooked.has(id) && callInv !== null) steps.call_link_to_call_booked = days(callInv, callBooked.get(id)!);
    if (replied !== null && formSent !== null && replied > formSent) steps.form_sent_to_replied = days(formSent, replied);
    if (visitInv !== null && replied !== null && visitInv > replied) steps.replied_to_onsite_invited = days(replied, visitInv);
    if (booked !== null && visitInv !== null && booked >= visitInv) steps.onsite_invited_to_booked = days(visitInv, booked);
    if (visited !== null && booked !== null) steps.booked_to_visit = days(booked, visited);
    if (visited !== null) steps.applied_to_visit = days(firstSeen, visited);
    if (visited !== null && replied !== null && visited > replied) steps.replied_to_visit = days(replied, visited);
    if (offer !== null && visited !== null && offer >= visited) steps.visit_to_offer = days(visited, offer);
    rows.push({
      id,
      stage,
      campaign: c.seekJobId ?? "tracker-only",
      week: isoWeek(firstSeen),
      reached,
      stageKey,
      daysInStage,
      stuckAfter,
      stuck: stuckAfter !== null && daysInStage > stuckAfter,
      sinceIsImport: (stage === "review" && review === null) || [...OLD_FLOW, "stopped"].includes(stage),
      steps,
    });
  }

  const keys = new Map<string, Row[]>([["all", rows]]);
  for (const row of rows)
    for (const g of [`campaign:${row.campaign}`, `week:${row.week}`]) {
      const list = keys.get(g) ?? [];
      list.push(row);
      keys.set(g, list);
    }
  const groups = Object.fromEntries([...keys].map(([g, list]) => [g, summarize(list)]));
  return {
    now: now.toISOString(),
    windowStart: new Date(start).toISOString(),
    excludedBeforeWindow: excluded,
    capped: data.candidates.length >= PAYLOAD_ROW_CAP,
    groups,
  };
}

function summarize(rows: Row[]): GroupFunnel {
  const reached = Object.fromEntries(
    FUNNEL_STEPS.map(([step]) => [step, rows.filter((r) => r.reached[step]).length]),
  ) as Record<FunnelStep, number>;
  const conv = Object.fromEntries(
    FUNNEL_STEPS.slice(1).map(([step], i) => {
      const before = reached[FUNNEL_STEPS[i][0]];
      return [step, before ? roundTo(reached[step] / before, 3) : null];
    }),
  ) as GroupFunnel["conv"];
  const stepDays: GroupFunnel["stepDays"] = {};
  for (const name of Object.values(STEP_TIMING).concat(["call_link_to_call_booked", "applied_to_visit", "replied_to_visit"]) as StepName[]) {
    const values = rows.flatMap((r) => (r.steps[name] === undefined ? [] : [r.steps[name]!]));
    if (values.length) stepDays[name] = stat(values);
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
  return { reached, conv, stuck: rows.filter((r) => r.stuck).length, stepDays, currentStage };
}
