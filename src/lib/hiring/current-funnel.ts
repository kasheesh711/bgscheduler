import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { approvedOffers } from "./service";
import { offerNext } from "./offer-rows";
import { storedResume } from "./resume-files";
import type { Stage, Subject } from "./model";

export const funnelSteps = [
  "Application screening",
  "HR call",
  "Pre-screen",
  "Paper assessment",
  "Mock teaching",
  "Final review",
  "Offer and contract",
] as const;
export type FunnelStage = (typeof funnelSteps)[number];
const day = 86_400_000;
const nextAction: Record<FunnelStage, string> = {
  "Application screening": "Await ATS score",
  "HR call": "Follow up on HR call",
  "Pre-screen": "Check response",
  "Paper assessment": "Check paper or booking",
  "Mock teaching": "Check mock or booking",
  "Final review": "Review recommendation",
  "Offer and contract": "Check contract",
};
function stageOf(stage: string): FunnelStage | null {
  switch (stage) {
    case "new":
    case "review":
      return "Application screening";
    case "pre_screen":
      return "Pre-screen";
    case "onsite_booked":
    case "onsite_invited":
    case "paper_invited":
    case "paper_booked":
      return "Paper assessment";
    case "mock_invited":
    case "paper_passed":
    case "mock_booked":
      return "Mock teaching";
    case "hired":
      return "Offer and contract";
    default:
      return null;
  }
}
type Visit = { id: string; visitId: string | null; kind: string; start: string };
export type FunnelPerson = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  subjects: Subject[];
  rawStage: Stage;
  stage: FunnelStage;
  since: string | null;
  next: string;
  resume: boolean;
  revision: number;
  answered: boolean;
  paperFinished: boolean;
  bookings: Visit[];
  history: { at: string; label: string; note?: string; followUp?: string }[];
  contact: { at: string; label: string; note?: string; followUp?: string } | null;
  emailStatus: string | null;
};
type Entry = { stage: FunnelStage | null; at: number };
export function measureStays(events: Entry[], current: FunnelStage | null, now: number) {
  const completed: { stage: FunnelStage; days: number }[] = [];
  let previous: Entry | undefined;
  for (const event of events
    .filter((e) => Number.isFinite(e.at) && e.at <= now)
    .sort((a, b) => a.at - b.at)) {
    if (previous && previous.stage === event.stage) continue;
    if (previous?.stage && event.at >= now - 84 * day)
      completed.push({ stage: previous.stage, days: (event.at - previous.at) / day });
    previous = event;
  }
  return {
    completed,
    since: previous && current && previous.stage === current ? new Date(previous.at).toISOString() : null,
  };
}
function group<T extends { candidateId: string | null }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows)
    if (row.candidateId) {
      const list = map.get(row.candidateId);
      if (list) list.push(row);
      else map.set(row.candidateId, [row]);
    }
  return map;
}
export async function currentFunnel(db: Database, now = new Date()) {
  const c = s.hiringCandidates,
    b = s.hiringBookings,
    a = s.hiringAudit,
    o = s.hiringOutbox,
    d = s.hiringDecisions;
  const [entries, people, bookings, audits, messages, decisions, offers] = await Promise.all([
    db
      .select({
        candidateId: s.hiringStageEntries.candidateId,
        stage: s.hiringStageEntries.stage,
        at: s.hiringStageEntries.enteredAt,
      })
      .from(s.hiringStageEntries)
      .orderBy(s.hiringStageEntries.id),
    db
      .select({
        id: c.id,
        name: c.name,
        email: c.email,
        scored: sql<boolean>`${c.profileAssessment} is not null`,
        callComplete: sql<boolean>`${c.callReview}->'good' is not null`,
        phone: c.phone,
        stage: c.stage,
        subjects: c.subjects,
        visitSubject: c.visitSubject,
        revision: c.revision,
        answered: sql<boolean>`${c.preScreen} is not null and ${c.preScreenRepliedAt} is not null`,
        replyAt: c.preScreenRepliedAt,
        resumePath: c.resumePath,
        resumeType: c.resumeType,
        passAt: c.paperPassedAt,
      })
      .from(c),
    db
      .select({
        id: b.id,
        candidateId: b.candidateId,
        kind: b.kind,
        visitId: b.visitId,
        status: b.status,
        start: b.startTime,
        end: b.endTime,
        created: b.createdAt,
      })
      .from(b),
    db
      .select({ candidateId: a.candidateId, action: a.action, at: a.createdAt, detail: a.detail })
      .from(a)
      .where(
        inArray(a.action, [
          "move-to-review",
          "pre-screen-release",
          "onsite-release",
          "invite_onsite",
          "waive_paper",
          "head-decision",
          "soft-reject",
          "stop",
          "no-reply",
          "no-booking",
          "mark_no_show",
          "cancel_visit",
          "cancel_funnel_visit",
          "funnel-call",
          "call-good",
          "call-no-answer",
          "mock-rubric-submitted",
        ]),
      ),
    db
      .select({
        candidateId: o.candidateId,
        status: o.status,
        sent: o.sentAt,
        created: o.createdAt,
        key: o.key,
        to: sql<string>`${o.payload}->>'to'`,
        subject: sql<string>`${o.payload}->>'subject'`,
      })
      .from(o)
      .where(eq(o.kind, "email")),
    db
      .select({ candidateId: d.candidateId, decision: d.decision, at: d.sentAt })
      .from(d)
      .where(isNotNull(d.sentAt)),
    approvedOffers(db),
  ]);
  if (offers === null) throw new Error("Approved offers are unavailable");
  const recorded = group(entries);
  const visits = group(bookings),
    actions = group(audits),
    emails = group(messages),
    outcomes = group(decisions);
  const offerById = new Map([...offers].reverse().map((o) => [o.candidateId, o]));
  const totals = funnelSteps.map((stage) => ({
    stage,
    count: 0,
    currentDays: 0,
    dated: 0,
    completedDays: 0,
    completed: 0,
  }));
  const byStage = new Map(totals.map((t) => [t.stage, t]));
  const rows: FunnelPerson[] = [];
  for (const p of people) {
    const events: Entry[] = [];
    const history: FunnelPerson["history"] = [];
    let finalReviewAt = 0,
      contact: FunnelPerson["contact"] = null;
    const log = (stage: FunnelStage | null, at: Date | string) => events.push({ stage, at: +new Date(at) });
    const contacted = (at: Date, label: string, note?: string, followUp?: string) => {
      if (at <= now) history.push({ at: at.toISOString(), label, note, followUp });
      if (at <= now && (!contact || +at >= Date.parse(contact.at)))
        contact = { at: at.toISOString(), label, note, followUp };
    };
    for (const entry of recorded.get(p.id) ?? []) {
      const afterReply = entry.stage === "review" && p.replyAt && p.replyAt <= entry.at;
      log(afterReply ? "Pre-screen" : stageOf(entry.stage), entry.at);
    }
    if (p.replyAt) log("Pre-screen", p.replyAt);
    for (const a of actions.get(p.id) ?? []) {
      if (a.action === "move-to-review")
        log(
          a.detail.phase === "pre" || (p.replyAt && p.replyAt <= a.at)
            ? "Pre-screen"
            : "Application screening",
          a.at,
        );
      else if (a.action === "pre-screen-release") log("Pre-screen", a.at);
      else if (["onsite-release", "invite_onsite"].includes(a.action)) log("Paper assessment", a.at);
      else if (a.action === "waive_paper") log("Mock teaching", a.at);
      else if (a.action === "head-decision" || a.action === "mock-rubric-submitted") {
        log("Final review", a.at);
        finalReviewAt = Math.max(finalReviewAt, +a.at);
      } else if (a.action === "funnel-call")
        contacted(
          a.at,
          String(a.detail.outcome),
          String(a.detail.note ?? ""),
          String(a.detail.followUp ?? ""),
        );
      else if (a.action === "call-good" || a.action === "call-no-answer")
        contacted(a.at, a.action === "call-good" ? "Reached" : "No answer");
      else if (a.action !== "cancel_funnel_visit" || !stageOf(p.stage)) log(null, a.at);
    }
    const mail = (emails.get(p.id) ?? [])
      .filter((m) => m.to && p.email && m.to.toLowerCase() === p.email.toLowerCase())
      .sort((a, b) => +b.created - +a.created);
    for (const m of mail)
      if (m.status === "sent" && m.sent) {
        contacted(m.sent, "Email · " + (m.subject || "Sent"));
        if (m.key === p.id + ":call-invite") log("HR call", m.sent);
        if (m.key === p.id + ":pre-screen") log("Pre-screen", m.created);
        if (m.key === p.id + ":visit-invite") log("Paper assessment", m.created);
      }
    const personBookings = visits.get(p.id) ?? [];
    for (const b of personBookings) {
      if (b.kind === "call") log("HR call", b.created);
      if (b.kind === "paper") log("Paper assessment", b.created);
      // A joint booking reserves both appointments while the person is still at the paper stage.
      if (b.kind === "mock" && !b.visitId) log("Mock teaching", b.created);
    }
    if (p.passAt) log("Mock teaching", p.passAt);
    for (const d of outcomes.get(p.id) ?? [])
      if (d.at) log(d.decision === "hire" ? "Offer and contract" : null, d.at);
    const offer = offerById.get(p.id);
    const done = offer?.uploadedAt && offer.submittedAt;
    if (done) log(null, new Date(Math.max(Date.parse(offer.uploadedAt!), Date.parse(done))));
    let stage = stageOf(p.stage);
    if (stage === "Application screening") {
      if (p.answered) stage = "Pre-screen";
      else if (
        p.stage === "new" &&
        (mail.some((m) => m.key === p.id + ":call-invite" && m.status === "sent") ||
          personBookings.some((b) => b.kind === "call" && b.status === "confirmed"))
      )
        stage = "HR call";
    }
    if (p.stage === "hired" && (!offer || done)) stage = null;
    if (
      stage &&
      stage !== "Offer and contract" &&
      finalReviewAt > 0 &&
      !events.some(
        (e) => e.at > finalReviewAt && (e.stage === "Paper assessment" || e.stage === "Mock teaching"),
      ) &&
      ["onsite_booked", "mock_booked", "paper_passed"].includes(p.stage)
    )
      stage = "Final review";
    if (stage === "Paper assessment" && p.passAt && p.stage === "onsite_booked") stage = "Mock teaching";
    const { since, completed } = measureStays(events, stage, +now);
    for (const sample of completed) {
      const t = byStage.get(sample.stage)!;
      t.completed++;
      t.completedDays += sample.days;
    }
    if (!stage) continue;
    const t = byStage.get(stage)!;
    t.count++;
    if (since) {
      t.dated++;
      t.currentDays += (+now - Date.parse(since)) / day;
    }
    rows.push({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      stage,
      rawStage: p.stage,
      subjects: p.visitSubject ? [p.visitSubject] : p.subjects,
      revision: p.revision,
      answered: p.answered,
      paperFinished: personBookings.some(
        (b) => b.kind === "paper" && b.status === "confirmed" && b.end <= now,
      ),
      since,
      contact,
      history: history.sort((a, b) => b.at.localeCompare(a.at)),
      emailStatus: mail[0]?.status ?? null,
      resume: !!storedResume(p.id, p.resumePath, p.resumeType),
      next: offer
        ? "Contract pending · " + offerNext(offer, now).label
        : stage === "Application screening"
          ? p.scored
            ? p.stage === "review"
              ? "ATS scored · progression on hold"
              : "ATS scored · awaiting next step"
            : p.stage === "review"
              ? "ATS score unavailable"
              : "Await ATS score"
          : stage === "Pre-screen" && p.answered
            ? p.stage === "review"
              ? "Pre-screen response on hold"
              : "Answers received · awaiting assessment invitation"
            : stage === "HR call" && p.callComplete
              ? "Call complete · awaiting pre-screen"
              : nextAction[stage],
      bookings: personBookings
        .filter((b) => b.status === "confirmed" && b.start > now)
        .sort((a, b) => +a.start - +b.start)
        .map((b) => ({ id: b.id, kind: b.kind, visitId: b.visitId, start: b.start.toISOString() })),
    });
  }
  rows.sort(
    (a, b) =>
      (a.since ?? "z").localeCompare(b.since ?? "z") ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return {
    now: now.toISOString(),
    rows,
    stages: totals.map((t) => ({
      stage: t.stage,
      count: t.count,
      dated: t.dated,
      completed: t.completed,
      current: t.dated ? t.currentDays / t.dated : null,
      history: t.completed ? t.completedDays / t.completed : null,
    })),
  };
}
export type CurrentFunnel = Awaited<ReturnType<typeof currentFunnel>>;
