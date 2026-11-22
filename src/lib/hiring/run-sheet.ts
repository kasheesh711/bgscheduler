import { formatInTimeZone } from "date-fns-tz";
import { localDate, practiceMarker, shiftDate, ZONE } from "@/lib/hiring/model";

// ─── Inputs: only fields already in the /api/hiring payload. Dates may arrive as JSON strings. ───

export interface RunSheetBooking {
  id: string;
  candidateId: string;
  kind: string;
  subjects: string[];
  interviewerKey: string | null;
  interviewerEmail?: string | null;
  startTime: Date | string;
  status: string;
  visitId: string | null;
}
export interface RunSheetInput {
  bookings: RunSheetBooking[];
  candidates: { id: string; name: string; sourceIds: string[]; visitSubject: string | null; stage?: string; updatedAt?: Date | string }[];
  config: {
    interviewers: { canonicalKey: string; subjects: string[]; email: string }[];
    paperPassRules: { subject: string }[];
  };
  library: { id: string; kind: string; subject: string | null; name: string; status?: string }[];
  tutors: { canonicalKey: string; name: string | null; email: string | null }[];
  now: Date;
}

export interface RunSheetHead {
  key: string;
  name: string;
  email: string | null;
  source: "booked" | "roster";
}
export interface RunSheetRow {
  visitId: string;
  /** Bangkok yyyy-MM-dd of the first booking in the visit. */
  date: string;
  /** Bangkok HH:mm, or null when the visit has no such part. */
  paperStart: string | null;
  mockStart: string | null;
  candidateId: string;
  candidateName: string;
  subject: string | null;
  hod: RunSheetHead | null;
  hodReason: string | null;
  paper: { id: string; name: string; markScheme: boolean } | null;
  paperReason: string | null;
  room: null;
  roomReason: string;
  status: string;
  /** Roster heads who take the subject. A paper-only visit shows to each of them. */
  subjectHeads: string[];
  issues: string[];
}

export const NO_ROOM = "Needs review: no room is booked for this visit";
export const NO_SUBJECT = "Needs review: no subject";
export const NO_MARK_SCHEME = "No mark scheme: marking cannot run";
export const NO_PASS_MARK = "No pass mark";
export const UNRECORDED_OWNER = "HR — record the visit or move the stage";
/** Stages that say a visit is booked (the old flow's paper_booked and mock_booked included). */
const VISIT_BOOKED_STAGES = ["onsite_booked", "paper_booked", "mock_booked"];
export const MOCK_ONLY = "Mock only: no paper sitting is booked";

const at = (value: Date | string) => new Date(value);
const time = (value: Date | string) => formatInTimeZone(at(value), ZONE, "HH:mm");

/** A head's display name: the tutor name, else the roster key. */
export function headName(key: string, tutors: RunSheetInput["tutors"]) {
  return tutors.find((t) => t.canonicalKey === key)?.name || key;
}

/**
 * One row per visit (paper and mock bookings grouped by visit id, else booking id), newest last.
 * Fail-closed: a missing head, paper or room is null with a "Needs review" reason, never a guess.
 */
