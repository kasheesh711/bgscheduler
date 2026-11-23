/**
 * Demo mode for /hiring (`?demo=1`): one made-up candidate goes through every step, in the browser only.
 * `demoFetch` answers every `/api/hiring` request from memory, so nothing is read from or written to the database and
 * no message is sent. Kevin asked for this on 23 Nov 2026, to present the process to the heads, Gift and admin.
 *
 * shortcut: the payload is built by hand and cast to the dashboard type, so a new payload field does not fail the
 * build here. demo.test.ts runs every step through the screens' own builders; upgrade to a typed fixture if it drifts.
 */
import { baseConfigSchema, type Subject } from "./model";
import { OFFER_LETTERS, type OfferType } from "./offer-letters";
import { ITEM_MAX, RUBRIC_ITEMS, type MockRubric } from "./marking-sheet";

export const DEMO_ID = "00000000-0000-4000-8000-00000000d001";
const PAPER_ID = "00000000-0000-4000-8000-00000000d002";
const MOCK_ID = "00000000-0000-4000-8000-00000000d003";
const VISIT_ID = "00000000-0000-4000-8000-00000000d004";
const RESULT_ID = "00000000-0000-4000-8000-00000000d005";
const DECISION_ID = "00000000-0000-4000-8000-00000000d006";
const NAME = "Demo – Nicha Suwan";
const SUBJECT: Subject = "Mathematics";
const HEAD = "Peat";
export const DEMO_BRIEF_PATH = "/hiring/brief/demo";
/** Every subject a made-up candidate has, so no card warns about a missing paper or pass mark. */
const SUBJECTS_SHOWN: Subject[] = ["Mathematics", "Physics", "Chemistry", "Biology", "English Language", "Economics"];

/** The steps, in the order Kevin presents them. `view` is the Hiring screen that shows the step. */
export const DEMO_STEPS = [
  { key: "apply", title: "Application and ATS score", view: "seek", who: "System", say: "The candidate applied on SEEK. The system read the résumé and gave a score. A high score gets a link to book the HR call.", act: "Find the demo candidate in the list. Then select Next." },
  { key: "call", title: "HR call", view: "hr", who: "HR", say: "The candidate booked a 30-minute call. HR speaks to the candidate, writes notes and records the result.", act: "Select Good call on the demo candidate." },
  { key: "form", title: "Next steps email", view: "prescreen", who: "Candidate", say: "One email went to the candidate: the questions form and the link to book the onsite visit.", act: "Select Next: the candidate answers the form and books a visit." },
  { key: "prepare", title: "Admin prepares the paper test", view: "admin", who: "Admin", say: "The visit is booked for tomorrow. Admin sees who comes, at what time, and prints the paper.", act: "Show the visit card. Then select Next: it is now the visit day." },
  { key: "paper", title: "Paper test", view: "admin", who: "Admin", say: "The candidate did the paper. Admin scans it and uploads the PDF. The system marks it in 5 to 10 minutes.", act: "Select Upload the completed paper and choose a PDF, or select Next." },
  { key: "mock", title: "Mock teaching", view: "heads", who: "Head teacher", say: "The candidate passed, so the mock lesson took place. The head opens the candidate page, gives the scores and says Yes or No.", act: "Choose Kru Peat. Open the candidate page, send the scores, then select Yes." },
  { key: "review", title: "Final review", view: "review", who: "HR, then Gift", say: "HR writes the behaviour notes and selects the standard offer letter, then sends the packet to Gift. Gift reads the packet and approves or rejects.", act: "Select Open final review. Select the offer letter, preview the packet, then select Send to Gift." },
  { key: "offer", title: "Offer and signing", view: "offer", who: "Candidate and HR", say: "The offer email went to the candidate with a link to book a 30-minute signing at the school.", act: "Show the approved offer. The demo ends here." },
] as const;

