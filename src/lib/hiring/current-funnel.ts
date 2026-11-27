import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { approvedOffers } from "./service";
import { PAPER_CHECK_REQUESTED, PAPER_CHECK_DONE } from "./paper-check";
import type { HiringJourney, Milestone, PaperReview } from "./funnel-journey";
import { offerNext } from "./offer-rows";
import { storedResume } from "./resume-files";
import type { Stage, Subject } from "./model";

export const funnelSteps = [
  "Application screening",
  "HR call",
  "Pre-screen",
  "Paper assessment",
  "Human review",
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
  "Human review": "Await the subject head’s paper check",
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
  appliedSubjects: string[];
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
        waiver: c.paperWaiver,
        seek: sql<boolean>`${c.seekApplicationId} is not null or jsonb_array_length(${c.sourceIds}) > 0`,
        filteredAt: c.softRejectedAt,
        broughtBackAt: c.broughtBackAt,
        hasPaperScore: sql<boolean>`exists (select 1 from ${s.hiringPaperResults}
          where ${s.hiringPaperResults.candidateId} = ${c.id} and ${s.hiringPaperResults.marks} is not null)`,
        hasInterviewScore: sql<boolean>`exists (select 1 from ${s.hiringMockResults}
          where ${s.hiringMockResults.candidateId} = ${c.id} and ${s.hiringMockResults.rubric} is not null)`,
        signedDecision: s.hiringOnboarding.decisionId,
        confirmedSigned: s.hiringOnboarding.signedAt,
        id: c.id,
        name: c.name,
        email: c.email,
        scored: sql<boolean>`${c.profileAssessment} is not null`,
        callComplete: sql<boolean>`${c.callReview}->'good' is not null`,
        phone: c.phone,
        stage: c.stage,
        subjects: c.subjects,
        // Before the first invitation, the recorded ATS assessment owns the subject matches.
        assessedSubjects: sql<Subject[]>`coalesce(jsonb_path_query_array(${c.profileAssessment},
          '$.subjects[*] ? (@.relevant == true).subject'), '[]'::jsonb)`,
        visitSubject: c.visitSubject,
        revision: c.revision,
        answered: sql<boolean>`${c.preScreen} is not null and ${c.preScreenRepliedAt} is not null`,
        replyAt: c.preScreenRepliedAt,
        resumePath: c.resumePath,
        resumeType: c.resumeType,
        passAt: c.paperPassedAt,
      })
      .from(c)
      .leftJoin(s.hiringOnboarding, eq(s.hiringOnboarding.candidateId, c.id)),
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
          "source-import",
          "move-to-review",
          "pre-screen-release",
          "onsite-release",
          "invite_onsite",
          "waive_paper",
          "head-decision",
          "soft-reject",
          "soft-reject-restore",
          "bring-back",
          "bring_back",
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
          "final-review-packet",
          PAPER_CHECK_REQUESTED,
          PAPER_CHECK_DONE,
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
  const journeys: HiringJourney[] = [];
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
    const paperReviews = new Map<string, PaperReview>();
    const audits = (actions.get(p.id) ?? []).filter((a) => a.at <= now).sort((a, b) => +a.at - +b.at);
    for (const a of audits) {
      if (a.action === PAPER_CHECK_REQUESTED || a.action === PAPER_CHECK_DONE) {
        const resultId = a.detail.resultId,
          subject = a.detail.subject;
        if (typeof resultId !== "string" || typeof subject !== "string") continue;
        const review = paperReviews.get(resultId) ?? {
          subject,
          head: null,
          initial: null,
          requestedAt: null,
          decidedAt: null,
          passed: null,
          final: null,
        };
        if (typeof a.detail.head === "string") review.head = a.detail.head;
        if (a.action === PAPER_CHECK_REQUESTED) {
          review.requestedAt ??= a.at.toISOString();
          review.initial = typeof a.detail.percent === "number" ? a.detail.percent : null;
          log("Human review", a.at);
        } else {
          review.decidedAt = a.at.toISOString();
          review.passed = typeof a.detail.passed === "boolean" ? a.detail.passed : null;
          review.final = typeof a.detail.percent === "number" ? a.detail.percent : null;
          if (
            review.passed &&
            (visits.get(p.id) ?? []).some((b) => b.kind === "mock" && b.status === "confirmed")
          )
            log("Mock teaching", a.at);
          else log(review.passed ? "Paper assessment" : null, a.at);
        }
        paperReviews.set(resultId, review);
        continue;
      }
      if (a.action === "source-import") continue;
      if (["soft-reject-restore", "bring-back", "bring_back"].includes(a.action))
        log("Application screening", a.at);
      else if (a.action === "move-to-review")
        log(
          a.detail.phase === "pre" || (p.replyAt && p.replyAt <= a.at)
            ? "Pre-screen"
            : "Application screening",
          a.at,
        );
      else if (a.action === "pre-screen-release") log("Pre-screen", a.at);
      else if (["onsite-release", "invite_onsite"].includes(a.action)) log("Paper assessment", a.at);
      else if (a.action === "waive_paper") log("Mock teaching", a.at);
      else if (["head-decision", "mock-rubric-submitted", "final-review-packet"].includes(a.action)) {
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
    const signedAt =
      offer && p.signedDecision === offer.decisionId && p.confirmedSigned
        ? p.confirmedSigned.toISOString()
        : (offer?.uploadedAt ?? null);
    const done = signedAt && offer?.submittedAt;
    if (done) log(null, new Date(Math.max(Date.parse(signedAt!), Date.parse(done))));
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
    const reviews = [...paperReviews.values()];
    const pendingReview = reviews.find((r) => !r.decidedAt);
    if (stage === "Paper assessment" || stage === "Mock teaching") {
      if (pendingReview) stage = "Human review";
      else if (
        reviews.some((r) => r.passed) &&
        personBookings.some((b) => b.kind === "mock" && b.status === "confirmed")
      )
        stage = "Mock teaching";
    }
    // A historical pre-screen reply may predate its SEEK import. Import never restarts that wait.
    const intake = audits.find((a) => a.action === "source-import");
    if (intake && !events.some((e) => e.at <= +intake.at && e.stage !== "Application screening"))
      log("Application screening", intake.at);
    const stays = measureStays(events, stage, +now);
    // A candidate can have two papers with overlapping checks. Count that time only once.
    const intervals: { start: number; end: number }[] = [];
    for (const r of reviews) {
      if (!r.requestedAt) continue;
      const start = Date.parse(r.requestedAt),
        end = r.decidedAt ? Date.parse(r.decidedAt) : Infinity;
      const previous = intervals.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else intervals.push({ start, end });
    }
    const open = intervals.find((i) => i.end === Infinity);
    const since = stage === "Human review" ? (open ? new Date(open.start).toISOString() : null) : stays.since;
    const completed = stays.completed.filter((s) => s.stage !== "Human review");
    for (const i of intervals) {
      if (i.end <= +now && i.end >= +now - 84 * day)
        completed.push({ stage: "Human review", days: (i.end - i.start) / day });
    }
    for (const sample of completed) {
      const t = byStage.get(sample.stage)!;
      t.completed++;
      t.completedDays += sample.days;
    }
    const assignedSubjects = [
      ...new Set([
        ...p.subjects,
        ...(p.visitSubject ? [p.visitSubject] : []),
        ...reviews.map((r) => r.subject),
      ]),
    ];
    const subjects = assignedSubjects.length ? assignedSubjects : [...new Set(p.assessedSubjects)];
    if (p.seek) {
      const decision = audits.findLast((a) => a.action === "soft-reject");
      const scoreExit =
        decision || p.filteredAt || p.stage === "soft_rejected"
          ? {
              score: typeof decision?.detail.score === "number" ? decision.detail.score : null,
              cutoff: typeof decision?.detail.threshold === "number" ? decision.detail.threshold : null,
              held: p.stage === "soft_rejected",
              returned:
                p.stage !== "soft_rejected" &&
                (!!p.broughtBackAt ||
                  audits.some((a) => ["soft-reject-restore", "bring-back", "bring_back"].includes(a.action))),
            }
          : null;
      const entered = new Set(events.filter((e) => e.at <= +now).map((e) => e.stage));
      if (stage) entered.add(stage);
      const reached: Milestone[] = ["SEEK"];
      if (!scoreExit?.held) reached.push("Subjects");
      if (entered.has("HR call") || entered.has("Pre-screen") || p.answered) reached.push("Prescreen");
      if (!p.waiver && (entered.has("Paper assessment") || p.passAt || p.hasPaperScore || reviews.length))
        reached.push("Test");
      if (reviews.length) reached.push("Human review");
      if (
        p.hasInterviewScore ||
        (!pendingReview && entered.has("Mock teaching")) ||
        audits.some((a) => a.action === "mock-rubric-submitted")
      )
        reached.push("Interview");
      if (entered.has("Final review")) reached.push("Final review");
      if (offer?.emailStatus === "sent" && offer.sentAt && Date.parse(offer.sentAt) <= +now)
        reached.push("Offer letter");

      journeys.push({
        id: p.id,
        name: p.name,
        subjects: subjects.length ? subjects : ["Subject unknown"],
        reached,
        scoreExit,
        status: p.stage.replaceAll("_", " "),
        waived: !!p.waiver,
        signedAt,
        reviews,
      });
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
      appliedSubjects: subjects,
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
              : stage === "Human review" && pendingReview
                ? [
                    pendingReview.subject + " paper check",
                    pendingReview.initial === null ? null : pendingReview.initial + "%",
                    pendingReview.head || "Head unassigned",
                  ]
                    .filter(Boolean)
                    .join(" · ")
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
    journeys,
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