export function buildRunSheet({ bookings, candidates, config, library, tutors }: RunSheetInput): RunSheetRow[] {
  const visits = new Map<string, RunSheetBooking[]>();
  for (const b of bookings) {
    if (b.kind !== "paper" && b.kind !== "mock") continue;
    const id = b.visitId ?? b.id;
    visits.set(id, [...(visits.get(id) ?? []), b]);
  }
  const ready = (kind: string, subject: string) =>
    library.find((f) => f.kind === kind && f.subject === subject && f.status === "ready");
  const rows: RunSheetRow[] = [];
  for (const [visitId, all] of visits) {
    // A visit with any confirmed part is confirmed; its cancelled parts are history.
    const confirmed = all.filter((b) => b.status === "confirmed");
    const parts = (confirmed.length ? confirmed : all).sort((a, b) => at(a.startTime).getTime() - at(b.startTime).getTime());
    const first = parts[0];
    const paperRow = parts.find((b) => b.kind === "paper");
    const mockRow = parts.find((b) => b.kind === "mock");
    const candidate = candidates.find((c) => c.id === first.candidateId);
    const subjects = [...new Set(parts.flatMap((b) => b.subjects).filter(Boolean))];
    const subject = subjects[0] ?? candidate?.visitSubject ?? null;
    const subjectHeads = subject ? config.interviewers.filter((h) => h.subjects.includes(subject)).map((h) => h.canonicalKey) : [];

    let hod: RunSheetHead | null = null;
    let hodReason: string | null = null;
    if (mockRow?.interviewerKey) {
      const key = mockRow.interviewerKey;
      const email = config.interviewers.find((h) => h.canonicalKey === key)?.email ?? mockRow.interviewerEmail ?? null;
      hod = { key, name: headName(key, tutors), email, source: "booked" };
    } else if (mockRow) hodReason = "Needs review: no head is booked for this mock";
    else if (!subject) hodReason = NO_SUBJECT;
    else if (subjectHeads.length === 1) {
      const head = config.interviewers.find((h) => h.canonicalKey === subjectHeads[0])!;
      hod = { key: head.canonicalKey, name: headName(head.canonicalKey, tutors), email: head.email, source: "roster" };
    } else
      hodReason = subjectHeads.length
        ? `Needs review: ${subjectHeads.length} heads take ${subject}`
        : `Needs review: no head takes ${subject}`;

    let paper: RunSheetRow["paper"] = null;
    let paperReason: string | null = null;
    const issues: string[] = [];
    // shortcut: one paper per visit; a multi-subject booking is flagged, not split. Split if such bookings return.
    if (subjects.length > 1) issues.push(`Needs review: ${subjects.length} subjects (${subjects.join(", ")}), only ${subject} is shown`);
    if (!paperRow) paperReason = MOCK_ONLY;
    else if (!subject) paperReason = NO_SUBJECT;
    else {
      const qp = ready("question_paper", subject);
      const markScheme = !!ready("mark_scheme", subject);
      if (qp) paper = { id: qp.id, name: qp.name, markScheme };
      else paperReason = `Needs review: no question paper for ${subject} in the paper library`;
      if (!markScheme) issues.push(NO_MARK_SCHEME);
      if (!config.paperPassRules.some((r) => r.subject === subject)) issues.push(NO_PASS_MARK);
    }

    rows.push({
      visitId,
      date: localDate(at(first.startTime)),
      paperStart: paperRow ? time(paperRow.startTime) : null,
      mockStart: mockRow ? time(mockRow.startTime) : null,
      candidateId: first.candidateId,
      candidateName: candidate?.name ?? "Needs review: candidate record not found",
      subject,
      hod,
      hodReason,
      paper,
      paperReason,
      // No room is stored for a hiring visit today (no column, no reservation link).
      room: null,
      roomReason: NO_ROOM,
      status: confirmed.length ? "confirmed" : first.status,
      subjectHeads,
      issues,
    });
  }
  return rows.sort((a, b) => (a.date + startOf(a)).localeCompare(b.date + startOf(b)));
}

export interface UnrecordedVisit {
  candidateId: string;
  candidateName: string;
  stage: string;
  subject: string | null;
  head: string;
  paper: string;
  owner: string;
}

/**
 * Fail-closed: candidates at a booked-visit stage with no confirmed visit booking. They have no date, so they stay out of every dated list and
 * count. Only candidates updated in the last 8 weeks, the same window pastVisits uses, so old stuck stages do not pile up.
 */
export function unrecordedVisits({ bookings, candidates, config, library, tutors, now }: RunSheetInput): UnrecordedVisit[] {
  const withBooking = new Set(bookings.filter((b) => (b.kind === "paper" || b.kind === "mock") && b.status === "confirmed").map((b) => b.candidateId));
  const since = at(now).getTime() - 56 * 86_400_000;
  return candidates
    .filter((c) => !practiceMarker(c) && c.stage && VISIT_BOOKED_STAGES.includes(c.stage) && !withBooking.has(c.id) && !(c.updatedAt && at(c.updatedAt).getTime() < since))
    .map((c) => {
      const subject = c.visitSubject ?? null;
      const heads = subject ? config.interviewers.filter((h) => h.subjects.includes(subject)).map((h) => headName(h.canonicalKey, tutors)) : [];
      const qp = subject && library.find((f) => f.kind === "question_paper" && f.subject === subject && f.status === "ready");
      return {
        candidateId: c.id,
        candidateName: c.name,
        stage: c.stage!,
        subject,
        head: !subject ? NO_SUBJECT : heads.length === 1 ? heads[0] : heads.length ? `Needs review: ${heads.length} heads take ${subject}` : `Needs review: no head takes ${subject}`,
        paper: !subject ? NO_SUBJECT : qp ? qp.name : `Needs review: no question paper for ${subject} in the paper library`,
        owner: UNRECORDED_OWNER,
      };
    });
}

/** The first time of the visit, HH:mm. */
export const startOf = (row: RunSheetRow) => [row.paperStart, row.mockStart].filter(Boolean).sort()[0] ?? "";

/** True when the head is missing, or a booked paper sitting has no paper. */
export const staffGap = (row: RunSheetRow) => !row.hod || (!row.paper && row.paperReason !== MOCK_ONLY);