type DemoState = {
  step: number;
  marked: boolean;
  rubric: MockRubric | null;
  packet: { id: string; behavioral: string; offer: string; offerType?: OfferType } | null;
  notes: { text: string; at: string; by: string } | null;
  closed: "rejected" | "stopped" | null;
  /** The head's reason, when one was typed. */
  reason: string;
};
const START: DemoState = { step: 0, marked: false, rubric: null, packet: null, notes: null, closed: null, reason: "" };
let state: DemoState = START;
const listeners = new Set<() => void>();

export const demoState = () => state;
export function subscribeDemo(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function set(patch: Partial<DemoState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
/** Go to a step. Work inside a later step is cleared, so each step starts as the presenter expects. */
export function setDemoStep(step: number) {
  const next = Math.max(0, Math.min(DEMO_STEPS.length - 1, step));
  set({
    step: next,
    closed: null,
    marked: next > 4,
    rubric: next > 5 ? fullRubric() : null,
    packet: next > 6 ? { id: "demo-packet", behavioral: BEHAVIORAL, offer: OFFER, offerType: "part_time" as OfferType } : null,
  });
}
export const resetDemo = () => set(START);
/** The upload button in demo mode: the demo candidate's paper shows as uploaded and marked. No file is read. */
export const markDemoPaper = () => state.step === 4 && set({ marked: true });

const BEHAVIORAL = "Calm and clear on the call. Gave a specific example of how she changed a lesson for a weak student.";
const OFFER = OFFER_LETTERS.part_time.text(NAME, "Mathematics");
const fullRubric = (): MockRubric => ({
  items: Object.fromEntries(RUBRIC_ITEMS.map((id, index) => [id, index % 3 ? 10 : 7])) as MockRubric["items"],
  comments: "Clear explanations. Checked understanding often.",
  stressTest: { listens: true, explains: true, plan: true },
  checksDone: true,
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Bangkok clock time `days` from today. */
function at(now: Date, days: number, hour: number, minute = 0) {
  const local = new Date(now.getTime() + 7 * HOUR + days * DAY);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour - 7, minute));
}
/** The nearest half hour that `minutes` ago gives, so a time on a card reads like a real booking. */
const ago = (now: Date, minutes: number) => new Date(Math.floor((now.getTime() - minutes * 60_000) / 1_800_000) * 1_800_000);

const assessment = (summary: string, subject: Subject) => ({
  summary,
  briefSummary: summary,
  subjects: [{ subject, relevant: true, evidence: "Taught IGCSE for 3 years", reason: "Named in the résumé" }],
  criteria: ["degree", "subject", "curriculum", "teaching", "english"].map((id) => ({
    id, result: "met", evidence: "Taught IGCSE for 3 years", reason: "Seen in the résumé", brief: "Clear evidence",
  })),
});
const answers = {
  sourceRow: 2, submittedAt: "", degree: "Bachelor's", field: "Mathematics", subjects: "Mathematics", curricula: "IGCSE, A-Level",
  yearGroups: "Year 9 to Year 13", english: "Advanced (C1)", englishEvidence: "IELTS 7.5", experience: "3–5 years", portfolio: "",
  availability: "Weekday evenings, Saturday and Sunday", weeklyHours: "15",
  motivation: "I like to see a student understand a hard idea for the first time.",
  teachingApproach: "A worked example first. Then the student tries one and explains each step to me.",
};
const parts = { degree: 10, subject: 12, curriculum: 10, teaching: 12, english: 10, prestige: 8, written: 12, availability: 10, total: 84 };

function person(now: Date, id: string, name: string, subject: Subject, patch: Record<string, unknown> = {}) {
  return {
    id, name, email: `${id.slice(-4)}@example.test`, phone: "080 000 0000", stage: "new", seekApplicationId: `demo-${id.slice(-4)}`, seekJobId: "90000001",
    sourceIds: [], applicantId: null, trackerHash: null, previouslyContacted: false, visitSubject: null, subjects: [subject],
    inviteExpiresAt: null, reviewNote: null, revision: 1, createdAt: new Date(now.getTime() - 9 * DAY), updatedAt: new Date(now.getTime() - DAY),
    workRightsAnswer: "I am a Thai citizen", workRightsAccepted: true, workRightsPenalty: 0, resumeName: "resume.pdf", resumeType: "application/pdf",
    resumeSize: 1000, resumeStoredAt: new Date(now.getTime() - 9 * DAY), resumeState: "available", profileHash: "demo",
    profileAssessment: assessment("Degree and subject match. Three years of IGCSE teaching.", subject),
    universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] },
    preScreen: null, preScreenHash: null, preScreenAssessment: null, preScreenRepliedAt: null, preScreenResubmitted: false, preScreenScore: null,
    preScreenParts: null, preScreenOverride: null, paperPassedSubjects: [], paperPassedAt: null, paperRecordedBy: null, hasSourceText: true,
    profileScore: 80, queueManual: false, callReview: null, callInvited: false, ...patch,
  };
}
const replied = (now: Date, days: number) => ({
  preScreen: answers, preScreenHash: "demo", preScreenAssessment: { ...assessment("Clear and specific answers.", SUBJECT), universities: [] },
  preScreenRepliedAt: new Date(now.getTime() - days * DAY), preScreenScore: 84, preScreenParts: parts,
});
const sent = (candidateId: string, key: string, at: Date, workflowStage: string | null = null) => ({
  id: `${candidateId}:${key}`, key: `${candidateId}:${key}`, candidateId, kind: "email", status: "sent", error: null, sentAt: at, workflowStage,
});
function visit(candidateId: string, ids: [string, string, string], start: Date, head: string, subject: Subject, created: Date) {
  const base = { candidateId, status: "confirmed", visitId: ids[2], subjects: [subject], interviewerEmail: null, lineGroupId: null, calendarOwner: "demo@example.test", rescheduleOf: null, evidence: {}, createdAt: created };
  return [
    { ...base, id: ids[0], kind: "paper", interviewerKey: null, startTime: start, endTime: new Date(start.getTime() + 2 * HOUR) },
    { ...base, id: ids[1], kind: "mock", interviewerKey: head, startTime: new Date(start.getTime() + 2.25 * HOUR), endTime: new Date(start.getTime() + 3.25 * HOUR) },
  ];
}
const questions = (level: string, marks: number[]) =>
  marks.map((value, index) => ({ id: `${level[0]}${index + 1}`, level, marks: value, max: 10, reason: "Correct method", attempted: true, readable: true }));
const result = (now: Date, id: string, candidateId: string, bookingId: string, subject: Subject, patch: Record<string, unknown>) => ({
  id, candidateId, bookingId, subject, source: "ai", status: "done", fileId: null, history: null, model: null, promptVersion: null, costUsd: null, costKnown: true,
  error: null, checkedBy: null, checkedAt: null, changedBy: null, changedAt: null, createdAt: now, updatedAt: now, stuck: false, ...patch,
});

/** Other made-up candidates, so the lists and the pipeline board are not empty. `n` makes the ids. */
function others(now: Date) {
  const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
  const good = (days: number) => ({ good: { at: new Date(now.getTime() - days * DAY).toISOString(), by: "hr@example.test" }, tries: [] });
  const candidates = [
    person(now, id(1), "Sample Anan", "Physics", { profileScore: 91, callInvited: true }),
    person(now, id(2), "Sample Benja", "Chemistry", { profileScore: 86, callInvited: true }),
    person(now, id(3), "Sample Chai", "Mathematics", { profileScore: 72 }),
    person(now, id(4), "Sample Dao", "Biology", { stage: "pre_screen", profileScore: 88, callReview: good(6) }),
    person(now, id(5), "Sample Fah", "Physics", { stage: "pre_screen", profileScore: 83, callReview: good(2) }),
    person(now, id(6), "Sample Kan", "Chemistry", { stage: "onsite_invited", profileScore: 90, callReview: good(12), ...replied(now, 9) }),
    person(now, id(7), "Sample Lek", "Physics", { stage: "onsite_booked", profileScore: 85, callReview: good(8), visitSubject: "Physics", ...replied(now, 5) }),
    person(now, id(8), "Sample Mali", "English Language", { stage: "onsite_booked", profileScore: 82, callReview: good(15), visitSubject: "English Language", ...replied(now, 11) }),
    person(now, id(9), "Sample Nok", "Chemistry", { stage: "onsite_booked", profileScore: 93, callReview: good(14), visitSubject: "Chemistry", ...replied(now, 10) }),
    person(now, id(10), "Sample Ploy", "Biology", { stage: "hired", profileScore: 89, callReview: good(20), visitSubject: "Biology", ...replied(now, 16) }),
    person(now, id(11), "Sample Rin", "Economics", { stage: "rejected", profileScore: 81, callReview: good(18), ...replied(now, 15) }),
  ];
  const bookings = [
    ...visit(id(7), [id(21), id(22), id(23)], at(now, 2, 10), "Ek", "Physics", new Date(now.getTime() - 3 * DAY)),
    ...visit(id(8), [id(24), id(25), id(26)], at(now, -5, 10), "Tito", "English Language", new Date(now.getTime() - 9 * DAY)),
    ...visit(id(9), [id(27), id(28), id(29)], at(now, -2, 11), "Mimi", "Chemistry", new Date(now.getTime() - 7 * DAY)),
    ...visit(id(10), [id(30), id(31), id(32)], at(now, -6, 10), "Gift", "Biology", new Date(now.getTime() - 12 * DAY)),
  ];
  return {
    candidates,
    bookings,
    calls: [
      { candidateId: id(1), start: at(now, 0, 16, 30), end: at(now, 0, 17) },
      { candidateId: id(2), start: at(now, 1, 11), end: at(now, 1, 11, 30) },
    ],
    callOrder: [id(1), id(2)],
    outbox: [
      sent(id(1), "call-invite", new Date(now.getTime() - 2 * DAY)), sent(id(2), "call-invite", new Date(now.getTime() - DAY)),
      sent(id(4), "pre-screen", new Date(now.getTime() - 6 * DAY), "pre_screen"), sent(id(5), "pre-screen", new Date(now.getTime() - 2 * DAY), "pre_screen"),
      sent(id(6), "pre-screen", new Date(now.getTime() - 12 * DAY), "pre_screen"), sent(id(6), "visit-invite", new Date(now.getTime() - 9 * DAY), "onsite_invited"),
      sent(id(10), "result:approved", new Date(now.getTime() - 2 * DAY)),
    ],
    papers: [
      result(now, id(41), id(9), id(27), "Chemistry", { marks: { missingPages: null, comment: "Strong on organic chemistry.", questions: [...questions("IGCSE / GCSE", [9, 9]), ...questions("AS / A-Level", [8, 9])] }, markSchemeUsed: true }),
      result(now, id(42), id(10), id(30), "Biology", { marks: { missingPages: null, comment: "Accurate and complete.", questions: [...questions("IGCSE / GCSE", [9, 10]), ...questions("AS / A-Level", [9, 8])] }, markSchemeUsed: true }),
    ],
    mocks: [
      result(now, id(43), id(9), id(28), "Chemistry", { source: "person", rubric: fullRubric() }),
      result(now, id(44), id(10), id(31), "Biology", { source: "person", rubric: fullRubric() }),
    ],
    headDecisions: [
      { candidateId: id(9), bookingId: id(28), decision: "hire", reason: "Clear and warm lesson.", head: "Kru Mimi", draftProblem: null, at: new Date(now.getTime() - 2 * DAY + 3 * HOUR) },
      { candidateId: id(10), bookingId: id(31), decision: "hire", reason: "Excellent subject knowledge.", head: "Gift", draftProblem: null, at: new Date(now.getTime() - 6 * DAY + 4 * HOUR) },
    ],
    decisions: [
      { id: id(51), candidateId: id(10), decision: "hire", status: "sent", reason: "Approved", emailSubject: "Your BeGifted offer", emailBody: "", outboxKey: `${id(10)}:result:approved`, decidedBy: "gift@example.test", createdAt: new Date(now.getTime() - 2 * DAY), sentAt: new Date(now.getTime() - 2 * DAY) },
    ],
  };
}