/** True when a head, paper or room is missing. Room is always missing until rooms are stored. */
export const needsReview = (row: RunSheetRow) => staffGap(row) || !row.room;

/** Confirmed visits from `from` (yyyy-MM-dd) onward, in time order. */
export const upcoming = (rows: RunSheetRow[], from: string) => rows.filter((r) => r.status === "confirmed" && r.date >= from);

/** Visits in the 8 weeks before `today`, newest first. All statuses, so a no-show stays visible. */
export const pastVisits = (rows: RunSheetRow[], today: string) =>
  rows.filter((r) => r.date < today && r.date >= shiftDate(today, -56)).reverse();

/** The days Aya prints for: today, tomorrow, and the next 7 days that have a visit. */
export function printDays(rows: RunSheetRow[], today: string) {
  const end = shiftDate(today, 8);
  const dates = new Set([today, shiftDate(today, 1)]);
  for (const r of upcoming(rows, today)) if (r.date <= end) dates.add(r.date);
  return [...dates].sort();
}

/** One head's upcoming visits: their booked mocks and paper-only visits in their subjects. */
export const headVisits = (rows: RunSheetRow[], headKey: string, from: string) =>
  upcoming(rows, from).filter((r) => r.hod?.key === headKey || (!r.mockStart && r.subjectHeads.includes(headKey)));

const dayName = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeText = (r: RunSheetRow) =>
  [r.paperStart && `paper ${r.paperStart}`, r.mockStart && `mock ${r.mockStart}`].filter(Boolean).join(", ");

/** Preview only. The day's print list for Aya, from the run sheet. */
export function adminPrintListMessage(rows: RunSheetRow[], date: string) {
  const day = upcoming(rows, date).filter((r) => r.date === date);
  if (!day.length) return `Print list for ${dayName(date)}: no visits.`;
  const review = day.filter(needsReview).length;
  return [
    `Print list for ${dayName(date)}: ${day.length} visit${day.length === 1 ? "" : "s"}, ${review} need review.`,
    ...day.map(
      (r, i) =>
        `${i + 1}. ${timeText(r)}. ${r.candidateName}. ${r.subject ?? NO_SUBJECT}. Paper: ${r.paper?.name ?? r.paperReason}. Room: ${r.roomReason}.`,
    ),
  ].join("\n");
}

/** Preview only. A head's upcoming mocks and paper-only visits, from the run sheet. */
export function headUpcomingMessage(rows: RunSheetRow[], headKey: string, from: string, tutors: RunSheetInput["tutors"] = []) {
  const visits = headVisits(rows, headKey, from);
  const name = headName(headKey, tutors);
  if (!visits.length) return `${name}: no upcoming visits from ${dayName(from)}.`;
  return [
    `${name}: ${visits.length} upcoming visit${visits.length === 1 ? "" : "s"}.`,
    ...visits.map(
      (r, i) =>
        `${i + 1}. ${dayName(r.date)}, ${timeText(r)}. ${r.candidateName}. ${r.subject ?? NO_SUBJECT}. ${r.mockStart ? "You run the mock." : "Paper only: no mock."}`,
    ),
  ].join("\n");
}

/** Who must act to close each gap. */
export function gapOwner(reason: string) {
  if (reason === NO_ROOM) return "Kevin: decide where hiring visit rooms are stored";
  if (reason === NO_SUBJECT) return "HR: set the visit subject on the candidate";
  if (reason.includes("question paper") || reason === NO_MARK_SCHEME) return "Kevin: add the file in Rules and setup, Paper library";
  if (reason === NO_PASS_MARK) return "Kevin: set the pass mark in Rules and setup, Paper pass marks";
  if (reason.includes(" subjects (")) return "HR: book one subject per visit";
  if (reason.includes("head")) return "Kevin: set the heads in Rules and setup";
  return "HR: open the candidate record";
}

/** Replay counts: how many visits the run sheet can fully staff, and every gap by reason. */
export function replayRunSheet(rows: RunSheetRow[], unrecorded = 0) {
  const gaps: Record<string, number> = {};
  for (const r of rows)
    for (const reason of [r.hodReason, r.paperReason, r.roomReason, ...r.issues]) if (reason && reason !== MOCK_ONLY) gaps[reason] = (gaps[reason] ?? 0) + 1;
  return {
    visits: rows.length,
    unrecordedVisits: unrecorded,
    withHod: rows.filter((r) => r.hod).length,
    withPaper: rows.filter((r) => r.paper).length,
    withBoth: rows.filter((r) => r.hod && r.paper).length,
    withRoom: rows.filter((r) => r.room).length,
    gaps,
    owners: Object.fromEntries(Object.keys(gaps).map((g) => [g, gapOwner(g)])),
  };
}