/** The whole dashboard payload for the current demo state. The caller casts it to the dashboard type. */
export function demoPayload(now = new Date()) {
  const { step, marked, rubric, packet, notes, closed } = state;
  const other = others(now);
  const good = step > 1;
  const booked = step > 2;
  const callStart = ago(now, 20);
  // Step 3: the visit is tomorrow. Step 4: the paper has ended and the mock runs. Later: the mock has ended.
  const paperStart = step === 3 ? at(now, 1, 10) : step === 4 ? ago(now, 180) : ago(now, 270);
  const decided = step > 5 && !closed;
  const hired = step > 6 && !closed;
  const stage = closed ?? (hired ? "hired" : booked ? "onsite_booked" : good ? "pre_screen" : "new");
  const candidate = person(now, DEMO_ID, NAME, SUBJECT, {
    stage, profileScore: 88, callInvited: true, phone: "081 234 5678",
    callReview: { good: good ? { at: new Date(now.getTime() - 3 * HOUR).toISOString(), by: "hr@example.test" } : null, tries: [], ...(notes ? { notes } : {}) },
    visitSubject: booked ? SUBJECT : null,
    inviteExpiresAt: good ? new Date(now.getTime() + 14 * DAY) : null,
    ...(booked ? replied(now, 0.1) : {}),
  });
  const visitRows = booked ? visit(DEMO_ID, [PAPER_ID, MOCK_ID, VISIT_ID], paperStart, HEAD, SUBJECT, new Date(now.getTime() - 2 * HOUR)) : [];
  const interviewers = [
    { canonicalKey: "Peat", email: "peat@example.test", subjects: ["Mathematics", "Physics"] },
    { canonicalKey: "Ek", email: "ek@example.test", subjects: ["Physics"] },
    { canonicalKey: "Mimi", email: "mimi@example.test", subjects: ["Chemistry"] },
    { canonicalKey: "Tito", email: "tito@example.test", subjects: ["English Language"] },
    { canonicalKey: "Gift", email: "gift@example.test", subjects: ["Biology", "Economics"] },
  ];
  const levels = ["IGCSE / GCSE", "AS / A-Level"];
  const config = baseConfigSchema.parse({
    // Both on, so the demo buttons are not blocked by a switch. Nothing can leave: demoFetch answers every request.
    enabled: true, deliveryEnabled: true, connectedEmail: "demo@example.test", profileThreshold: 60, callThreshold: 80, preScreenThreshold: 50, acceptedWorkRights: ["I am a Thai citizen"],
    seekJobs: [{ jobId: "90000001", label: "Demo tutor ad", active: true }], interviewers,
    paperPassRules: SUBJECTS_SHOWN.flatMap((subject) => levels.map((level) => ({ subject, level, percent: 80 }))),
  });
  const outbox = [
    ...other.outbox,
    sent(DEMO_ID, "call-invite", new Date(now.getTime() - DAY)),
    ...(good ? [sent(DEMO_ID, "pre-screen", new Date(now.getTime() - 3 * HOUR), "pre_screen")] : []),
    ...(hired ? [sent(DEMO_ID, "result:approved", now)] : []),
  ];
  const file = (n: number, kind: string, subject: Subject) => ({ id: `00000000-0000-4000-8000-00000000f${String(n).padStart(3, "0")}`, kind, subject, name: `${subject} ${kind === "question_paper" ? "paper" : "mark scheme"}.pdf`, status: "ready", createdAt: new Date(now.getTime() - 30 * DAY) });
  return {
    config, configSaved: true, configProblems: [], revision: 1, workerAt: new Date(now.getTime() - 5 * 60_000), workerError: null, writeGate: true,
    workerSummary: { scanned: 140, imported: 3, remaining: 0, folders: [{ status: "Inbox", count: 140, imported: 140 }] },
    usage: { preScreen: { perDay: 2, perWeek: 6, waiting: 1, unbooked: 2, bySubject: {} }, onsite: { perDay: 1, perWeek: 3, waiting: 0, unbooked: 1, bySubject: {} } },
    holds: {}, preScreenOrder: [], callOrder: good || closed ? other.callOrder : [DEMO_ID, ...other.callOrder],
    headMocks: {}, heads: {},
    candidates: [candidate, ...other.candidates],
    bookings: [...visitRows, ...other.bookings],
    calls: [...(step === 1 && !closed ? [{ candidateId: DEMO_ID, start: callStart, end: new Date(callStart.getTime() + HOUR / 2) }] : []), ...other.calls],
    missedCalls: [],
    headDecisions: [
      ...(decided ? [{ candidateId: DEMO_ID, bookingId: MOCK_ID, decision: "hire", reason: state.reason || "Clear and well-paced lesson.", head: "Kru Peat", draftProblem: null, at: now }] : []),
      ...other.headDecisions,
    ],
    briefPaths: booked ? { [MOCK_ID]: DEMO_BRIEF_PATH } : {},
    visitClashes: { candidateIds: [], stale: false, clashes: {} },
    outbox, inviteOutbox: outbox, audit: [],
    funnelEvents: [
      { candidateId: DEMO_ID, action: "call-booked", at: new Date(now.getTime() - 20 * HOUR) },
      ...other.calls.map((call) => ({ candidateId: call.candidateId, action: "call-booked", at: new Date(now.getTime() - DAY) })),
    ],
    papers: [
      ...(booked && (marked || step > 4) ? [result(now, RESULT_ID, DEMO_ID, PAPER_ID, SUBJECT, { markSchemeUsed: true, marks: { missingPages: null, comment: "Strong algebra and calculus. One slip in vectors.", questions: [...questions("IGCSE / GCSE", [9, 10, 9]), ...questions("AS / A-Level", [8, 9, 8])] } })] : []),
      ...other.papers,
    ],
    mocks: [
      ...(rubric ? [result(now, "00000000-0000-4000-8000-00000000d007", DEMO_ID, MOCK_ID, SUBJECT, { source: "person", rubric })] : []),
      ...other.mocks,
    ],
    decisions: [
      ...(hired ? [{ id: DECISION_ID, candidateId: DEMO_ID, decision: "hire", status: "sent", reason: "Approved", emailSubject: "Your BeGifted offer", emailBody: "", outboxKey: `${DEMO_ID}:result:approved`, decidedBy: "gift@example.test", createdAt: now, sentAt: now }] : []),
      ...other.decisions,
    ],
    library: SUBJECTS_SHOWN.flatMap((subject, index) => [file(index * 2, "question_paper", subject), file(index * 2 + 1, "mark_scheme", subject)]),
    markingSpend: { usd: 0, complete: true },
    tutors: interviewers.map((head) => ({ canonicalKey: head.canonicalKey, name: head.canonicalKey === "Gift" ? "Gift" : `Kru ${head.canonicalKey}`, email: head.email, lineReady: true })),
    // HR's screen first. After HR sends the packet, the same step shows Gift's screen.
    reviewAccess: step === 6 && packet ? { hr: false, gift: true } : { hr: true, gift: false },
    google: { connected: true, email: "demo@example.test", lastError: null, callCalendar: "readable" },
  };
}

/** What the head's candidate page shows for the demo mock. */
export function demoBrief(now = new Date()) {
  const paperStart = ago(now, 270);
  const clock = (date: Date) => new Date(date.getTime() + 7 * HOUR).toISOString().slice(11, 16);
  const day = new Date(paperStart.getTime() + 7 * HOUR).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const mockStart = new Date(paperStart.getTime() + 2.25 * HOUR);
  return {
    decision: state.step > 5 ? ("hire" as const) : null,
    name: NAME, subject: SUBJECT, gradedPaper: true,
    exam: `${day}, ${clock(paperStart)}–${clock(new Date(paperStart.getTime() + 2 * HOUR))}`,
    mock: `${day}, ${clock(mockStart)}–${clock(new Date(mockStart.getTime() + HOUR))}`,
    interviewer: HEAD, location: "BeGifted Education", answers: { ...answers, sourceRow: 0, submittedAt: "" }, resume: "pdf" as const,
    rubric: state.rubric, form: "open" as const, recommendationReady: !!state.rubric, recommendationBlock: null,
  };
}

/** A one-page PDF with a few lines of text. Enough for the résumé and paper viewers. */
export function demoPdf(title: string, lines: string[]) {
  const text = [title, "", ...lines, "", "Demo file. Not a real document."]
    .map((line, index) => `${index ? "0 -22 Td " : ""}(${line.replace(/[^\x20-\x7e]/g, "-").replace(/[\\()]/g, "\\$&")}) Tj`).join("\n");
  const stream = `BT /F1 14 Tf 60 760 Td\n${text}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}
/** The demo file for a hiring file link: the résumé, or the paper. */
export const demoFile = (path: string) =>
  /resume/.test(path)
    ? demoPdf("Nicha Suwan - Mathematics tutor", ["BSc Mathematics, Chulalongkorn University", "3 years: IGCSE and A-Level Mathematics tutor", "IELTS 7.5", "Available: weekday evenings and weekends"])
    : demoPdf("Mathematics paper test", ["Section A: IGCSE", "Section B: AS and A-Level", "Time allowed: 2 hours"]);

const packetHtml = (packet = state.packet) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hiring review | ${NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:32px auto;max-width:720px;color:#1c2a3a}h1{font-size:28px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #cfe0f0;padding-bottom:4px}dt{color:#5b6b7b;font-size:13px}dd{margin:0 0 10px}</style></head>
<body><h1>${NAME}</h1><p>Mathematics · Demo packet. Every value is made up.</p>
<h2>Scores</h2><dl><dt>ATS (application)</dt><dd>88 / 100</dd><dt>Paper test</dt><dd>53 / 60 (88%). Pass mark 80%.</dd><dt>Mock teaching (Kru Peat)</dt><dd>${state.rubric ? Object.values(state.rubric.items).reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0} / ${RUBRIC_ITEMS.length * ITEM_MAX}. Recommendation: Yes.</dd></dl>
<h2>HR behavioural assessment</h2><p>${escapeHtml(packet?.behavioral ?? "")}</p>
<h2>Proposed offer</h2><p style="white-space:pre-wrap">${escapeHtml(packet?.offer ?? "")}</p>
<h2>Files</h2><p>The real packet holds the original résumé and the marked paper.</p></body></html>`;
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const NOT_IN_DEMO = "This part is not in the demo.";

/**
 * Answers a request in demo mode. `null` means the request is not a hiring request, or is one of the two read-only
 * ones the demo lets through (the Capacity tab and the PDF viewer's own script files).
 * Every other `/api/hiring` request gets an answer here, so none reaches the server.
 */
export function demoFetch(input: string, init?: { method?: string; body?: unknown }): Response | null {
  const url = new URL(input, "https://demo.invalid");
  const path = url.pathname;
  if (!path.startsWith("/api/hiring")) return null;
  const post = init?.method?.toUpperCase() === "POST";
  if (!post && (path.startsWith("/api/hiring/pdf-runtime/") || (path === "/api/hiring" && url.searchParams.has("capacity")))) return null;
  const body = post && typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const mine = body.id === DEMO_ID || body.candidateId === DEMO_ID;

  if (path === "/api/hiring" && !post) {
    if (url.searchParams.has("candidateId"))
      return json({ id: url.searchParams.get("candidateId"), profileText: "Demo profile text. The real tool shows the text that the system read from SEEK and the résumé." });
    if (url.searchParams.has("head")) return json({ error: NOT_IN_DEMO }, 503);
    return json(demoPayload());
  }
  if (path === "/api/hiring") {
    const action = body.action;
    if (action === "call_notes") {
      const notes = { text: String(body.text ?? ""), at: new Date().toISOString(), by: "demo" };
      if (mine) set({ notes });
      return json({ ok: true, notes });
    }
    if (action === "call_result" && mine && body.result === "good" && state.step === 1) set({ step: 2 });
    if (action === "stop" && mine) set({ closed: "stopped" });
    // The demo bar handles the upload button before a file is chosen, so no file can reach storage.
    if (action === "file_intent" || action === "file_ready") return json({ error: NOT_IN_DEMO }, 409);
    return json({ ok: true });
  }
  if (path === "/api/hiring/marking") return json({ status: "done", error: null });
  if (path === "/api/hiring/brief/demo/rubric" && post) {
    const items = (body.items ?? {}) as MockRubric["items"];
    set({ rubric: { items, comments: String(body.comments ?? ""), stressTest: body.stressTest as MockRubric["stressTest"], checksDone: body.checksDone as boolean } });
    return json({ total: Object.values(items).reduce<number>((sum, value) => sum + (value ?? 0), 0) });
  }
  if (path === "/api/hiring/brief/demo/decision" && post) {
    if (body.decision === "hire") set({ step: 6, reason: String(body.reason ?? "") });
    else set({ closed: "rejected" });
    return json({ ok: true });
  }
  if (path === `/api/hiring/review/${DEMO_ID}`) {
    if (post) {
      const offerType: OfferType = typeof body.offerType === "string" && body.offerType in OFFER_LETTERS ? (body.offerType as OfferType) : "part_time";
      const draft = { id: `demo-packet-${Date.now()}`, behavioral: String(body.behavioral ?? ""), offer: OFFER_LETTERS[offerType].text(NAME, "Mathematics"), offerType };
      if (body.action === "preview") return new Response(packetHtml(draft), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (body.action === "submit") set({ packet: draft });
      else if (body.decision === "hire") set({ step: 7 });
      else set({ closed: "rejected" });
      return json({ ok: true });
    }
    if (url.searchParams.get("file") === "html") return new Response(packetHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.searchParams.has("file")) return new Response(demoFile(url.searchParams.get("file") ?? ""), { headers: { "Content-Type": "application/pdf" } });
    const payload = demoPayload();
    return json({
      access: payload.reviewAccess, stage: payload.candidates[0].stage, callNotes: state.notes?.text ?? BEHAVIORAL,
      packet: state.packet, packetValid: state.packet ? true : null,
      appointment: state.step > 6 ? at(new Date(), 2, 10).toISOString() : null,
    });
  }
  if (path === "/api/hiring/contracts") {
    if (post) return json({ error: NOT_IN_DEMO }, 409);
    const type = url.searchParams.get("type");
    if (type) return new Response(demoPdf(`${type.replace("_", "-")} tutor agreement`, ["Demo template. The real file is the blank contract."]), { headers: { "Content-Type": "application/pdf" } });
    return json({ templates: Object.keys(OFFER_LETTERS).map((type) => ({ type, format: "pdf", size: 1000, uploadedAt: new Date().toISOString() })) });
  }
  if (path.startsWith("/api/hiring/review/")) {
    if (post) return json({ error: "The demo signs off only the demo candidate." }, 409);
    const payload = demoPayload();
    const hired = payload.candidates.some((candidate) => candidate.id === path.split("/").pop() && candidate.stage === "hired");
    return json({ access: payload.reviewAccess, stage: hired ? "hired" : "onsite_booked", callNotes: "", packet: null, packetValid: null, appointment: hired ? at(new Date(), 3, 14).toISOString() : null });
  }
  if (/^\/api\/hiring\/(resume|file|marked)\/|^\/api\/hiring\/brief\/demo\/(resume|paper)$/.test(path))
    return new Response(demoFile(path), { headers: { "Content-Type": "application/pdf" } });
  return json({ error: NOT_IN_DEMO }, 503);
}

let installed = false;
/** True once this page answers hiring requests itself. Only a page load ends that. */
export const demoFetchInstalled = () => installed;
/** Puts `demoFetch` in front of `window.fetch`, once. Only the demo page calls this, and a reload removes it. */
export function installDemoFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return demoFetch(new URL(target, window.location.origin).href, init as { method?: string; body?: unknown }) ?? real(input, init);
  };
}
