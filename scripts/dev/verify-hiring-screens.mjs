#!/usr/bin/env node
// Offline, synthetic acceptance checks of the real hiring screens in Chrome. This is not an app route or auth bypass.
// No candidate data, vendor connection, production database or credentials are used: the fixture below replaces fetch.
// Run: node scripts/dev/verify-hiring-screens.mjs [screenshot-folder]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, webkit } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2];
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BRIEF_STATES = [
  ["wait", "Scores open after the mock.", "Check again"],
  ["checking", "Scores are being checked.", "Check again"],
  ["admin", "Ask BeGifted admin to check the scores.", null],
  ["closed", "Scores are recorded. Ask admin to edit scores.", "Yes, send to HR"],
];

const ENTRY = `
// ?persist=1 keeps the whole sample query for the tab, as a signed-in head keeps their session across links.
try {
  if (location.search.includes("persist=1")) sessionStorage.setItem("fixture:query", location.search.slice(1));
  else if (!location.search.includes("roles=") && !location.pathname.startsWith("/hiring/brief/") && !location.pathname.startsWith("/hiring/paper-check/") && sessionStorage.getItem("fixture:query"))
    history.replaceState(null, "", "?" + sessionStorage.getItem("fixture:query"));
} catch {}
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { baseConfigSchema, localDate } from "@/lib/hiring/model";
import { HiringDashboard } from "@/components/hiring/dashboard";
import { HiringStaffPreview } from "@/components/hiring/staff-preview";
import { BookingShell } from "@/components/hiring/booking";
import { BriefShell, InterviewerBrief, ScheduleLink } from "@/components/hiring/brief";
import { PaperCheck } from "@/components/hiring/paper-check";
import { OFFER_LETTERS } from "@/lib/hiring/offer-letters";

const assessment = (summary: string) => ({
  summary, briefSummary: summary, subjects: [{ subject: "Mathematics", relevant: true, evidence: "Taught IGCSE", reason: "Named in the resume" }],
  criteria: ["degree", "subject", "curriculum", "teaching", "english"].map((id) => ({ id, result: "met", evidence: "Taught IGCSE for 2 years", reason: "Seen in the resume", brief: "Clear evidence" })),
});
const person = (id: string, name: string, patch = {}) => ({
  id, name, email: id + "@example.test", stage: "new", seekApplicationId: "seek-" + id, seekJobId: "123456", sourceIds: [], applicantId: null, trackerHash: null,
  previouslyContacted: false, visitSubject: null, subjects: ["Mathematics"], inviteExpiresAt: null, reviewNote: null, revision: 1,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", workRightsAnswer: "I am a Thai citizen", workRightsAccepted: true,
  resumeName: null, resumeType: "application/pdf", resumeSize: 1000, resumeStoredAt: "2026-10-20T00:00:00Z", resumeState: "available",
  profileHash: "h", profileAssessment: assessment("Degree and subject match."), universityAssessment: { name: "Mahidol University", country: "Thailand", fraction: 0.8, reason: "On the reference list", sources: [] },
  preScreen: null, preScreenHash: null, preScreenAssessment: null, preScreenRepliedAt: null, preScreenResubmitted: false, preScreenScore: null, preScreenParts: null,
  paperPassedSubjects: [], paperPassedAt: null, paperRecordedBy: null, hasSourceText: true, profileScore: 86, queueManual: false, preScreenOverride: null as unknown, ...patch,
});
const answers = {
  sourceRow: 2, submittedAt: "1/11/2026, 05:00:00", degree: "Bachelor's", field: "Mathematics", subjects: "Mathematics", curricula: "IGCSE", yearGroups: "Year 10", english: "Advanced (C1)", englishEvidence: "",
  experience: "5+ years", portfolio: "", availability: "Weekend Morning", weeklyHours: "20", motivation: "I like teaching.", teachingApproach: "Worked examples, then the student tries one.",
};
const parts = { degree: 10, subject: 10, curriculum: 10, teaching: 10, english: 10, prestige: 10, written: 12, availability: 10, total: 82 };
const candidates = [
  person("a", "Sample Ann"),
  person("b", "Sample Ben", { profileScore: 91, universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("c", "Sample Cho", { profileScore: 74, subjects: ["Physics"], workRightsAnswer: "I require a visa", workRightsAccepted: false, resumeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  person("d", "Sample Dao", { profileScore: 88, stage: "pre_screen", universityAssessment: { name: "Chulalongkorn University", country: "Thailand", fraction: 0.9, reason: "On the reference list", sources: [] } }),
  person("e", "Sample Eve", { seekJobId: "654321", profileScore: null, profileAssessment: null, universityAssessment: null, workRightsAnswer: null, workRightsAccepted: false, resumeState: "none", resumeType: null }),
  person("c2", "Sample Fon", { profileScore: 70 }),
  person("t", "Tracker Only", { seekApplicationId: null }),
  // Kept out of the SEEK list, so the Seek checks below are unchanged. The Calls tab reads callOrder only.
  person("k", "Sample Kim", { seekApplicationId: null, profileScore: 95, callReview: { good: null, tries: [{ at: "2026-11-03T02:00:00Z", by: "hr@example.test" }] } }),
  person("r1", "Reply Passed", { seekApplicationId: null, stage: "onsite_invited", preScreen: answers, preScreenHash: "x", preScreenAssessment: { ...assessment("Clear answers."), universities: [] }, preScreenScore: 82, preScreenParts: parts }),
  person("r2", "Reply Low", { seekApplicationId: null, stage: "review", preScreen: answers, preScreenHash: "y", preScreenAssessment: { ...assessment("Thin answers."), universities: [] }, preScreenScore: 41, preScreenParts: parts }),
  person("r3", "No Reply Yet", { seekApplicationId: null, stage: "pre_screen" }),
];
const config = baseConfigSchema.parse({ connectedEmail: "fixture@example.test", seekJobs: [{ jobId: "123456", label: "Tutor ad", active: false }, { jobId: "654321", label: "Nov ad", active: true }], profileThreshold: 80, preScreenThreshold: 50 });
const payload = {
  config, configSaved: true, configProblems: [], revision: 1, workerAt: new Date(Date.now() - 600000).toISOString(), workerError: null, writeGate: true,
  workerSummary: { scanned: 140, imported: 2, remaining: 8, folders: [{ status: "Inbox", count: 120, imported: 112 }, { status: "Prescreen", count: 34, imported: 34 }, { status: "Shortlist", count: 9, imported: 9 }, { status: "Not Suitable", count: 500, imported: 0 }] },
  usage: { preScreen: { perDay: 1, perWeek: 2, waiting: 1, unbooked: 0, bySubject: {} }, onsite: { perDay: 0, perWeek: 0, waiting: 0, unbooked: 0, bySubject: {} } },
  holds: { b: { funnel: "pre_screen", state: "next", position: 0, limit: null, subject: "Mathematics" }, a: { funnel: "pre_screen", state: "held", position: 2, limit: "perDay", subject: "Mathematics" } },
  preScreenOrder: ["b", "a", "c2"], callOrder: ["k", "b"], headMocks: {}, heads: {}, candidates, bookings: [],
  visitClashes: { candidateIds: [], stale: false, clashes: {} },
  outbox: [
    { id: "o2", key: "r1:visit-invite", candidateId: "r1", kind: "email", status: "sent", error: null, sentAt: "2026-11-02T03:04:00Z", workflowStage: "onsite_invited" },
    { id: "o3", key: "r1:pre-screen", candidateId: "r1", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o4", key: "r2:pre-screen", candidateId: "r2", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o5", key: "r3:pre-screen", candidateId: "r3", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
    { id: "o1", key: "d:pre-screen", candidateId: "d", kind: "email", status: "sent", error: null, sentAt: "2026-11-01T03:00:00Z", workflowStage: "pre_screen" },
  ],
  inviteOutbox: [] as unknown[],
  papers: [] as unknown[], mocks: [] as unknown[], decisions: [] as unknown[], library: [] as unknown[], markingSpend: { usd: 0, complete: true },
  audit: [], tutors: [], google: { connected: true, email: "fixture@example.test", lastError: null },
};
payload.inviteOutbox = payload.outbox;
const markQuestions = (level: string, marks: number[]) => marks.map((value, i) => ({ id: level[0] + (i + 1), level, marks: value, max: 10, reason: "Correct method", attempted: true, readable: true }));
const visitFor = (candidateId: string, visitId: string, startIso: string, head: string, subject: string) => [
  { id: visitId + "e", candidateId, kind: "paper", status: "confirmed", startTime: startIso, endTime: startIso, visitId, interviewerKey: null, subjects: [subject] },
  { id: visitId + "m", candidateId, kind: "mock", status: "confirmed", startTime: new Date(new Date(startIso).getTime() + 7200000).toISOString(), endTime: new Date(new Date(startIso).getTime() + 10800000).toISOString(), visitId, interviewerKey: head, subjects: [subject] },
];
payload.bookings = [...visitFor("r1", "v1", "2026-11-01T03:00:00Z", "Peat", "Mathematics"), ...visitFor("r2", "v2", new Date(Date.now() + 86400000).toISOString(), "Ek", "Physics")] as never[];
// The role screens (HR, Admin, Heads). Only with ?roles=1, so the checks of the other tabs read the same payload as before.
Object.assign(payload, { calls: [], headDecisions: [], briefPaths: {}, funnelEvents: [], paperChecks: [] });
if (/roles=1|pipeline=1/.test(location.search)) {
  const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * 86400000); d.setUTCHours(hour - 7, 0, 0, 0); return d.toISOString(); };
  Object.assign(payload, {
    reviewAccess: { hr: true, gift: false },
    calls: [{ candidateId: "k", start: at(0, 10), end: at(0, 10) }, { candidateId: "b", start: at(1, 14), end: at(1, 14) }],
    headDecisions: [{ candidateId: "r1", bookingId: "v1m", decision: "hire", reason: "Clear and warm lesson.", head: "Kru Peat", draftProblem: null, at: at(0, 9) }],
    briefPaths: { v2m: "/hiring/brief/sample-token" },
    library: [{ id: "qp-phys", kind: "question_paper", subject: "Physics", name: "Physics paper.pdf", status: "ready" }],
  });
  if (location.search.includes("roles=1")) {
    const [paper, mock] = payload.bookings as { startTime: string; endTime: string }[];
    Object.assign(paper, { startTime: at(-4, 9), endTime: at(-4, 11) });
    Object.assign(mock, { startTime: at(-4, 11), endTime: at(-4, 12) });
    Object.assign(payload.briefPaths, { v1m: "/hiring/brief/sample-token" });
    if (location.search.includes("headNext=1")) {
      candidates.push(person("ek-paper", "Sample Paper", { seekApplicationId: null, stage: "onsite_booked" }));
      const bookings = payload.bookings as unknown[];
      bookings.push(
        { id: "ek-paper", candidateId: "ek-paper", kind: "paper", status: "confirmed", startTime: at(1, 8), endTime: at(1, 10), visitId: null, interviewerKey: null, subjects: ["Physics"] },
        { id: "ek-later", candidateId: "r2", kind: "mock", status: "confirmed", startTime: at(3, 11), endTime: at(3, 12), visitId: null, interviewerKey: "Ek", subjects: ["Physics"] },
      );
      Object.assign((payload.bookings as { id: string }[]).find(({ id }) => id === "v2m")!, { startTime: at(2, 11), endTime: at(2, 12) });
    }
    const endedMocks = [
      ["peat-no-score", "Sample Mali", -3, "confirmed"],
      ["peat-tracker", "Sample Noi", -2, "confirmed"],
      ["peat-sent", "Sample Pim", -1, "confirmed"],
      ["peat-check", "Sample Fah", -1, "confirmed"],
      ["peat-marking", "Sample Lek", -1, "confirmed"],
      ["peat-failed", "Sample Nan", -1, "confirmed"],
      ["peat-incomplete", "Sample Wan", -1, "confirmed"],
      ["peat-cancelled", "Sample Kwan", -2, "cancelled"],
      ["peat-no-show", "Sample May", -1, "no_show"],
    ] as const;
    for (const [id, name, day, status] of endedMocks) {
      candidates.push(person(id, name, { seekApplicationId: null, stage: "mock_booked" }));
      const bookings = payload.bookings as unknown[];
      bookings.push({ id, candidateId: id, kind: "mock", status, startTime: at(day, 11), endTime: at(day, 12), visitId: null, interviewerKey: "Peat", subjects: ["Mathematics"] });
      Object.assign(payload.briefPaths, { [id]: "/hiring/brief/sample-token" });
    }
  }
}
// ?me=Ek: the signed-in head, as /api/hiring names them. A near-miss paper waits for Ek's marks.
// ?persist=1 keeps ?me= for the tab, as a sign-in would: the brief's "My hiring list" link carries no query.
const me = (() => {
  const params = new URLSearchParams(location.search);
  try {
    if (params.get("persist") === "1" && params.get("me")) sessionStorage.setItem("fixture:me", params.get("me")!);
    return params.get("me") ?? sessionStorage.getItem("fixture:me");
  } catch {
    return params.get("me");
  }
})();
if (me) payload.viewerHead = me;
if (location.search.includes("roles=1")) {
  candidates.push(person("near-miss", "Sample Joy", { seekApplicationId: null, stage: "onsite_booked" }));
  (payload.paperChecks as unknown[]).push({ resultId: "pc1", candidateId: "near-miss", subject: "Physics", percent: 67.5, head: "Ek", done: false, path: "/hiring/paper-check/sample-token" });
}
if (location.search.includes("pipeline=1")) {
  candidates.push(person("offer", "Sample Offer", { stage: "hired" }));
  payload.decisions.push({ id: "approved", candidateId: "offer", decision: "hire", status: "sent", outboxKey: "offer:result:approved" });
  (payload.inviteOutbox as Record<string, unknown>[]).push({
    key: "offer:result:approved", status: "sent", sentAt: "2026-11-19T02:00:00Z",
  });
}
if (location.search.includes("scroll=1")) {
  const start = new Date(localDate(new Date()) + "T10:00:00+07:00");
  Object.assign(payload, { calls: candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    start: new Date(start.getTime() + index * 900000).toISOString(),
    end: new Date(start.getTime() + (index + 1) * 900000).toISOString(),
  })) });
}
payload.tutors = [{ canonicalKey: "Peat", name: "Kru Peat", email: "p@example.test", lineReady: true }, { canonicalKey: "Ek", name: "Kru Ek", email: "e@example.test", lineReady: true }] as never[];
payload.config.interviewers = [{ canonicalKey: "Peat", email: "p@example.test", subjects: ["Mathematics"] }, { canonicalKey: "Ek", email: "e@example.test", subjects: ["Physics"] }] as never[];
// ?me=Gift&gift=1: Gift is a head (English Literature) and gives the final sign-off. One packet is ready for her.
if (me === "Gift") {
  const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * 86400000); d.setUTCHours(hour - 7, 0, 0, 0); return d.toISOString(); };
  (payload.tutors as unknown[]).push({ canonicalKey: "Gift", name: "Wanwisa (Gift) Montrikittiphant", email: "g@example.test", lineReady: true });
  (payload.config.interviewers as unknown[]).push({ canonicalKey: "Gift", email: "g@example.test", subjects: ["English Literature"] });
  Object.assign(payload, { finalReviewer: "Gift", reviewPackets: ["r1"] });
  candidates.push(person("gift-mock", "Sample Vin", { seekApplicationId: null, stage: "mock_booked" }), person("gift-later", "Sample Htoo", { seekApplicationId: null, stage: "onsite_booked" }));
  (payload.bookings as unknown[]).push(
    { id: "gift-mock", candidateId: "gift-mock", kind: "mock", status: "confirmed", startTime: at(2, 13), endTime: at(2, 14), visitId: null, interviewerKey: "Gift", subjects: ["English Literature"] },
    { id: "gift-later", candidateId: "gift-later", kind: "mock", status: "confirmed", startTime: at(6, 13), endTime: at(6, 14), visitId: null, interviewerKey: "Gift", subjects: ["English Literature"] },
  );
  Object.assign(payload.briefPaths, { "gift-mock": "/hiring/brief/sample-token", "gift-later": "/hiring/brief/sample-token" });
}
// ?mockNow=1: Ek's mock (Reply Low) started ten minutes ago.
if (location.search.includes("mockNow=1")) {
  const live = (payload.bookings as { id: string; startTime: string; endTime: string }[]).find(({ id }) => id === "v2m");
  if (live) Object.assign(live, { startTime: new Date(Date.now() - 600000).toISOString(), endTime: new Date(Date.now() + 3000000).toISOString() });
}
// Each row's brief shows that row's candidate: the fixture link carries the name, subject and mock time.
if (/roles=1/.test(location.search)) {
  const bookings = payload.bookings as { id: string; candidateId: string; startTime: string; endTime: string; subjects: string[] }[];
  for (const [id, path] of Object.entries(payload.briefPaths as Record<string, string>)) {
    const booking = bookings.find((b) => b.id === id);
    const name = candidates.find((c) => c.id === booking?.candidateId)?.name;
    if (!booking || !name) continue;
    const when = new Date(booking.startTime).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
    (payload.briefPaths as Record<string, string>)[id] = path + "?" + new URLSearchParams({ name, subject: booking.subjects[0] ?? "Mathematics", mock: when });
  }
}
payload.config.paperPassRules = [{ subject: "Mathematics", level: "Key Stage 3", percent: 50 }, { subject: "Mathematics", level: "AS / A-Level", percent: 50 }, { subject: "Mathematics", level: "IB SL / HL", percent: 60 }];
payload.papers = [{ id: "p1", candidateId: "r1", bookingId: "v1e", subject: "Mathematics", source: "ai", status: "done", fileId: "f1", updatedAt: "2026-11-02T00:00:00.000Z", markSchemeUsed: false, history: null, error: null, changedBy: null, marks: { missingPages: null, comment: "Strong algebra. Weak on IB vectors.", questions: [...markQuestions("Key Stage 3", [9, 9]), ...markQuestions("AS / A-Level", [6, 5]), ...markQuestions("IB SL / HL", [3, 4])] } }];
payload.mocks = [{ id: "m1", candidateId: "r1", bookingId: "v1m", subject: "Mathematics", source: "ai", status: "done", fileId: "f2", updatedAt: "2026-11-02T00:00:00.000Z", history: null, error: null, changedBy: null, rubric: { comments: "Clear explanations.", items: { accuracy: 10, concepts: 10, clarity: 7, presentation: 7, interaction: 10, pace: 7, organization: 10, materials: 7, formative: 7, feedback: 9 } } }];
if (location.search.includes("roles=1")) {
  const scored = payload.mocks[0] as Record<string, unknown>;
  payload.mocks.push(
    { ...scored, id: "tracker", candidateId: "peat-tracker", bookingId: null, source: "tracker", fileId: null, rubric: null },
    { ...scored, id: "sent", candidateId: "peat-sent", bookingId: "peat-sent", source: "person", status: "done", fileId: null },
    { ...scored, id: "check", candidateId: "peat-check", bookingId: "peat-check", source: "person", status: "needs_check", fileId: null },
    { ...scored, id: "marking", candidateId: "peat-marking", bookingId: "peat-marking", status: "marking", rubric: null },
    { ...scored, id: "failed", candidateId: "peat-failed", bookingId: "peat-failed", status: "failed", rubric: null },
    { ...scored, id: "incomplete", candidateId: "peat-incomplete", bookingId: "peat-incomplete", rubric: null },
  );
}
let reviewPacket: { id: string; behavioral: string; offer: string } | null = null;
// ?gift=1: the final review as Gift sees it, with a packet from HR.
const GIFT = location.search.includes("gift=1");
if (GIFT) payload.reviewAccess = { hr: location.search.includes("hr=1"), gift: true };
if (GIFT && location.hash === "#review-r1") {
  (payload.headDecisions as unknown[]).unshift({ candidateId: "r2", decision: "reject", reason: "Other application.", head: "Kru Ek", draftProblem: null });
}
// ?live=1: Automation and Messages on, so sign-off is not blocked by a switch.
if (location.search.includes("live=1")) Object.assign(payload.config, { enabled: true, deliveryEnabled: true });
const realFetch = window.fetch;
(window as unknown as { posted: unknown[] }).posted = [];
(window as unknown as { uploaded: unknown[] }).uploaded = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // The Capacity tab reads its own payload, which this fixture does not hold.
  if (String(input).includes("capacity=1")) return new Response(JSON.stringify({ error: "Not in this fixture." }), { status: 503 });
  const url = new URL(String(input), location.origin);
  // The brief's files (résumé, paper, pdf.js runtime) come from the server; only the brief's sends are answered here.
  if (url.pathname.startsWith("/api/hiring/brief/sample-token/") && init?.method === "POST") {
    if (url.pathname.endsWith("/rubric") && location.search.includes("sendFailed=1"))
      return new Response(JSON.stringify({ error: "The scores were not saved. Try again." }), { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    (window as unknown as { posted: unknown[] }).posted.push(body);
    if (url.pathname.endsWith("/rubric")) {
      // Sent scores come back with the brief next time, as the server stores them.
      try { localStorage.setItem("fixture:rubric", JSON.stringify({ items: body.items, comments: body.comments, stressTest: body.stressTest, checksDone: body.checksDone })); } catch {}
      return new Response(JSON.stringify({ total: Object.values(body.items as Record<string, number>).reduce((a, b) => a + b, 0) }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }
  // The head's re-marked paper: pass at the fixture's 70% mark (four questions of 10).
  if (url.pathname === "/api/hiring/paper-check/sample-token" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    (window as unknown as { posted: unknown[] }).posted.push(body);
    const total = Object.values(body.marks as Record<string, number>).reduce((a, b) => a + b, 0);
    try { localStorage.setItem("fixture:paper-sent", "1"); } catch {}
    return new Response(JSON.stringify({ outcome: total >= 28 ? "passed" : "rejected" }));
  }
  if (url.pathname === "/api/hiring/review/offer") {
    return new Response(JSON.stringify({ access: { hr: true, gift: false }, stage: "hired",
      callNotes: "", packet: null, appointment: "2026-11-20T02:30:00Z" }));
  }
  if (url.pathname === "/api/hiring/review/r1") {
    if (url.searchParams.get("file") === "html") return new Response((window as unknown as { realPacket: string }).realPacket, { headers: { "Content-Type": "text/html" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      (window as unknown as { posted: unknown[] }).posted.push(body);
      reviewPacket = { id: "packet", behavioral: body.behavioral, offer: body.offer };
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ access: GIFT ? payload.reviewAccess : { hr: true, gift: false }, stage: GIFT ? "review" : "mock_booked",
      callNotes: "Gave a specific example of adapting a lesson.", packet: GIFT ? { id: "packet", behavioral: "Gave a specific example of adapting a lesson.", offer: OFFER_LETTERS.part_time.text("Reply Passed", "Mathematics"), offerType: "part_time" } : reviewPacket,
      packetValid: new URLSearchParams(location.search).get("stale") === "unknown" ? null : !location.search.includes("stale=1"), appointment: null }));
  }
  if (url.pathname === "/api/hiring/marking") {
    (window as unknown as { posted: unknown[] }).posted.push({ marking: JSON.parse(String(init?.body)) });
    if (JSON.parse(String(init?.body)).kind === "mock") {
      Object.assign((payload.mocks as Record<string, unknown>[]).find((row) => row.id === "m2")!, { status: "needs_check", rubric: { comments: "Good pace.", items: { accuracy: 10, concepts: 7, clarity: 7, presentation: 7, interaction: 7, pace: 7, organization: 7, materials: 7, formative: 4, feedback: null } } });
      return new Response(JSON.stringify({ status: "needs_check", error: null }));
    }
    const paper = (payload.papers as Record<string, unknown>[]).find((row) => row.id === "p2")!;
    Object.assign(paper, { status: "needs_check", markSchemeUsed: true, marks: { missingPages: "Page 4", comment: "Part could not be read.", questions: [...markQuestions("IGCSE / GCSE", [7]), { id: "Q9", level: "IGCSE / GCSE", marks: null, max: 10, reason: "Unreadable", attempted: true, readable: false }] } });
    return new Response(JSON.stringify({ status: "needs_check", error: null }));
  }
  if (url.pathname === "/api/hiring" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    (window as unknown as { posted: unknown[] }).posted.push(body);
    if (body.action === "call_notes") {
      const candidate = payload.candidates.find((c) => c.id === body.id)!;
      const notes = { text: body.text, at: new Date().toISOString(), by: "fixture" };
      Object.assign(candidate, { callReview: { ...candidate.callReview, notes } });
      return new Response(JSON.stringify({ ok: true, notes }));
    }
    if (body.action === "file_intent" && body.kind !== "mock_rubric") return new Response(JSON.stringify({ id: "f9", pathname: "hiring-assessment/f9.pdf" }));
    if (body.action === "file_intent" && body.kind === "mock_rubric") return new Response(JSON.stringify({ id: "f8", pathname: "hiring-assessment/f8.pdf" }));
    if (body.action === "file_ready" && body.id === "f8") {
      (payload.mocks as Record<string, unknown>[]).push({ id: "m2", candidateId: "r2", bookingId: "v2m", subject: "Physics", source: "ai", status: "uploaded", fileId: "f8", updatedAt: "2026-11-02T00:00:00.000Z", history: null, error: null, changedBy: null, rubric: null });
      return new Response(JSON.stringify({ ok: true, resultId: "m2" }));
    }
    if (body.action === "file_ready") {
      (payload.papers as Record<string, unknown>[]).push({ id: "p2", candidateId: "r2", bookingId: "v2e", subject: "Physics", source: "ai", status: "uploaded", fileId: "f9", updatedAt: "2026-11-02T00:00:00.000Z", markSchemeUsed: null, history: null, error: null, changedBy: null, marks: null });
      return new Response(JSON.stringify({ ok: true, resultId: "p2" }));
    }
    if (body.action === "decision_draft") (payload.decisions as Record<string, unknown>[]).unshift({ id: "d1", candidateId: body.id, decision: body.decision, status: "draft", reason: body.reason, emailSubject: "Your BeGifted tutor application", emailBody: "Dear Reply Passed, we are pleased.", outboxKey: null, decidedBy: "fixture", createdAt: "", sentAt: null });
    if (body.action === "decision_discard") (payload.decisions as Record<string, unknown>[]).splice(0, 1);
    if (body.action === "result_check") ((body.kind === "mock" ? payload.mocks : payload.papers) as Record<string, unknown>[]).find((row) => row.id === body.id)!.status = "done";
    if (body.action === "mock_edit") {
      const mock = (payload.mocks as { id: string; changedBy: string | null; rubric: { comments: string; items: Record<string, number | null> } }[]).find((row) => row.id === body.id)!;
      mock.changedBy = "fixture";
      mock.rubric = { comments: body.comments, items: { ...mock.rubric.items, ...body.items } };
    }
    if (body.action === "paper_edit") {
      const paper = (payload.papers as { id: string; changedBy: string | null; marks: { comment: string; questions: { id: string; marks: number | null; readable: boolean }[] } }[]).find((row) => row.id === body.id)!;
      paper.changedBy = "fixture";
      paper.marks.comment = body.comment;
      paper.marks.questions = paper.marks.questions.map((q) => (q.id in body.marks ? { ...q, marks: body.marks[q.id], readable: true } : q));
    }
    if (body.action === "queue_move") {
      const rest = payload.preScreenOrder.filter((id) => id !== body.id && !body.ahead.includes(id));
      payload.preScreenOrder = [...body.ahead, body.id, ...rest];
      payload.candidates.find((c) => c.id === body.id)!.queueManual = true;
    }
    if (body.action === "pre_screen_score") {
      payload.candidates.find((c) => c.id === body.id)!.preScreenOverride = { score: body.score, reason: body.reason, by: "fixture", at: "" };
    }
    if (body.action === "queue_reset") {
      payload.preScreenOrder = ["b", "a", "c2"];
      payload.candidates.forEach((c) => { c.queueManual = false; });
    }
    return new Response(JSON.stringify({ ok: true }));
  }
  if (url.pathname === "/api/hiring" && url.searchParams.get("candidateId"))
    return new Response(JSON.stringify({ id: url.searchParams.get("candidateId"), profileText: "Extracted resume text for the fixture." }));
  if (url.pathname === "/api/hiring" && url.searchParams.get("head"))
    return new Response(JSON.stringify({ name: "Kru Peat", subjects: ["Mathematics"], days: [0, 1, 2, 3, 4].map((i) => ({ date: "2026-11-0" + (2 + i), office: { start: "09:00", end: "18:00" }, blocks: [] })), visits: [], mocks: 0, limit: 2, stale: false, staleReason: null, weekStart: "2026-11-02", head: "Peat" }));
  if (url.pathname === "/api/hiring") {
    // ?failFirst=1: the first two list loads fail (the page retries once on its own), so the Try again button can be checked.
    const once = window as unknown as { failed?: number };
    if (location.search.includes("failFirst=1") && (once.failed ?? 0) < 2) {
      once.failed = (once.failed ?? 0) + 1;
      return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503 });
    }
    // A paper sent in the open page (another frame) is done: the list drops it, as /api/hiring would.
    let sent = false;
    try { sent = localStorage.getItem("fixture:paper-sent") === "1"; } catch {}
    if (sent) (payload.paperChecks as { done: unknown }[]).forEach((check) => { check.done = { passed: true }; });
    return new Response(JSON.stringify(payload));
  }
  return realFetch(input, init);
}) as typeof fetch;
// ?brief=open|wait|closed|checking|admin: the interviewer's public page from the LINE link, with synthetic data.
// The Heads screen opens the brief and the paper check in a frame, at their real paths.
const briefState = new URLSearchParams(location.search).get("brief") ?? (location.pathname.startsWith("/hiring/brief/") ? "open" : null);
const paperCheck = location.pathname.startsWith("/hiring/paper-check/");
const embed = location.search.includes("embed=1");
// A new page load of the list starts the fixture fresh.
if (!embed) { try { localStorage.removeItem("fixture:paper-sent"); localStorage.removeItem("fixture:rubric"); } catch {} }
const PAPER_VIEW = { id: "pc1", name: "Sample Joy", subject: "Physics", head: "Kru Ek", aiPercent: 67.5, passMark: 70, mock: null, updatedAt: "2026-11-24T03:00:00.000Z", done: null, open: true,
  comment: "Good mechanics. Lost marks on units.", questions: [1, 2, 3, 4].map((n) => ({ id: String(n), level: "IGCSE / GCSE", max: 10, marks: n === 4 ? 6 : 7, reason: n === 4 ? "Wrong units in the final answer." : "Method and answer correct." })) };
const recommendationBlock = briefState === "checking" || briefState === "admin" ? briefState : null;
const briefFor = new URLSearchParams(location.search);
const ATS = { score: 78, penalty: 0, parts: [["Degree", 10, 10], ["Subject", 10, 10], ["Curriculum", 7.5, 15], ["Teaching", 20, 20], ["English", 20, 20], ["University", 10.5, 15], ["High school", 0, 10]].map(([name, earned, max]) => ({ name, earned, max })) };
const BRIEF = { ats: ATS, decision: null, name: briefFor.get("name") ?? "Sample Dao", subject: briefFor.get("subject") ?? "Mathematics", gradedPaper: true, exam: briefFor.get("mock") ? null : "Sat 28 Nov, 10:00–11:30", mock: briefFor.get("mock") ?? "Sat 28 Nov, 12:00–12:45",
  interviewer: "Kru Peat", location: "BeGifted, 2nd floor, Siam Square One", answers, resume: "pdf" as const,
  rubric: (() => { try { return JSON.parse(localStorage.getItem("fixture:rubric") ?? "null"); } catch { return null; } })(), form: recommendationBlock ? "closed" : briefState ?? "open", recommendationReady: briefState === "closed", recommendationBlock,
  // A blocked or closed brief is after the mock, as on the server.
  mockEnded: ["checking", "admin", "closed"].includes(briefState ?? "") };
createRoot(document.getElementById("root")!).render(<Suspense fallback="Loading">{paperCheck ? <BookingShell kind="paper-check" bare={embed}>{!embed && <ScheduleLink />}<PaperCheck view={PAPER_VIEW as never} token="sample-token" /></BookingShell> : briefState ? location.pathname.startsWith("/hiring/brief/") ? <BriefShell bare={embed}>{!embed && <ScheduleLink />}<InterviewerBrief compact={embed} brief={BRIEF as never} resumeUrl="/api/hiring/brief/sample-token/resume" rubricUrl="/api/hiring/brief/sample-token/rubric" decisionUrl="/api/hiring/brief/sample-token/decision" /></BriefShell> : <BookingShell kind="brief"><InterviewerBrief brief={BRIEF as never} resumeUrl="/api/hiring/brief/sample-token/resume" rubricUrl="/api/hiring/brief/sample-token/rubric" decisionUrl="/api/hiring/brief/sample-token/decision" /></BookingShell> : location.search.includes("preview=1") ? <div className="flex min-h-0 flex-1 flex-col overflow-auto"><HiringStaffPreview role="hr" /></div> : <HiringDashboard />}</Suspense>);
`;

// Only the framework parts that need a Next.js server are replaced. The components stay real.
const NAVIGATION = `
import { useSyncExternalStore } from "react";
const change = "synthetic-url-change";
const push = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { push(...args); window.dispatchEvent(new Event(change)); };
const subscribe = (fn) => { window.addEventListener(change, fn); window.addEventListener("popstate", fn); return () => { window.removeEventListener(change, fn); window.removeEventListener("popstate", fn); }; };
export const useSearchParams = () => new URLSearchParams(useSyncExternalStore(subscribe, () => location.search));
// The synthetic page has no server to fetch again; refresh keeps the page as it is, after a short wait like a real fetch,
// so a check can see the pending state.
export const useRouter = () => ({ refresh() { return new Promise((resolve) => setTimeout(resolve, 300)); }, push() {}, replace() {} });
`;
// The real review packet HTML (src/lib/hiring/review-document.ts) for a synthetic packet, so Gift's in-page packet is the real layout.
const packetModule = await build({ entryPoints: [path.join(ROOT, "src/lib/hiring/review-document.ts")], bundle: true, write: false, platform: "node", format: "esm", tsconfig: path.join(ROOT, "tsconfig.json"), logLevel: "error" });
const { reviewDocument } = await import(`data:text/javascript;base64,${Buffer.from(packetModule.outputFiles[0].text).toString("base64")}`);
// The packet's offer is the production part-time letter, as HR's choice makes it (critic review, round 12).
const lettersModule = await build({ entryPoints: [path.join(ROOT, "src/lib/hiring/offer-letters.ts")], bundle: true, write: false, platform: "node", format: "esm", tsconfig: path.join(ROOT, "tsconfig.json"), logLevel: "error" });
const { OFFER_LETTERS } = await import(`data:text/javascript;base64,${Buffer.from(lettersModule.outputFiles[0].text).toString("base64")}`);
const rubricItems = { accuracy: 10, concepts: 10, clarity: 7, presentation: 7, interaction: 10, pace: 7, organization: 10, materials: 7, formative: 7, feedback: 9 };
// PACKET_HTML=<file> shows a packet rendered elsewhere (for a local preview); it is never fetched from a server here.
const realPacket = process.env.PACKET_HTML ? readFileSync(process.env.PACKET_HTML, "utf8") : await (async () => { const cwd = process.cwd(); process.chdir(ROOT); try { return await reviewDocument({
  at: "2026-11-19T03:00:00Z", author: "hr@example.test", behavioral: "Gave a specific example of adapting a lesson for a student who struggled with fractions.", offer: OFFER_LETTERS.part_time.text("Reply Passed", "Mathematics"),
  evidence: { name: "Reply Passed", subject: "Mathematics", call: "2026-11-03T02:00:00Z", recommendation: { head: "Kru Peat", reason: "Clear and warm lesson." },
    ats: { score: 86, weights: { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20 }, prestige: 0.5, penalty: 4,
      criteria: ["degree", "subject", "curriculum", "teaching", "english"].map((id) => ({ id, result: "met", evidence: "Taught IGCSE for 2 years" })) },
    paper: { total: 74, max: 110, result: "passed", levels: [
      { level: "Key Stage 3", scored: 18, max: 20, percent: 90, passPercent: 50, result: "passed" },
      { level: "IGCSE / GCSE", scored: 38, max: 40, percent: 95, passPercent: null, result: "pass_mark_missing" },
      { level: "AS / A-Level", scored: 11, max: 20, percent: 55, passPercent: 50, result: "passed" },
      { level: "IB SL / HL", scored: 7, max: 20, percent: 35, passPercent: 60, result: "not_passed" },
      { level: "AP", scored: 0, max: 10, percent: 0, passPercent: null, result: "not_done" },
    ] },
    mock: { total: 84, rubric: { items: rubricItems, comments: "Clear explanations. Checked understanding often." } } },
}, "/api/hiring/review/r1?file=resume", "/api/hiring/review/r1?file=paper"); } finally { process.chdir(cwd); } })();
const bundled = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "hiring-synthetic.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: "out", platform: "browser", format: "iife", target: "es2022", jsx: "automatic", tsconfig: path.join(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") }, minify: !process.env.ONLY, logLevel: "error", logOverride: { "module-level-directive": "silent" },
  plugins: [{ name: "synthetic-framework", setup(bundler) {
    bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    bundler.onResolve({ filter: /^next\/font\/google$/ }, () => ({ path: "font", namespace: "fixture" }));
    bundler.onResolve({ filter: /^@vercel\/blob\/client$/ }, () => ({ path: "blob-client", namespace: "fixture" }));
    bundler.onLoad({ filter: /^blob-client$/, namespace: "fixture" }, () => ({ contents: "export const upload = async (pathname) => { window.uploaded.push(pathname); return { pathname }; };" }));
    bundler.onResolve({ filter: /^next-auth\/react$/ }, () => ({ path: "auth", namespace: "fixture" }));
    // next/link needs the Next router; a plain anchor is enough here.
    bundler.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    bundler.onLoad({ filter: /^link$/, namespace: "fixture" }, () => ({ contents: "import { createElement } from 'react'; export default function Link({ href, ...rest }) { return createElement('a', { href: String(href), ...rest }); }", resolveDir: ROOT }));
    bundler.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({ contents: NAVIGATION, resolveDir: ROOT }));
    bundler.onLoad({ filter: /^font$/, namespace: "fixture" }, () => ({ contents: "export const Instrument_Serif = () => ({ variable: '' });" }));
    bundler.onLoad({ filter: /^auth$/, namespace: "fixture" }, () => ({ contents: "export const signIn = async () => {};" }));
  } }],
});
const script = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const moduleCss = bundled.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const from = path.join(ROOT, "src/app/globals.css");
const globalCss = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, "utf8"), { from })).css;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hiring screens (synthetic)</title><style>${globalCss}${moduleCss}html{--font-inter:Inter,system-ui;--font-cormorant:"Cormorant Garamond";--font-sarabun:Sarabun;--font-instrument-serif:Georgia}#root{display:flex;flex-direction:column;height:100vh;padding:12px 24px;overflow:hidden}</style></head><body><div id="root"></div><script>window.realPacket=${JSON.stringify(realPacket).replaceAll("</", "<\\/")};</script><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
const AXE = readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

// An A4 PDF with a line of text on each page, so the real PDF viewer has something to draw. The paper has five pages,
// so the shots show whether a long paper scrolls inside its own box (critic review, round 10).
const samplePdf = (text, pages = 1) => {
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}]>>`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  for (let page = 1; page <= pages; page += 1) {
    const stream = `BT /F1 28 Tf 60 760 Td (${text}${pages > 1 ? ` - page ${page}` : ""}) Tj ET BT /F1 14 Tf 60 720 Td (Experience, education and subjects would be here.) Tj ET`;
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents ${5 + (page - 1) * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`,
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj${object}endobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${body}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
};
const resumeRequests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  // The brief's résumé and the marked paper: a one-page made-up PDF, drawn by the real pdf.js runtime files.
  const runtime = /\/(?:pdf-runtime|runtime)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname)?.[1];
  if (runtime && url.pathname.startsWith("/api/hiring/")) {
    const relative = runtime === "worker.mjs" ? "build/pdf.worker.min.mjs" : runtime === "worker-legacy.mjs" ? "legacy/build/pdf.worker.min.mjs"
      : runtime.endsWith(".bcmap") ? `cmaps/${runtime}` : /\.(pfb|ttf)$/.test(runtime) ? `standard_fonts/${runtime}` : `wasm/${runtime}`;
    try {
      const bytes = readFileSync(path.join(ROOT, "node_modules/pdfjs-dist", relative));
      response.writeHead(200, { "Content-Type": runtime.endsWith(".mjs") || runtime.endsWith(".js") ? "text/javascript" : runtime.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  if (/^\/api\/hiring\/(?:brief|paper-check)\/[^/]+\/(?:resume|paper)$/.test(url.pathname)) {
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(url.pathname.endsWith("paper") ? samplePdf("Marked paper - made-up data", 5) : samplePdf("Sample resume - made-up data"));
    return;
  }
  if (url.pathname.startsWith("/api/hiring/resume/")) {
    resumeRequests.push(url.pathname.split("/").pop());
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(PDF);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(html);
});
await new Promise((resolve) => server.listen(Number(process.env.SERVE) || 0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// SERVE=<port>: keep the synthetic screens up for a person or a browser agent to click through. No checks run.
if (process.env.SERVE) {
  process.stdout.write(`Serving the synthetic hiring screens at ${origin}\n`);
  await new Promise(() => {});
}

let browser;
const textDumps = new Set();
const shot = async (page, name, fullPage = false) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage, animations: "disabled" });
  // The words on the head and Gift screens, for the text-budget review. Closed <details> are left out, as on screen.
  if (/^(brief|heads|gift)-/.test(name)) {
    const words = async (frame) => frame.evaluate(() => {
      // innerText includes clipped text for screen readers. Omit it from the visible word count.
      const style = document.createElement("style");
      style.textContent = ".sr-only { display: none !important; }";
      document.head.append(style);
      try {
        const visible = document.querySelector("dialog:modal") ?? document.body;
        return visible.innerText.replace(/\n{2,}/g, "\n").trim();
      } finally {
        style.remove();
      }
    });
    const packet = page.frames().find((frame) => frame !== page.mainFrame() && frame.parentFrame() === page.mainFrame());
    const dump = `${name}.txt`;
    writeFileSync(path.join(OUT, dump), (await words(page)) + (packet ? "\n--- packet ---\n" + (await words(packet).catch(() => "")) : ""));
    textDumps.add(dump);
  }
};
// Serious and critical WCAG A/AA problems on the visible page, as "rule: target" lines. The walkthrough passes `all`, more tags and `first`.
const axeProblems = async (page, { tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"], all = false, first = false } = {}) => {
  await page.evaluate(AXE); // evaluate, not a script tag, so a page with a strict policy still works
  return page.evaluate(async (opt) => {
    const result = await window.axe.run(document, { runOnly: opt.tags });
    return result.violations.filter((v) => opt.all || v.impact === "serious" || v.impact === "critical").flatMap((v) => (opt.first ? v.nodes.slice(0, 1) : v.nodes).map((n) => `${v.id}: ${n.target.join(" ")}`));
  }, { tags, all, first });
};
// Page-side measuring for the walkthrough. Installed before the page scripts run, so it also counts every scroll of the page.
function installHelpers() {
  window.__scroll = 0;
  const last = new WeakMap();
  document.addEventListener("scroll", (event) => {
    const box = event.target === document ? document.scrollingElement : event.target;
    window.__scroll += Math.abs(box.scrollTop - (last.get(box) ?? 0));
    last.set(box, box.scrollTop);
  }, true);
  const tool = () => {
    const memo = [new Map(), new Map()];
    // Visible to the eye. With aria, an aria-hidden subtree does not count. Content of a closed <details> is hidden except its <summary>.
    const vis = (el, aria) => {
      if (!el) return true;
      const seen = memo[+aria];
      if (!seen.has(el)) {
        const style = getComputedStyle(el), parent = el.parentElement;
        seen.set(el, !(aria && el.getAttribute("aria-hidden") === "true") && !el.hidden && style.display !== "none" && style.visibility !== "hidden"
          && !(parent && parent.tagName === "DETAILS" && !parent.open && el.tagName !== "SUMMARY") && vis(parent, aria));
      }
      return seen.get(el);
    };
    const texts = (aria = true) => {
      const out = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const text = node.nodeValue.trim(), parent = node.parentElement;
        if (!text || !parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName) || !vis(parent, aria)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) continue;
        const px = parseFloat(getComputedStyle(parent).fontSize);
        const matrix = parent instanceof SVGTextContentElement && parent.getScreenCTM();
        out.push({ text, parent, px: matrix ? Math.round(px * Math.hypot(matrix.c, matrix.d) * 100) / 100 : px, bottom: box.bottom });
      }
      return out;
    };
    return { vis, texts };
  };
  const hint = (el) => `${el.tagName.toLowerCase()}${el.hasAttribute("data-sticky") ? "[data-sticky]" : ""}.${(el.getAttribute("class") ?? "").split(" ")[0]}`;
  const fonts = (all) => ({
    minFontPx: all.reduce((min, x) => Math.min(min, x.px), 99),
    tinyText: all.filter((x) => x.px < 14).map((x) => ({ text: x.text.slice(0, 40), px: x.px, at: hint(x.parent) })),
  });
  window.__m = {
    fonts: () => fonts(tool().texts(false)),
    // How far the control is below the fold, and the visible words rendered above its top edge.
    first(el) {
      const box = el.getBoundingClientRect();
      return { below: Math.max(0, Math.round(box.bottom - innerHeight)), words: tool().texts().filter((x) => x.bottom <= box.top + 1).reduce((n, x) => n + x.text.split(/\s+/).length, 0) };
    },
    snap() {
      const { vis, texts } = tool(), all = texts();
      const small = [], seen = new Set();
      for (const el of document.querySelectorAll("a[href],button,select,textarea,summary,[role=button],input:not([type=hidden])")) {
        let box = el;
        if (el.matches("input[type=radio],input[type=checkbox]") ) box = el.closest("label") || el;
        if (seen.has(box) || !vis(box, false)) continue;
        seen.add(box);
        const r = box.getBoundingClientRect();
        if (!r.width || !r.height || (r.width + 0.01 >= 44 && r.height + 0.01 >= 44)) continue;
        const rest = el.parentElement ? el.parentElement.innerText.replace(el.innerText, "").trim() : "";
        small.push({ name: (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || box.innerText || el.id || el.tagName).trim().slice(0, 50),
          in: ((box.closest("fieldset") || {}).querySelector?.call(box.closest("fieldset"), "legend") || {}).textContent || undefined,
          w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
          ...(el.tagName === "A" && getComputedStyle(el).display === "inline" && rest.split(/\s+/).length >= 4 ? { inline: true } : {}) });
      }
      const { minFontPx: minFont, tinyText: tiny } = fonts(all);
      const long = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim()) || !vis(el, true) || getComputedStyle(el).display.startsWith("inline") || ![...el.children].every((ch) => getComputedStyle(ch).display.startsWith("inline"))) continue;
        for (const sentence of el.innerText.split(/[.!?]\s+|\n+/)) if (sentence.trim().split(/\s+/).length > 20) long.push({ words: sentence.trim().split(/\s+/).length, text: sentence.trim().slice(0, 80) });
      }
      const wide = (el) => !!el && el.scrollWidth > el.clientWidth;
      return { small, tiny, minFont, long,
        side: { page: wide(document.documentElement), main: wide(document.querySelector("main")), root: wide(document.querySelector("#root > div")) },
        states: [...document.querySelectorAll("[role=status],[role=alert],[aria-live]")].filter((el) => vis(el, true) && el.innerText.trim()).map((el) => `${el.getAttribute("role") || "live"}: ${el.innerText.trim().slice(0, 90)}`) };
    },
    // Keyboard-focus the control (a label focuses its input) and report its ring and any sticky or fixed bar over it.
    probe(el) {
      const target = el.tagName === "LABEL" ? el.querySelector("input,select,textarea") || el : el;
      target.focus();
      const ring = target.matches("input[type=radio],input[type=checkbox]") ? target.closest("label") || target : target;
      const style = getComputedStyle(ring), box = ring.getBoundingClientRect();
      const over = [...document.querySelectorAll("*")].filter((x) => {
        const position = getComputedStyle(x).position, b = x.getBoundingClientRect();
        return (position === "sticky" || position === "fixed") && !x.contains(target) && b.height > 0
          && Math.min(box.right, b.right) - Math.max(box.left, b.left) > 1 && Math.min(box.bottom, b.bottom) - Math.max(box.top, b.top) > 1;
      }).map(hint);
      return { focused: document.activeElement === target, outline: style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth), shadow: style.boxShadow !== "none", over };
    },
  };
}
// ONLY=<words> runs the checks whose name holds those words, such as ONLY="screen shows" for the role screens.
const check = async (name, action) => {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  // One failed check does not hide the result of the others; the run still exits 1.
  try {
    await action();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`FAIL ${name}: ${String(error.message).split("\n")[0]}\n`);
    // The harness line of the failed step, for a quick fix.
    process.stdout.write(`     ${String(error.message).split("\n").slice(1, 6).join(" ")} ${String(error.stack).split("\n").find((line) => line.includes("verify-hiring-screens.mjs")) ?? ""}\n`);
  }
};
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    if (process.env.ONLY) process.stderr.write(`${error.stack}\n`);
    process.stderr.write(`PAGE ERROR ${error.message}\n`);
  });
  const names = () => page.locator("[data-candidate]").allInnerTexts();
  const seekRows = () => page.getByRole("region", { name: "Candidates from SEEK" }).locator("tbody tr");

  await check("the Calls tab lists HR's queue and posts each result", async () => {
    await page.goto(`${origin}/?view=calls`);
    const calls = page.getByRole("region", { name: "Candidates for HR to call" });
    await calls.getByText("Sample Kim").waitFor();
    assert.ok(await calls.getByText("1 no answer · last 3 Nov, 09:00").isVisible());
    await shot(page, "calls");
    const ben = calls.getByRole("link", { name: "View on SEEK for Sample Ben (opens in a new tab)" });
    assert.match(await ben.getAttribute("href"), /^https:\/\/th\.employer\.seek\.com\/candidates\/\?jobid=\d+&selected=[^&]+&tab=profile$/);
    assert.equal(await ben.getAttribute("target"), "_blank");
    assert.ok(await calls.getByText("Chulalongkorn University").isVisible());
    await calls.getByRole("button", { name: "Good call" }).first().click();
    await page.waitForFunction(() => window.posted.length === 1);
    await calls.getByRole("button", { name: "No answer" }).first().click();
    await page.waitForFunction(() => window.posted.length === 2);
    page.once("dialog", (dialog) => dialog.accept());
    await calls.getByRole("button", { name: "Bad call" }).first().click();
    await page.waitForFunction(() => window.posted.length === 3);
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.slice(0, 2), [
      { action: "call_result", id: "k", result: "good" },
      { action: "call_result", id: "k", result: "no_answer" },
    ]);
    assert.equal(posted[2].action, "stop");
    await calls.getByText("Sample Kim").click();
    await page.getByRole("complementary", { name: "Résumé and score of Sample Kim" }).waitFor();
  });
  await check("the tab opens from the address and changes the address", async () => {
    await page.goto(`${origin}/?view=seek`);
    await page.getByRole("button", { name: "SEEK intake" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "SEEK intake" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Overview" }).click();
    assert.match(page.url(), /view=overview/);
    await page.getByLabel("Filter by stage").waitFor();
    await page.goBack();
    assert.match(page.url(), /view=seek/);
    await page.locator("[data-candidate]").first().waitFor();
  });
  await check("coverage shows SEEK against imported", async () => {
    const coverage = page.getByRole("region", { name: "SEEK coverage" });
    assert.ok(await coverage.getByText("112 / 120").isVisible());
    assert.ok(await coverage.getByText("8 waiting").isVisible());
    assert.equal(await coverage.getByText("Not Suitable").count(), 0);
  });
  await check("the list leaves out tracker-only people and starts with the top score", async () => {
    const all = await names();
    assert.deepEqual(all, ["Sample Ben", "Sample Dao", "Sample Ann", "Sample Cho", "Sample Fon", "Sample Eve"]);
    await shot(page, "seek-all");
  });
  await check("the campaign filter shows one job's applicants, and each row names its campaign", async () => {
    const pick = page.getByRole("region", { name: "Candidates from SEEK" }).getByLabel("Campaign");
    await pick.selectOption("654321");
    assert.deepEqual(await names(), ["Sample Eve"]);
    assert.ok(await seekRows().first().getByText("Nov ad", { exact: false }).isVisible());
    await shot(page, "seek-campaign");
    await pick.selectOption("");
    assert.equal((await names()).length, 6);
  });
  await check("the send queue is numbered, then shows who was sent", async () => {
    await page.getByRole("button", { name: "Send queue" }).click();
    assert.deepEqual(await names(), ["Sample Ben", "Sample Ann", "Sample Fon", "Sample Dao"]);
    const cells = await seekRows().locator("td:first-child").allInnerTexts();
    assert.deepEqual(cells.map((text) => text.replace(/[↑↓\s]/g, "")), ["1", "2", "3", "Sent"]);
    await shot(page, "seek-queue");
  });
  await check("a drag and the arrow buttons change the order and post only the move", async () => {
    const row = (name) => seekRows().filter({ hasText: name });
    await row("Sample Fon").dragTo(row("Sample Ben"));
    await seekRows().first().getByText("Moved by hand").waitFor();
    assert.deepEqual(await names(), ["Sample Fon", "Sample Ben", "Sample Ann", "Sample Dao"]);
    await page.getByRole("button", { name: "Move Sample Ann up" }).click();
    await page.waitForFunction(() => window.posted.length === 2);
    await seekRows().nth(1).filter({ hasText: "Sample Ann" }).waitFor();
    assert.deepEqual((await names()).slice(0, 3), ["Sample Fon", "Sample Ann", "Sample Ben"]);
    await shot(page, "seek-queue-moved");
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.map((p) => p.action), ["queue_move", "queue_move"]);
    assert.deepEqual(posted[0], { action: "queue_move", id: "c2", ahead: [] });
    await page.getByRole("button", { name: "Back to automatic order" }).click();
    await page.waitForFunction(() => window.posted.length === 3);
    await page.waitForFunction(() => !document.body.innerText.includes("Moved by hand"));
    assert.deepEqual((await names()).slice(0, 3), ["Sample Ben", "Sample Ann", "Sample Fon"]);
    await page.getByRole("button", { name: "All candidates" }).click();
  });
  await check("university names filter the list, and several can be picked", async () => {
    await page.getByText("University: all").click();
    await page.getByLabel("Search university names").fill("mahidol");
    await page.getByRole("checkbox", { name: /Mahidol/ }).check();
    assert.deepEqual(await names(), ["Sample Ann", "Sample Cho", "Sample Fon"]);
    await page.getByLabel("Search university names").fill("");
    await page.getByRole("checkbox", { name: /Chulalongkorn/ }).check();
    assert.deepEqual(await names(), ["Sample Ben", "Sample Dao", "Sample Ann", "Sample Cho", "Sample Fon"]);
    await shot(page, "seek-university");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByText(/University: all/).click();
  });
  await check("the exact work rights answer filters the list", async () => {
    await page.getByLabel("Work rights").selectOption("I require a visa");
    assert.deepEqual(await names(), ["Sample Cho"]);
    await page.getByRole("button", { name: "Clear filters" }).click();
  });
  await check("a click opens the resume, and the arrow keys move between people", async () => {
    await seekRows().first().click();
    const panel = page.getByRole("complementary", { name: "Résumé and score of Sample Ben" });
    await panel.waitFor();
    await panel.getByTitle("Original résumé of Sample Ben").waitFor();
    await shot(page, "seek-panel");
    await page.keyboard.press("ArrowDown");
    await page.getByRole("complementary", { name: "Résumé and score of Sample Dao" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Sample Dao");
    await page.keyboard.press("ArrowUp");
    await page.getByRole("complementary", { name: "Résumé and score of Sample Ben" }).waitFor();
    assert.ok(resumeRequests.includes("d"));
  });
  await check("a Word resume shows a download and the extracted text", async () => {
    await page.locator("[data-candidate]", { hasText: "Sample Cho" }).click();
    const panel = page.getByRole("complementary", { name: "Résumé and score of Sample Cho" });
    await panel.getByRole("link", { name: "Download" }).waitFor();
    await panel.getByText("Extracted resume text for the fixture.").waitFor();
    assert.equal(await panel.locator("iframe").count(), 0);
    assert.ok(await panel.getByText("I require a visa").isVisible());
  });
  await check("the pre-screen tab lists everyone sent a form, with proof of the visit email", async () => {
    await page.getByRole("button", { name: "Pre-screen form" }).click();
    const list = page.getByRole("region", { name: "Pre-screen responses" });
    const rows = list.locator("tbody tr");
    await rows.first().waitFor();
    assert.deepEqual((await list.locator("tbody button").allInnerTexts()).slice(0, 2), ["Reply Passed", "Reply Low"]);
    assert.ok(!(await list.getByText("Sample Ann").count()));
    await list.getByText("Sent 2 Nov, 10:04").waitFor();
    await list.getByText("Not sent: below pass score").waitFor();
    await list.getByText("Waiting for reply").first().waitFor();
    await shot(page, "prescreen-list");
    await list.getByRole("button", { name: /^Below pass score/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low"]);
    await list.getByRole("button", { name: /^All/ }).click();
    // The sent-date range uses the Bangkok day: 03:04 UTC on 2 Nov is 2 Nov.
    await list.getByLabel("Visit email sent from").fill("2026-11-02");
    await list.getByLabel("to", { exact: true }).fill("2026-11-02");
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Passed"]);
    await list.getByText("1 shown with a visit email sent 2 Nov 2026 to 2 Nov 2026").waitFor();
    await shot(page, "prescreen-sent-date");
    // At 800 px the date boxes go to their own line, so no chip is cut off.
    await page.setViewportSize({ width: 800, height: 900 });
    const chips = list.getByRole("group", { name: "Filter pre-screen responses" });
    assert.ok(await chips.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "chips cut off at 800 px");
    assert.ok((await list.getByLabel("Visit email sent from").boundingBox()).y > (await chips.boundingBox()).y + 10);
    await shot(page, "prescreen-sent-date-800");
    await page.setViewportSize({ width: 1440, height: 900 });
    await list.getByLabel("Visit email sent from").fill("2026-11-03");
    await list.getByLabel("to", { exact: true }).fill("");
    await list.getByText("No candidates match this filter.").waitFor();
    await list.getByRole("button", { name: "Clear dates" }).click();
    assert.ok((await list.locator("tbody tr").count()) > 2);
  });
  await check("the panel shows full answers, AI reasons and actions, and a score change posts only the change", async () => {
    await page.getByRole("region", { name: "Pre-screen responses" }).getByRole("button", { name: "Reply Low" }).click();
    const panel = page.getByRole("complementary", { name: "Pre-screen of Reply Low" });
    await panel.getByText("Worked examples, then the student tries one.").waitFor();
    assert.ok(await panel.getByText("Why the AI scored it this way").isVisible());
    assert.ok(await panel.getByRole("button", { name: "Invite despite low score" }).isDisabled());
    await panel.getByLabel("Reason").fill("Strong in a call");
    await panel.getByLabel("New score").fill("70");
    await panel.getByRole("button", { name: "Change score" }).click();
    await panel.getByText("changed the AI score").waitFor();
    assert.ok(await panel.getByRole("button", { name: "Invite to visit" }).isVisible());
    await shot(page, "prescreen-panel");
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.at(-1), { action: "pre_screen_score", id: "r2", revision: 1, score: 70, reason: "Strong in a call" });
  });
  await check("the mock and paper tab lists visits with date, head and results", async () => {
    await page.getByRole("button", { name: "Paper test" }).click();
    const list = page.getByRole("region", { name: "Mock and paper" });
    await list.locator("tbody tr").first().waitFor();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low", "Reply Passed"]);
    await list.getByRole("cell", { name: "Kru Peat" }).waitFor();
    await list.getByText("Mathematics: 60% · AS / A-Level").waitFor();
    await list.getByText("84 / 100").waitFor();
    await shot(page, "assessment-list");
    await list.getByLabel("Head").selectOption("Peat");
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Passed"]);
    await list.getByLabel("Head").selectOption("");
    await list.getByRole("button", { name: /^Ready to decide/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Passed"]);
    await list.getByRole("button", { name: /^Ready to decide/ }).click();
  });
  await check("the panel tabulates the marking sheet and the rubric from the marks", async () => {
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("button", { name: "Reply Passed" }).click();
    const panel = page.getByRole("complementary", { name: "Assessment of Reply Passed" });
    const sheet = panel.getByRole("region", { name: "Paper marking sheet for Mathematics" });
    await sheet.getByRole("row", { name: /Key Stage 3 18 \/ 20 50% Passed/ }).waitFor();
    await sheet.getByRole("row", { name: /IB SL \/ HL 7 \/ 20 60% Not passed/ }).waitFor();
    await sheet.getByRole("row", { name: /IGCSE \/ GCSE – – Not done/ }).waitFor();
    await sheet.getByText("Marked without a mark scheme").waitFor();
    assert.ok(await sheet.getByRole("definition").filter({ hasText: "AS / A-Level" }).isVisible());
    const rubric = panel.getByRole("region", { name: "Mock rubric" });
    await rubric.getByRole("row", { name: /Total 84 \/ 100/ }).waitFor();
    await shot(page, "assessment-panel");
  });
  await check("uploading a scan on the row marks it, and a person clears the check", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await page.locator("input[type=file][aria-label='Upload PDF for the Physics paper']").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
    await list.getByText("Physics: Needs check").waitFor();
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.slice(-3).map((p) => p.action ?? "marking"), ["file_intent", "file_ready", "marking"]);
    assert.deepEqual(posted.at(-1), { marking: { kind: "paper", id: "p2" } });
    assert.deepEqual(posted.at(-3), { action: "file_intent", kind: "paper_scan", subject: "Physics", candidateId: "r2", name: "scan.pdf", size: 16 });
    await list.getByRole("button", { name: /^Needs check/ }).click();
    assert.deepEqual(await list.locator("tbody button").allInnerTexts(), ["Reply Low"]);
    await list.getByRole("button", { name: /^Needs check/ }).click();
    await list.getByRole("button", { name: "Reply Low" }).click();
    const sheet = page.getByRole("region", { name: "Paper marking sheet for Physics" });
    await sheet.getByText("Missing pages: Page 4").waitFor();
    await sheet.getByRole("button", { name: "Change marks" }).click();
    await sheet.getByLabel("Marks for question Q9").fill("6");
    await sheet.getByRole("button", { name: "Save marks" }).click();
    await sheet.getByText("Changed by").waitFor();
    await shot(page, "assessment-needs-check");
    await sheet.getByRole("button", { name: "I have checked this" }).click();
    await list.getByText(/^Physics: \d+%/).waitFor();
    await page.getByRole("complementary", { name: "Assessment of Reply Low" }).getByRole("button", { name: "Close" }).click();
  });
  await check("uploading a mock rubric reads it, a person fills the blank, and the total adds up", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await page.locator("input[type=file][aria-label='Upload rubric for the mock in Physics']").first().setInputFiles({ name: "rubric.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
    await list.getByText("Needs check", { exact: true }).first().waitFor();
    const posted = await page.evaluate(() => window.posted);
    assert.deepEqual(posted.at(-1), { marking: { kind: "mock", id: "m2" } });
    await list.getByRole("button", { name: "Reply Low" }).click();
    const rubric = page.getByRole("region", { name: "Mock rubric" });
    await rubric.getByRole("row", { name: /Total 63 \/ 100/ }).waitFor();
    await rubric.getByRole("button", { name: "Change scores" }).click();
    await rubric.getByLabel("Score for Feedback Quality").fill("9");
    await rubric.getByRole("button", { name: "Save scores" }).click();
    await rubric.getByRole("row", { name: /Total 72 \/ 100/ }).waitFor();
    await rubric.getByRole("button", { name: "I have checked this" }).click();
    await list.getByText("72 / 100").waitFor();
    assert.deepEqual((await page.evaluate(() => window.posted)).at(-2).items, { feedback: 9 });
    await page.getByRole("complementary", { name: "Assessment of Reply Low" }).getByRole("button", { name: "Close" }).click();
  });
  await check("an early rejection saves a draft and previews the email, and Send refuses while the switches are off", async () => {
    const list = page.getByRole("region", { name: "Mock and paper" });
    await list.getByRole("button", { name: "Reply Passed" }).click();
    const panel = page.getByRole("complementary", { name: "Assessment of Reply Passed" });
    const box = panel.getByRole("region", { name: "Decision" });
    assert.ok(await box.getByRole("button", { name: "Reject: preview email" }).isDisabled());
    await box.getByLabel("Reason").fill("Not a fit for this level");
    await box.getByRole("button", { name: "Reject: preview email" }).click();
    await box.getByLabel("Email message").waitFor();
    await list.getByText("Draft: Reject").waitFor();
    await box.getByText("Automation and Messages are off").waitFor();
    await box.getByText("r1@example.test").waitFor();
    await box.getByLabel("Email message").fill("Edited by a person.");
    await box.getByRole("button", { name: "Save draft" }).click();
    await page.waitForFunction(() => window.posted.at(-1).action === "decision_save");
    assert.ok(await box.getByRole("button", { name: "Send email" }).isDisabled());
    await shot(page, "decision-draft");
    assert.ok(!(await page.evaluate(() => window.posted)).some((p) => p.action === "decision_send"));
    await box.getByRole("button", { name: "Discard" }).click();
    await box.getByRole("button", { name: "Reject: preview email" }).waitFor();
    await box.getByLabel("Reason").fill("Not a fit for this level");
    assert.ok(await box.getByRole("button", { name: "Reject: preview email" }).isEnabled());
    await panel.getByRole("button", { name: "Close" }).click();
  });
  await check("the calendar switch opens the head schedule", async () => {
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("group", { name: "View" }).getByRole("button", { name: "Calendar" }).click();
    await page.getByRole("region", { name: "Mock and paper" }).getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
  });
  await check("settings hold the pass marks and the paper library", async () => {
    await page.getByRole("button", { name: "Rules and setup" }).click();
    assert.equal(await page.getByLabel("Mathematics Key Stage 3 pass percentage").inputValue(), "50");
    await page.getByRole("heading", { name: "Paper library" }).waitFor();
    assert.ok((await page.getByText("Missing").count()) > 0);
    await page.getByLabel("Mathematics Key Stage 3 pass percentage").scrollIntoViewIfNeeded();
    await shot(page, "assessment-settings");
    assert.equal(await page.getByLabel("Campaign 2 SEEK job ID").inputValue(), "654321");
    assert.equal(await page.getByLabel("Campaign 1 name").inputValue(), "Tutor ad");
    await page.getByLabel("Campaign 1 name").scrollIntoViewIfNeeded();
    await shot(page, "campaign-settings");
  });
  await check("the daily call workspace saves notes and the staff preview is read-only", async () => {
    await page.goto(`${origin}/?view=hr&roles=1`);
    const card = page.locator("article").filter({ has: page.getByRole("button", { name: "Résumé and notes" }) });
    await card.getByText("Sample Kim", { exact: true }).waitFor();
    assert.equal(await card.count(), 1);
    await card.getByRole("button", { name: "Résumé and notes" }).click();
    await card.getByRole("textbox", { name: "Call notes" }).fill("Can teach on Saturdays.");
    await card.getByRole("button", { name: "Save notes" }).click();
    await card.getByText("Notes saved.", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.posted), [{ action: "call_notes", id: "k", text: "Can teach on Saturdays.", expected: null }]);
    await card.getByRole("button", { name: "Résumé and notes" }).click();
    await card.getByRole("button", { name: "Résumé and notes" }).click();
    assert.equal(await card.getByRole("textbox", { name: "Call notes" }).inputValue(), "Can teach on Saturdays.");
    const tomorrow = new Date(Date.now() + 86400000 + 7 * 3600000).toISOString().slice(0, 10);
    await page.getByLabel("Date (Bangkok)").fill(tomorrow);
    await card.getByText("Sample Ben", { exact: true }).waitFor();
    assert.equal(await card.getByText("Sample Kim", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await card.getByText("Sample Kim", { exact: true }).waitFor();
    const datePicker = page.getByLabel("Date (Bangkok)");
    const today = await datePicker.inputValue();
    const weekday = page.getByRole("button", { name: /booked calls$/, pressed: false }).first();
    await weekday.press("Enter");
    await page.getByRole("heading", { name: /^Calls for/ }).waitFor();
    assert.notEqual(await datePicker.inputValue(), today);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("heading", { name: /^Today’s calls/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("textbox", { name: "Call notes" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${origin}/?view=calls&roles=1`);
    await card.getByText("Sample Kim", { exact: true }).waitFor();
    await page.goto(`${origin}/?preview=1&roles=1`);
    await card.getByRole("button", { name: "Résumé and notes" }).click();
    assert.equal(await card.getByRole("textbox", { name: "Call notes" }).getAttribute("readonly"), "");
    assert.equal(await card.getByRole("button", { name: "Save notes" }).count(), 0);
    assert.ok(await card.getByRole("button", { name: "Good call" }).isDisabled());
    assert.equal(await page.getByRole("button", { name: "Open final review" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.posted), []);
  });
  await check("the Hiring pages scroll to the last call card", async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const query of ["view=hr", "view=calls", "preview=1"]) {
        await page.goto(`${origin}/?${query}&roles=1&scroll=1`);
        const heading = page.getByRole("heading", { name: /Today’s calls/ });
        await heading.waitFor();
        if (query === "view=hr") await shot(page, width === 1440 ? "hiring-desktop" : "hiring-phone");
        // Use a wheel event: scrollIntoView can move even an overflow:hidden container.
        const card = page.locator("article").filter({ has: page.getByRole("button", { name: "Résumé and notes" }) }).last();
        const before = (await card.boundingBox()).y;
        assert.ok(before > 800, `${query} at ${width}px: last call starts at ${before}px`);
        const box = await heading.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, before - 400);
        await page.waitForFunction(() => {
          const cards = [...document.querySelectorAll("article")].filter((item) =>
            [...item.querySelectorAll("button")].some((button) => button.textContent === "Résumé and notes"));
          const last = cards.at(-1).getBoundingClientRect();
          return last.top >= 0 && last.bottom <= innerHeight;
        }, undefined, { timeout: 5000 });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check("HR can start the final review from call notes and send it to Gift", async () => {
    await page.goto(`${origin}/?view=hr&roles=1`);
    await page.getByRole("button", { name: "Open final review" }).click();
    const behavioral = page.getByLabel("Behavioral assessment from the pre-screen call");
    await behavioral.waitFor();
    assert.equal(await behavioral.inputValue(), "Gave a specific example of adapting a lesson.");
    assert.ok(await page.getByRole("button", { name: "Send to Gift" }).isDisabled());
    await page.getByLabel("Offer letter").fill("We offer you the Mathematics tutor position.");
    await page.getByRole("button", { name: "Send to Gift" }).click();
    await page.getByRole("link", { name: "Read review packet" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.posted)).at(-1), {
      action: "submit", behavioral: "Gave a specific example of adapting a lesson.", offer: "We offer you the Mathematics tutor position.",
    });
  });
  await check("the HR screen shows calls and recommendations", async () => {
    await page.goto(`${origin}/?view=hr&roles=1`);
    await page.getByRole("heading", { name: "Booked calls by day" }).waitFor();
    // A role screen hides the tabs. One button leads back.
    assert.equal(await page.getByRole("navigation", { name: "Hiring steps" }).count(), 0);
    assert.ok(await page.getByRole("button", { name: "Full dashboard" }).isVisible());
    assert.ok(await page.getByRole("heading", { name: "Tutor recommendations" }).isVisible());
    assert.ok(await page.getByText("Kru Peat · Clear and warm lesson.").isVisible());
    await page.getByRole("button", { name: "Show the résumé of Sample Kim" }).click();
    // The PDF pages need the app's PDF runtime route, which this fixture does not serve. The panel and its Download link prove the file is asked for.
    await page.getByRole("link", { name: "Download" }).waitFor();
    await shot(page, "role-hr");
    await page.getByRole("button", { name: "Hide the résumé of Sample Kim" }).click();
    const queue = page.locator("section").filter({ has: page.getByRole("heading", { name: /^To call/ }) });
    assert.equal(await queue.getByRole("button", { name: "Good call" }).count(), 2);
    await shot(page, "role-hr-list");
  });
  await check("the Admin screen shows each visit with its paper to print and the upload", async () => {
    await page.goto(`${origin}/?view=admin&roles=1`);
    await page.getByRole("heading", { name: /^Tomorrow/ }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Print the paper" }).getAttribute("href"), "/api/hiring/file/qp-phys");
    assert.ok(await page.getByText("Upload the completed paper").first().isVisible());
    assert.ok(await page.getByText("Head: Kru Ek").isVisible());
    await shot(page, "role-admin");
  });
  await check("the Heads screen opens the signed-in head's list with the most urgent page open", async () => {
    // /hiring alone opens a head's own screen. There is no name to choose.
    await page.goto(`${origin}/?roles=1&me=Ek`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${origin}/?roles=1&me=Ek`);
    await page.getByRole("navigation", { name: "Kru Ek's hiring list" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Head" }).count(), 0);
    assert.equal(await page.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p").first().textContent(), "Kru Ek");
    // The paper to re-mark comes first and is already open beside the list.
    await page.frameLocator("iframe").getByText("Sample Joy").first().waitFor();
    assert.equal(await page.locator("iframe").getAttribute("src"), "/hiring/paper-check/sample-token?embed=1");
    assert.equal(await page.getByRole("link", { name: /^Re-mark paper: .*Sample Joy/ }).getAttribute("aria-current"), "true");
    await shot(page, "role-heads");
    // One click on the next mock opens its brief in the same place.
    await page.getByRole("link", { name: /^Interview brief: .*Reply Low/ }).click();
    await page.frameLocator("iframe").getByRole("heading", { name: "Reply Low" }).waitFor();
    assert.match(await page.locator("iframe").getAttribute("src"), /^\/hiring\/brief\/sample-token\?name=Reply\+Low&.*&embed=1$/);
    assert.equal(await page.frameLocator("iframe").getByRole("link", { name: "← My hiring list" }).count(), 0);
    await shot(page, "role-heads-brief");
    // On a phone the list is the page: a tap opens the paper check or the brief itself, which links back.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?view=heads&roles=1&me=Ek`);
    await page.getByRole("link", { name: /^Re-mark paper: .*Sample Joy/ }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0);
    assert.equal(await page.getByRole("link", { name: /^Re-mark paper: .*Sample Joy/ }).getAttribute("href"), "/hiring/paper-check/sample-token");
    await shot(page, "role-heads-phone");
    await page.goto(`${origin}/hiring/brief/sample-token`);
    assert.equal(await page.getByRole("link", { name: "← My hiring list" }).getAttribute("href"), "/hiring?view=heads");
    await page.goto(`${origin}/?view=hr&roles=1`);
    await page.getByRole("heading", { name: /To call/ }).waitFor();
    await shot(page, "role-hr-phone");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Full dashboard" }).click();
    await page.getByRole("navigation", { name: "Hiring steps" }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("hiring-role-view")), null);
  });
  await check("the hiring steps open the correct workspaces on desktop and phone", async () => {
    await page.goto(`${origin}/?view=calls&pipeline=1`);
    const workflow = page.getByRole("navigation", { name: "Hiring steps" });
    const tools = page.getByRole("navigation", { name: "Hiring tools" });
    assert.deepEqual(await workflow.getByRole("button").allTextContents(),
      ["1SEEK intake", "2HR calls", "3Pre-screen form", "4Paper test", "5Mock teaching", "6Final review", "7Offer & signing"]);
    assert.ok(await tools.getByRole("button", { name: "Visit schedule" }).isVisible());
    assert.equal(await workflow.getByRole("button", { name: "HR calls" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("region", { name: "Candidates for HR to call" }).waitFor();
    const menu = page.locator("header details > summary");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await shot(page, `hiring-workflow-${width}`);
      if (width === 390) {
        assert.equal(await workflow.isVisible(), false);
        assert.equal(await menu.textContent(), "2 HR calls");
        await menu.press("Enter");
      }
      assert.ok(await workflow.evaluate((nav) => nav.scrollWidth <= nav.clientWidth));
    }
    const paper = workflow.getByRole("button", { name: "Paper test" });
    await paper.focus();
    await paper.press("Enter");
    await page.getByRole("region", { name: "Mock and paper" }).waitFor();
    assert.match(page.url(), /view=assessment$/);
    await shot(page, "hiring-paper-phone");
    await menu.click();
    await workflow.getByRole("button", { name: "Mock teaching" }).click();
    await page.getByRole("combobox", { name: "Head" }).waitFor();
    await shot(page, "hiring-mock-phone");
    await menu.click();
    await workflow.getByRole("button", { name: "Final review" }).click();
    await page.getByRole("button", { name: "Open final review" }).click();
    const assessment = page.getByLabel("Behavioral assessment from the pre-screen call");
    await assessment.waitFor();
    assert.equal(await assessment.inputValue(), "Gave a specific example of adapting a lesson.");
    await shot(page, "hiring-review-phone");
    await menu.click();
    await workflow.getByRole("button", { name: "Offer & signing" }).click();
    await page.getByText(/Sent Thu 19 Nov, 09:00/).waitFor();
    await page.getByRole("button", { name: "Check contract signing" }).click();
    await page.getByText(/Contract signing booked for 20 Nov 2026, 09:30/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send to Gift" }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.posted), []);
    await shot(page, "hiring-offer-phone");
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "hiring-offer-desktop");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    assert.equal(await workflow.getByRole("button", { name: "Offer & signing" }).getAttribute("aria-pressed"), "true");
    await shot(page, "hiring-offer-dark");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  });
  await check("workspace shots for the UX review", async () => {
    const at = async (width, height, query, name, ready) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?${query}`);
      await ready();
      await page.waitForTimeout(250);
      await shot(page, name);
    };
    const frameReady = (text) => () => page.frameLocator("iframe").getByText(text).first().waitFor();
    for (const [width, height, size] of [[1440, 900, "desktop"], [1280, 800, "laptop"]]) {
      await at(width, height, "roles=1&me=Ek", `heads-ws-ek-${size}`, frameReady("Sample Joy"));
      // The packet opens by itself beside Gift's decision.
      await at(width, height, "roles=1&me=Gift&gift=1&live=1", `heads-ws-gift-${size}`, () => page.locator("iframe[title^='Review packet']").waitFor());
    }
    await at(1440, 900, "roles=1&me=Ek", "heads-ws-ek-brief-desktop", async () => {
      await page.getByRole("link", { name: /^Interview brief: .*Reply Low/ }).click();
      await page.frameLocator("iframe").getByRole("heading", { name: "Reply Low" }).waitFor();
    });
    await at(1440, 900, "view=heads&roles=1", "heads-ws-staff-desktop", async () => {
      await page.getByRole("combobox", { name: "Head" }).selectOption({ label: "Kru Peat" });
      await page.getByRole("link", { name: /Record recommendation/ }).first().waitFor();
    });
    await at(1440, 900, "roles=1&me=Gift&gift=1&live=1&headNext=1", "heads-ws-gift-mock-desktop", async () => {
      await page.getByRole("link", { name: /^Interview brief: .*Sample Vin/ }).click();
      await page.frameLocator("iframe").getByRole("heading", { name: "Sample Vin" }).waitFor();
    });
    await at(1024, 768, "roles=1&me=Ek", "heads-ws-ek-1024", frameReady("Sample Joy"));
    for (const [width, height, size] of [[390, 844, "phone"], [320, 700, "320"]]) {
      await at(width, height, "roles=1&me=Ek", `heads-ws-ek-${size}`, () => page.getByRole("link", { name: /^Re-mark paper: .*Sample Joy/ }).waitFor());
      await at(width, height, "roles=1&me=Gift&gift=1&live=1", `heads-ws-gift-${size}`, () => page.getByRole("button", { name: /^Final review: .*Reply Passed/ }).waitFor());
    }
    await at(390, 844, "roles=1&me=Gift&gift=1&live=1", "heads-ws-gift-review-phone", async () => {
      await page.getByRole("button", { name: /^Final review: .*Reply Passed/ }).click();
      await page.getByRole("button", { name: /Read review packet/ }).first().waitFor();
    });
    await at(390, 844, "roles=1&me=Ek", "heads-ws-paper-check-phone", async () => {
      await page.goto(`${origin}/hiring/paper-check/sample-token`);
      await page.getByRole("link", { name: "← My hiring list" }).waitFor();
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check("the Heads screen states on phone and desktop", async () => {
    const assertLeftEdge = async (...locators) => {
      const edges = await Promise.all(locators.map((locator) => locator.evaluate((node) => node.getBoundingClientRect().x)));
      assert.ok(Math.max(...edges) - Math.min(...edges) <= 1, `Uneven left edges: ${edges.join(", ")}`);
    };
    const title = page.getByRole("heading", { level: 1 });
    const headsEdge = () => assertLeftEdge(title, page.getByRole("heading", { name: /^Next mock/ }));
    await page.setViewportSize({ width: 1440, height: 900 });
    const head = page.getByRole("combobox", { name: "Head" });
    await page.goto(`${origin}/?view=heads&roles=1&me=Ek`);
    await page.getByRole("heading", { name: /^Next mock/ }).waitFor();
    await headsEdge();
    await shot(page, "heads-desktop");
    assert.deepEqual(await axeProblems(page), [], "axe on heads");
    // Reload at phone size: a resize alone can leave a stale paint in the screenshot.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?view=heads&roles=1&me=Ek`);
    await page.getByRole("heading", { name: /^Next mock/ }).waitFor();
    await headsEdge();
    await shot(page, "heads-phone");
    await page.goto(`${origin}/?view=heads&roles=1&headNext=1&me=Ek`);
    await page.getByRole("status").filter({ hasText: /Kru Ek · next mock .*11:00/ }).waitFor();
    const next = page.getByRole("navigation", { name: /hiring list/ }).locator("section").filter({ has: page.getByRole("heading", { name: /^Next mock/ }) });
    assert.match(await next.innerText(), /Reply Low/);
    assert.doesNotMatch(await next.innerText(), /Paper test/);
    // A paper test needs nothing from the head: it sits in a closed group of its own.
    const papers = page.locator("details").filter({ hasText: "Paper tests, no action" });
    await papers.locator("summary").click();
    assert.match(await papers.getByRole("listitem").filter({ hasText: "Sample Paper" }).innerText(), /Physics\s· Paper test/);
    assert.equal(await page.getByRole("link", { name: "Tutor onboarding and Experts access" }).count(), 0);
    await shot(page, "heads-next-phone");
    // Kru Peat's ended mocks: each line names its next step. Staff choose the head from the menu.
    for (const [width, height, size] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?view=heads&roles=1`);
      await head.selectOption({ label: "Kru Peat" });
      await page.getByRole("link", { name: /Record recommendation/ }).first().waitFor();
      const decided = page.getByRole("listitem").filter({ hasText: "Recommendation: Yes" });
      assert.equal(await decided.getByText("Scores sent", { exact: true }).count(), 0);
      await shot(page, `heads-peat-${size}`, size === "phone");
    }
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${origin}/?view=heads&roles=1`);
    assert.equal(await head.inputValue(), "Peat", "the browser remembers the head staff chose");
    const group = (title) => page.getByRole("navigation", { name: /hiring list/ }).locator("section").filter({ has: page.getByRole("heading", { name: new RegExp(`^${title}`) }) });
    for (const [title, name, note] of [
      ["Waiting", "Sample Lek", "Admin checking scores"],
      ...["Sample Fah", "Sample Nan", "Sample Wan"].map((name) => ["To do", name, /^Ask admin: /]),
    ]) {
      const line = group(title).getByRole("listitem").filter({ hasText: name });
      await line.getByText(note, typeof note === "string" ? { exact: true } : undefined).waitFor();
      const link = line.getByRole("link", { name: new RegExp(`^Interview brief: .*${name}`) });
      assert.match(await link.getAttribute("href"), /^\/hiring\/brief\/sample-token\?name=/);
      const target = await link.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44, `brief link is too small for ${name}`);
    }
    const dashboardFits = () => page.evaluate(() => [document.documentElement, document.querySelector("#root > div")].every((box) => box.scrollWidth <= box.clientWidth));
    assert.ok(await dashboardFits(), "Heads scrolls sideways at 320px");
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check("the Heads workspace never scrolls the whole page", async () => {
    // Hidden row text once escaped the list and made the page taller than the window; opening a row then moved the page.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Peat`);
    await page.getByRole("navigation", { name: /hiring list/ }).waitFor();
    const fits = () => page.evaluate(() => [document.documentElement.scrollHeight <= innerHeight, scrollY, document.querySelector("#root")?.scrollTop ?? 0]);
    assert.deepEqual(await fits(), [true, 0, 0]);
    await page.getByRole("navigation", { name: /hiring list/ }).getByRole("link", { name: /Sample Noi/ }).click();
    await page.frameLocator("iframe").first().getByRole("heading", { name: "Mock scores" }).waitFor();
    assert.deepEqual(await fits(), [true, 0, 0]);
    // Every group open, tags included: the list never scrolls sideways (critic review, round 15).
    for (const group of await page.locator("nav details").all()) await group.evaluate((element) => { element.open = true; });
    assert.ok(await page.getByRole("navigation", { name: /hiring list/ }).evaluate((nav) => nav.scrollWidth <= nav.clientWidth), "the list scrolls sideways");
  });
  await check("the brief's Next unscored button lands on the first unscored slider, clear of the send bar", async () => {
    // Inside the Heads workspace at 1280, where the form is narrowest on a laptop (critic review, round 17).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Ek`);
    await page.getByRole("navigation", { name: /hiring list/ }).getByRole("link", { name: /Reply Low/ }).click();
    const frame = page.frameLocator("#open-item iframe");
    await frame.getByRole("heading", { name: "Mock scores" }).waitFor();
    for (const i of [0, 1, 2]) await frame.getByRole("slider").nth(i).fill("7");
    await frame.getByRole("button", { name: "Next unscored" }).click();
    const brief = page.frames().find((candidate) => candidate.url().includes("/hiring/brief/"));
    const landed = await brief.evaluate(() => {
      const active = document.activeElement;
      const ranges = [...document.querySelectorAll('input[type="range"]')];
      const bar = document.querySelector("[data-sticky]").getBoundingClientRect();
      return { index: ranges.indexOf(active), value: active?.value, clear: active.getBoundingClientRect().bottom <= bar.top };
    });
    assert.deepEqual(landed, { index: 3, value: "0", clear: true });
  });
  await check("the brief keeps Next unscored at the end of the form and keeps an edit made after a send", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Ek`);
    const list = page.getByRole("navigation", { name: /hiring list/ });
    await list.getByRole("link", { name: /Reply Low/ }).click();
    const frame = page.frameLocator("#open-item iframe");
    await frame.getByRole("heading", { name: "Mock scores" }).waitFor();
    const sliders = frame.getByRole("slider");
    const count = await sliders.count();
    // A score skipped above the view: the cue stays at the end of the form (critic review, round 18).
    for (let i = 0; i < count; i += 1) if (i !== 2) await sliders.nth(i).fill("7");
    await sliders.nth(count - 1).scrollIntoViewIfNeeded();
    await frame.getByRole("button", { name: "Next unscored" }).waitFor();
    await sliders.nth(2).fill("7");
    await frame.getByText("Yes", { exact: true }).click();
    await frame.getByRole("button", { name: "Send scores" }).click();
    await frame.getByRole("button", { name: "Edit scores" }).click();
    await sliders.nth(0).fill("9");
    // Another row and back: the changed score is still there (sessionStorage for this tab).
    await list.getByRole("link", { name: /Sample Joy/ }).click();
    await page.frameLocator("#open-item iframe").getByRole("heading", { name: "Your marks", exact: false }).first().waitFor();
    await list.getByRole("link", { name: /Reply Low/ }).click();
    await frame.getByRole("heading", { name: "Mock scores" }).waitFor();
    assert.equal(await frame.getByRole("slider").nth(0).inputValue(), "9");
    // Discard puts the sent scores back (critic review, round 19).
    await frame.getByRole("button", { name: "Discard changes" }).click();
    await frame.getByRole("button", { name: "Edit scores" }).click();
    assert.equal(await frame.getByRole("slider").nth(0).inputValue(), "7");
  });
  await check("Check recommendation keeps focus while it checks and says when it is not open yet", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/hiring/brief/sample-token?brief=open&embed=1`);
    const button = page.getByRole("button", { name: "Check recommendation" });
    await button.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Checking…", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Check recommendation");
    await page.getByText("Not open yet. Recommend after the mock ends.").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Check recommendation");
  });
  await check("Discard changes shows on a phone with a full touch target", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/hiring/brief/sample-token?brief=open`);
    const sliders = page.getByRole("slider");
    await sliders.first().waitFor();
    for (let i = 0, n = await sliders.count(); i < n; i += 1) await sliders.nth(i).fill("7");
    await page.getByText("Yes", { exact: true }).click();
    await page.getByRole("button", { name: "Send scores" }).click();
    await page.getByRole("button", { name: "Edit scores" }).click();
    await sliders.nth(0).fill("9");
    const discard = page.getByRole("button", { name: "Discard changes" });
    await discard.waitFor();
    assert.ok((await discard.boundingBox()).height >= 44, "Discard changes is smaller than 44 px");
  });
  await check("a head's failed list load retries in place and lands focus on a visible area", async () => {
    // Tito's empty list hides the list column on a laptop, so focus goes to the open area (critic review, round 21).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Tito&head=Tito&failFirst=1`);
    const retry = page.getByRole("button", { name: "Try again" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "open-item");
  });
  await check("a mock that starts takes an untouched pane, work in the pane keeps it, and the list never says nothing to do under it", async () => {
    // The fixture's next mock for Ek starts 26 hours after the page opens; the clock jumps past it (critic review, round 22).
    for (const touch of [false, true]) {
      await page.clock.install();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${origin}/?roles=1&me=Ek`);
      const list = page.getByRole("navigation", { name: /hiring list/ });
      await list.getByRole("link", { name: /Sample Joy/ }).waitFor();
      if (touch) await page.frameLocator("#open-item iframe").locator("textarea").click();
      await page.clock.fastForward("26:05:00");
      await list.getByRole("heading", { name: /^Mock now/ }).waitFor();
      const current = await list.locator('[aria-current="true"]').innerText();
      assert.match(current, touch ? /Sample Joy/ : /Reply Low/);
      assert.equal(await list.getByText(/^Nothing to (do|score)/).count(), 0, "an empty To do shows under Mock now");
    }
  });
  await check("during a live mock an empty To do does not say there is nothing to do", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Ek&mockNow=1`);
    const list = page.getByRole("navigation", { name: /hiring list/ });
    await list.getByRole("link", { name: /Sample Joy/ }).click();
    await page.frameLocator("#open-item iframe").getByRole("button", { name: "Submit my marks" }).click();
    await list.getByRole("link", { name: /Sample Joy/ }).waitFor({ state: "detached" });
    await list.getByRole("heading", { name: /^Mock now/ }).waitFor();
    // Back to the mock: the saved receipt goes, and the empty To do must not take its place.
    await list.getByRole("link", { name: /Reply Low/ }).click();
    await page.frameLocator("#open-item iframe").getByRole("heading", { name: /Mock scores/ }).waitFor();
    assert.equal(await list.getByText(/^Nothing to (do|score)/).count(), 0);
  });
  await check("the list announces a save once and returns to the schedule when another row opens", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Ek`);
    await page.frameLocator("#open-item iframe").getByRole("button", { name: "Submit my marks" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('p.sr-only[role="status"]')].some((p) => p.textContent === "Marks saved for Sample Joy"));
    await page.getByRole("navigation", { name: /hiring list/ }).getByRole("link", { name: /Reply Low/ }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('p.sr-only[role="status"]')].some((p) => p.textContent?.startsWith("Marks saved")));
  });
  await check("the paper check's comment jump puts focus in the comment field", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/?roles=1&me=Ek`);
    const frame = page.frameLocator("#open-item iframe");
    await frame.getByRole("button", { name: "Go to the comment ↓" }).click();
    const paper = page.frames().find((candidate) => candidate.url().includes("/hiring/paper-check/"));
    assert.equal(await paper.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  });
  await check("Gift signs from her list on a phone and focus stays on the receipt", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?roles=1&me=Gift&gift=1&live=1`);
    await page.getByRole("button", { name: /^Final review: .*Reply Passed/ }).click();
    // The packet opens with the row, full screen; Back closes it and keeps the list.
    const close = page.getByRole("button", { name: "Close packet" });
    await close.waitFor();
    // Reading means the packet drew; Approve unlocks once the open packet is checked as current.
    await page.frameLocator("iframe[title^='Review packet']").getByText("Assessment summary").waitFor();
    await page.goBack();
    await close.waitFor({ state: "hidden" });
    await page.locator("button:not([disabled])", { hasText: "Approve and send offer" }).waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Approve and send offer" }).click();
    const receipt = "Offer approved. The offer email is queued.";
    await page.getByText(receipt).waitFor();
    await page.waitForFunction((text) => document.activeElement?.textContent === text, receipt);
    const finished = page.getByRole("navigation", { name: /hiring list/ }).locator("section").filter({ has: page.getByRole("heading", { name: /^Just finished/ }) });
    assert.equal(await finished.getByRole("button", { name: /Reply Passed/ }).count(), 1);
  });
  await check("the head and Gift screens render on phone and desktop", async () => {
    const onOneLine = (locator) => locator.evaluate((node) => {
      const text = document.createRange();
      text.selectNodeContents(node);
      return text.getClientRects().length === 1;
    });
    const assertLeftEdge = async (...locators) => {
      const edges = await Promise.all(locators.map((locator) => locator.evaluate((node) => node.getBoundingClientRect().x + (node.tagName === "P" ? parseFloat(getComputedStyle(node).paddingLeft) : 0))));
      assert.ok(Math.max(...edges) - Math.min(...edges) <= 1, `Uneven left edges: ${edges.join(", ")}`);
    };
    const title = page.getByRole("heading", { level: 1 });
    const headsEdge = () => assertLeftEdge(title, page.getByRole("heading", { name: /^Next mock/ }));
    // The brief page scrolls as a whole page, not inside the dashboard frame.
    // full: let the document grow for a full-page shot. Otherwise the page scrolls inside .page, as in production.
    const briefPage = async (state, width, height, full = true) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?brief=${state}`);
      await page.addStyleTag({ content: full ? "#root{height:auto!important;overflow:visible!important;padding:0!important}" : "#root{padding:0!important}" });
      await page.getByRole("heading", { name: "Sample Dao" }).waitFor();
    };
    for (const [state, message, button] of BRIEF_STATES) {
      await briefPage(state, 390, 844);
      assert.equal(await page.getByText(message, { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Yes, send to HR" }).count(), state === "closed" ? 1 : 0);
      assert.equal(await page.getByRole("button", { name: "Check again" }).count(), button === "Check again" ? 1 : 0);
      const resume = page.getByRole("link", { name: "Open résumé (PDF)" });
      assert.equal(await resume.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
      await shot(page, `brief-${state}-phone`, true);
      if (button) {
        await briefPage(state, 390, 844, false);
        const action = page.getByRole("button", { name: button });
        assert.ok(await action.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight && document.querySelector("main").scrollTop === 0));
        assert.equal(await action.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(20, 33, 61)");
        await shot(page, `brief-${state}-phone-fold`);
      }
    }
    await briefPage("open", 390, 844);
    await shot(page, "brief-open-phone", true);
    assert.deepEqual(await axeProblems(page), [], "axe on brief");
    await briefPage("open", 390, 844, false);
    await shot(page, "brief-open-phone-fold");
    // 14 score sliders, then the required Yes/No checks answer; Send scores stays disabled until both are done.
    const tiles = page.getByRole("slider");
    assert.equal(await tiles.count(), 14);
    assert.equal(await page.locator("#scores select").count(), 0);
    await page.getByRole("status").filter({ hasText: /^0\/14 scored$/ }).waitFor();
    assert.equal(await page.getByText(/^Suggested score/).count(), 0);
    const tick = page.getByRole("checkbox").first();
    await tick.check();
    await page.getByText(/^Suggested score: (4|7|10)\.$/).waitFor();
    assert.equal(await tick.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(20, 33, 61)");
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal(await tick.evaluate((el) => getComputedStyle(el).appearance), "auto");
    await page.emulateMedia({ forcedColors: "none" });
    for (let i = 0, n = await tiles.count(); i < n; i++) await tiles.nth(i).fill("8");
    await page.getByRole("status").filter({ hasText: "Answer the required checks to send." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send scores" }).isDisabled(), true);
    await page.locator("form label", { hasText: /^Yes$/ }).click();
    await page.getByRole("button", { name: /Send scores/ }).click();
    await page.getByText("112/140", { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('[role="group"][aria-label^="Scores sent"]'));
    assert.equal(await page.getByRole("status").filter({ hasText: "Scores sent" }).count(), 0);
    assert.ok(await page.getByRole("button", { name: "Yes, send to HR" }).isVisible());
    const recommendJump = page.getByRole("link", { name: "Go to recommendation" });
    assert.equal(await recommendJump.getAttribute("href"), "#recommendation");
    assert.equal(await recommendJump.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(20, 33, 61)");
    await shot(page, "brief-sent-phone");
    await page.getByRole("button", { name: "Edit scores" }).click();
    const firstScore = page.locator("#scores input[type=radio]").first();
    await page.waitForFunction(() => document.activeElement === document.querySelector("#scores input[type=radio]"));
    await firstScore.locator("..").click();
    await page.locator("[data-sticky]").getByRole("status").filter({ hasText: "Score changes not sent." }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Go to mock scores" }).getAttribute("href"), "#scores");
    assert.equal(await page.getByRole("link", { name: "Go to scores", exact: true }).count(), 0);
    const usesSent = page.getByRole("status").filter({ hasText: "Recommendation uses sent scores." });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await onOneLine(usesSent), `The sent score instruction wraps at ${width}px`);
    }
    await shot(page, "brief-unsent-phone");
    await page.evaluate(() => history.replaceState(null, "", "?brief=open&sendFailed=1"));
    await page.getByRole("button", { name: "Send scores" }).click();
    const failure = page.getByRole("alert").filter({ hasText: "The scores were not saved. Try again." });
    assert.equal(await failure.evaluate((el) => getComputedStyle(el).fontSize), "16px");
    await page.evaluate(() => history.replaceState(null, "", "?brief=open"));
    await page.getByRole("button", { name: "Send scores" }).click();
    await page.getByRole("button", { name: "Edit scores" }).waitFor();
    await page.getByRole("button", { name: "Yes, send to HR" }).click();
    await page.getByText(/Recommendation recorded/).first().waitFor();
    assert.equal(await page.getByRole("link", { name: /^Go to (mock scores|recommendation)$/ }).count(), 0);
    await page.addStyleTag({ content: "#root{height:auto!important;overflow:visible!important}" });
    await page.locator("main").evaluate((el) => { el.scrollTop = 0; });
    await shot(page, "brief-recommended-phone", true);
    await briefPage("open", 390, 844);
    await page.locator('summary[aria-label="Guide: what each score means for Accuracy of Information"]').click();
    await shot(page, "brief-bands-phone", true);
    await page.locator("summary", { hasText: "Interviewer guide" }).click();
    await shot(page, "brief-guide-phone", true);
    // The jump link lands with the first score row and the Send bar on screen; keyboard focus is visible.
    await briefPage("open", 390, 844, false);
    await page.getByRole("link", { name: "Go to mock scores" }).click();
    await page.waitForTimeout(400);
    await shot(page, "brief-jump-phone");
    await page.locator("#scores input[type=radio]").first().focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("radio", { name: "9", exact: true }).first().isChecked(), true);
    await shot(page, "brief-focus-phone");
    for (const width of [320, 390]) {
      await briefPage("closed", width, 700, false);
      const yes = page.getByRole("button", { name: "Yes, send to HR" });
      const no = page.getByRole("button", { name: "No, reject" });
      const reason = page.getByRole("textbox", { name: "Reason for No (5+ characters)" });
      assert.equal(await no.getAttribute("aria-describedby"), await reason.locator("xpath=../span").getAttribute("id"));
      await reason.fill("More practice needed.");
      const [yesBox, noBox, reasonBox] = await Promise.all([yes.boundingBox(), no.boundingBox(), reason.boundingBox()]);
      assert.ok(noBox.y >= yesBox.y + yesBox.height && yesBox.width === reasonBox.width && noBox.width === reasonBox.width);
      assert.ok(await onOneLine(yes) && await onOneLine(no), `Decision buttons wrap at ${width}px`);
      await briefPage("open", width, 700, false);
      // The page scrolls inside main (.page), as in production, so measure that box and the document.
      assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector("main")].every((box) => box.scrollWidth <= box.clientWidth)), `brief scrolls sideways at ${width}px`);
      if (width === 320) {
        await briefPage("open", width, 700);
        await shot(page, "brief-open-320", true);
      }
    }
    await briefPage("open", 1440, 900);
    await shot(page, "brief-open-desktop", true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const dashboardFits = () => page.evaluate(() => [document.documentElement, document.querySelector("#root > div")].every((box) => box.scrollWidth <= box.clientWidth));
    for (const [width, height, size] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?view=review&roles=1&gift=1`);
      await page.getByRole("button", { name: "Read review packet" }).first().waitFor();
      assert.equal(await title.textContent(), "Final review");
      await assertLeftEdge(title, page.locator("article").filter({ has: page.getByRole("heading", { name: "Reply Passed" }) }));
      assert.equal(await page.locator("header details").count(), 0);
      assert.equal(await page.getByText("Automation paused · Messages paused", { exact: true }).count(), 0);
      await page.getByText("Automation and Messages off", { exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "Ask Kevin to enable both." }).waitFor();
      await shot(page, `gift-review-${size}`);
      assert.deepEqual(await axeProblems(page), [], "axe on gift");
    }
    // With the switches on, Approve unlocks only after the packet is shown.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?view=hr&roles=1&gift=1&hr=1&live=1#review-r1`);
    const linkedHeading = page.getByRole("heading", { name: "Reply Passed" });
    await linkedHeading.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "Reply Passed");
    assert.ok(await page.getByRole("heading", { name: "Booked calls by day" }).isVisible());
    assert.ok(await linkedHeading.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }));
    await page.goto(`${origin}/?view=hr&roles=1&gift=1&live=1#review-r1`);
    await linkedHeading.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "Reply Passed");
    assert.equal(await page.getByRole("heading", { name: "Booked calls by day" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: /Reply (Passed|Low)/ }).first().textContent(), "Reply Passed");
    const approve = page.getByRole("button", { name: "Approve and send offer" }).first();
    await approve.waitFor();
    await page.getByText("Read the packet to unlock sign-off.", { exact: true }).waitFor();
    assert.equal(await approve.isDisabled(), true);
    await shot(page, "gift-review-unread-phone");
    await page.getByRole("button", { name: /Read review packet/ }).first().click();
    await page.frameLocator("iframe[title^='Review packet']").getByRole("heading", { name: "Hiring review" }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Approve and send offer" && !b.disabled));
    assert.ok(await page.getByRole("button", { name: "Close packet" }).evaluate((node) => document.activeElement === node), "Close packet is not focused: " + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
    await page.getByRole("button", { name: "Close packet" }).first().click();
    assert.equal(await approve.isEnabled(), true);
    // Close goes through history.back(), so focus lands a tick later.
    await page.waitForFunction(() => document.activeElement?.textContent === "Approve and send offer", null, { timeout: 3000 });
    assert.ok(await page.getByRole("button", { name: "Read packet again" }).isVisible());
    await page.getByText("Ready for sign-off.", { exact: true }).waitFor();
    const approveDescription = await approve.getAttribute("aria-describedby");
    assert.match(await page.locator(`[id="${approveDescription}"]`).getAttribute("class"), /sr-only/);
    await shot(page, "gift-review-ready-phone");
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("stale", "unknown");
      history.replaceState(null, "", url);
    });
    page.once("dialog", (dialog) => dialog.accept());
    await approve.click();
    await page.getByText("Could not check the packet just now.", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Check again" }).isEnabled());
    assert.equal(await approve.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.posted), []);
    await page.goto(`${origin}/?view=review&roles=1&gift=1&stale=1&live=1`);
    const read = page.getByRole("button", { name: "Read review packet" }).first();
    const reject = page.getByRole("button", { name: "Reject and inform candidate" }).first();
    await page.getByRole("status").filter({ hasText: "Evidence changed. Ask HR for a new packet." }).waitFor();
    const rejectionNote = page.getByRole("textbox", { name: "Rejection note (5+ characters)" }).first();
    // The note stays locked until the packet is read.
    assert.equal(await rejectionNote.isDisabled(), true);
    assert.equal(await approve.isDisabled(), true);
    assert.equal(await reject.isDisabled(), true);
    assert.equal(await read.isDisabled(), true);
    const checkAgain = page.getByRole("button", { name: "Check again" });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await checkAgain.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(20, 33, 61)");
      assert.equal((await checkAgain.boundingBox()).width, (await rejectionNote.boundingBox()).width);
    }
    await shot(page, "gift-review-stale-phone");
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.delete("stale");
      history.replaceState(null, "", url);
    });
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByText("Read the packet to unlock sign-off.", { exact: true }).waitFor();
    assert.equal(await approve.isDisabled(), true);
    assert.equal(await reject.isDisabled(), true);
    await read.click();
    await page.frameLocator("iframe[title^='Review packet']").getByRole("heading", { name: "Hiring review" }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Approve and send offer" && !b.disabled));
    await page.getByRole("button", { name: "Close packet" }).first().click();
    assert.equal(await reject.isEnabled(), true);
    page.once("dialog", (dialog) => dialog.accept());
    await reject.click();
    await page.getByRole("status").filter({ hasText: /^Application rejected\. The email is queued\.$/ }).waitFor();
    // Gift reads the packet in the page; sign-off unlocks only after it is shown (here Reject still needs a note).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?view=review&roles=1&gift=1`);
    await page.getByRole("button", { name: /Read review packet/ }).first().click();
    await page.frameLocator("iframe[title^='Review packet']").getByRole("heading", { name: "Hiring review" }).waitFor();
    await page.waitForTimeout(300);
    const packetRoot = page.frameLocator("iframe[title^='Review packet']").locator("html");
    const assertPacketFits = async (width) => {
      const reader = page.getByRole("dialog", { name: "Review packet for Reply Passed" });
      const header = reader.getByRole("button", { name: "Close packet" }).locator("..");
      // The name stays for screen readers only.
      assert.deepEqual(await header.evaluate((el) => [...el.children].filter((child) => child.getBoundingClientRect().width > 1).map((child) => child.textContent)), ["Close packet"], "packet header shows more than Close");
      assert.match(await header.evaluate((el) => getComputedStyle(el).justifyContent), /end$/);
      assert.ok(await page.locator("html").evaluate((root) => root.scrollWidth <= root.clientWidth), `Gift page scrolls sideways at ${width}px`);
      assert.ok(await packetRoot.evaluate(async (root) => {
        await root.ownerDocument.fonts.ready;
        return root.scrollWidth <= root.clientWidth;
      }), `Gift packet iframe scrolls sideways at ${width}px`);
      const gauges = await packetRoot.locator(".gauge").evaluateAll((nodes) => nodes.map((gauge) => {
        const svg = gauge.querySelector("svg").getBoundingClientRect();
        const ends = gauge.querySelector(".gauge-ends").getBoundingClientRect();
        const [zero, hundred] = gauge.querySelectorAll(".gauge-ends span");
        const score = gauge.querySelector(".gauge-value");
        const value = score.getBoundingClientRect();
        const number = score.querySelector("strong").getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(hundred);
        return ends.top >= svg.bottom && value.top >= ends.bottom && text.getClientRects().length === 1
          && zero.offsetTop === hundred.offsetTop && score.scrollWidth <= score.clientWidth && number.bottom <= value.bottom + 2;
      }));
      assert.deepEqual(gauges, [true, true, true], `Gauge labels and scores do not fit at ${width}px`);
      assert.equal(await packetRoot.locator(".stack-ends").evaluate((el) => getComputedStyle(el).fontSize), "14px");
      assert.equal(await packetRoot.locator(".rubric-group h3 span").first().evaluate((el) => getComputedStyle(el).fontSize), "16px");
    };
    await assertPacketFits(390);
    await shot(page, "gift-review-packet-phone");
    // The weighted breakdown with one evidence row open.
    await packetRoot.evaluate((root) => {
      const row = root.querySelector(".stack-key details");
      if (row) row.open = true;
      (row ?? root).scrollIntoView({ block: "center" });
    });
    await shot(page, "gift-review-packet-ats-phone");
    assert.ok(await packetRoot.evaluate((root) => root.scrollWidth <= root.clientWidth), "the packet scrolls sideways with evidence open");
    assert.deepEqual(await axeProblems(page), [], "axe on gift packet");
    await page.getByRole("button", { name: "Close packet" }).click();
    // Approve is blocked, so focus returns to the Read button.
    await page.waitForFunction(() => /Read (review packet|packet again)/.test(document.activeElement?.textContent ?? ""), null, { timeout: 3000 });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${origin}/?view=review&roles=1&gift=1`);
    await page.getByRole("button", { name: "Read review packet" }).first().waitFor();
    assert.ok(await dashboardFits(), "Gift review scrolls sideways at 320px");
    await shot(page, "gift-review-320");
    await page.getByRole("button", { name: /Read review packet/ }).first().click();
    await page.frameLocator("iframe[title^='Review packet']").getByRole("heading", { name: "Hiring review" }).waitFor();
    await assertPacketFits(320);
    await shot(page, "gift-review-packet-320");
    // The weighted breakdown with one evidence row open.
    await packetRoot.evaluate((root) => {
      const row = root.querySelector(".stack-key details");
      if (row) row.open = true;
      (row ?? root).scrollIntoView({ block: "center" });
    });
    await shot(page, "gift-review-packet-ats-320");
    assert.ok(await packetRoot.evaluate((root) => root.scrollWidth <= root.clientWidth), "the packet scrolls sideways with evidence open");
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check("walkthrough", async () => {
    // The three tasks, as a user does them, in each engine at two widths. It records numbers; the anchors are judged from metrics.json.
    const AXE_TAGS = { tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"], all: true, first: true };
    let wk;
    try {
      wk = await webkit.launch();
    } catch (error) {
      wk = { error: String(error.message).split("\n")[0] };
    }
    const task = async (engine, width, height, id) => {
      const context = await engine.newContext({ viewport: { width, height } });
      await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
      await context.addInitScript(installHelpers);
      const tab = await context.newPage();
      tab.on("pageerror", (error) => errors.push(error.message));
      const m = { taps: 0, scrollPx: 0, small: new Map(), tiny: new Map(), long: new Map(), minFont: 99, side: {}, states: new Set(), focusVisible: [], focusObscured: [], axe: new Set(), confirms: [] };
      const drain = async () => {
        m.scrollPx += await tab.evaluate(() => window.__scroll ?? 0);
        await tab.evaluate(() => { window.__scroll = 0; });
      };
      const snap = async () => {
        const r = await tab.evaluate(() => window.__m.snap());
        r.small.forEach((x) => m.small.set(`${x.name}|${x.w}|${x.h}`, x));
        r.tiny.forEach((x) => m.tiny.set(`${x.text}|${x.px}`, x));
        r.long.forEach((x) => m.long.set(x.text, x));
        m.minFont = Math.min(m.minFont, r.minFont);
        for (const [key, value] of Object.entries(r.side)) m.side[key] = m.side[key] || value;
        r.states.forEach((x) => m.states.add(x));
      };
      const axe = async (frame = tab, prefix = "") => {
        if (engine === chromium || engine === browser) (await axeProblems(frame, AXE_TAGS)).forEach((x) => m.axe.add(prefix + x));
      };
      const open = async (query) => {
        await drain();
        await tab.goto(`${origin}/?${query}`);
        await tab.addStyleTag({ content: "#root{padding:0!important}" });
      };
      // The first control of the task: how far below the fold, and the words above it.
      const first = async (loc, name, key = "") => {
        const found = await loc.evaluate((el) => window.__m.first(el));
        m[`${key}firstAction`] = name;
        m[`${key}scrollBeforeFirstActionPx`] = found.below;
        m[`${key}wordsAboveFirstAction`] = found.words;
      };
      const tap = async (loc, name) => {
        await tab.keyboard.press("Shift");
        const probe = await loc.evaluate((el) => window.__m.probe(el));
        if (!probe.focused || (probe.outline < 2 && !probe.shadow)) m.focusVisible.push({ name, outline: probe.outline, shadow: probe.shadow, focused: probe.focused });
        if (probe.over.length) m.focusObscured.push({ name, by: probe.over });
        await loc.click();
        m.taps++;
      };
      tab.on("dialog", (dialog) => {
        m.confirms.push(dialog.message());
        m.taps++;
        void dialog.accept();
      });
      try {
        if (id === "H1") {
          await open("brief=open");
          await tab.getByRole("heading", { name: "Sample Dao" }).waitFor();
          const jump = tab.getByRole("link", { name: "Go to mock scores" });
          await first(jump, "Go to mock scores");
          await snap();
          await axe();
          await tap(jump, "Go to mock scores");
          const tiles = tab.locator("form label:has(input[type=radio][value='8'])");
          for (let i = 0, n = await tiles.count(); i < n; i++) await tap(tiles.nth(i), `score 8, item ${i + 1}`);
          await snap();
          await tap(tab.locator("form label", { hasText: /^Yes$/ }), "required checks: Yes");
          await tap(tab.getByRole("button", { name: /Send scores/ }), "Send scores");
          await tab.getByText(/Scores sent/).first().waitFor();
          m.scoreReceipt = await tab.getByRole("group", { name: /Scores sent/ }).evaluate((receipt) => {
            const recommendation = document.getElementById("recommendation").querySelector("h2").getBoundingClientRect();
            return { topPx: Math.round(receipt.getBoundingClientRect().top), focused: document.activeElement === receipt,
              recommendationInView: recommendation.top >= 0 && recommendation.bottom <= innerHeight };
          });
          await snap();
          await tap(tab.getByRole("button", { name: "Yes, send to HR" }), "Yes, send to HR");
          await tab.getByText(/Recommendation recorded/).first().waitFor();
          await snap();
          await axe();
        } else if (id === "H2") {
          // A head opens /hiring: their own list, no name to choose. On a phone one tap opens the paper to re-mark.
          await open("roles=1&me=Ek");
          const check = tab.getByRole("link", { name: /^Re-mark paper: .*Sample Joy/ });
          await check.waitFor();
          await first(check, "Re-mark paper: Sample Joy");
          await snap();
          await axe();
          await tap(check, "Re-mark paper: Sample Joy");
          const back = tab.getByRole("link", { name: "← My hiring list" });
          await back.waitFor();
          await tab.addStyleTag({ content: "#root{padding:0!important}" });
          await snap();
          await axe();
          // One tap back. The fixture serves the same page for /hiring, so the list comes back from the head's own link.
          await tap(back, "← My hiring list");
          await tab.waitForURL(/\/hiring\?view=heads$/);
          m.returnVisit = { taps: 0, firstAction: m.firstAction, scrollBeforeFirstActionPx: m.scrollBeforeFirstActionPx, wordsAboveFirstAction: m.wordsAboveFirstAction };
        } else {
          await open("view=review&roles=1&gift=1&live=1");
          const read = tab.getByRole("button", { name: /Read review packet/ }).first();
          await read.waitFor();
          await first(read, "Read review packet");
          await snap();
          await axe();
          await tap(read, "Read review packet");
          const heading = tab.frameLocator("iframe[title^='Review packet']").getByRole("heading", { name: "Hiring review" });
          await heading.waitFor();
          await tab.waitForTimeout(300);
          const frame = tab.frames().find((f) => f !== tab.mainFrame());
          m.side.packet = await frame.evaluate(async () => { await document.fonts.ready; return document.documentElement.scrollWidth > document.documentElement.clientWidth; });
          await frame.evaluate(installHelpers);
          m.packet = await frame.evaluate(() => window.__m.fonts());
          assert.ok(m.packet.minFontPx >= 12, "Packet text is smaller than 12px");
          assert.equal(m.side.packet, false, "Packet iframe scrolls sideways");
          await snap();
          await axe();
          // The sandboxed iframe does not run axe, so the same packet HTML is checked in a page of its own.
          const packetTab = await context.newPage();
          await packetTab.setContent(await tab.evaluate(() => window.realPacket));
          await axe(packetTab, "packet: ");
          await packetTab.close();
          await tap(tab.getByRole("button", { name: "Close packet" }).first(), "Close packet");
          await tab.getByText("Ready for sign-off.").first().waitFor();
          await snap();
          await tap(tab.getByRole("button", { name: "Approve and send offer" }).first(), "Approve and send offer");
          await tab.getByRole("status").filter({ hasText: /^Offer approved\. The offer email is queued\.$/ }).waitFor();
          await snap();
        }
        await drain();
        const cap = (map, n) => [...map.values()].slice(0, n);
        const { small, tiny, long, axe: found, states, minFont, ...rest } = m;
        return { ...rest, smallTargets: cap(small, 60), minFontPx: minFont, tinyText: cap(tiny, 30), longSentences: cap(long, 20), sidewaysScroll: m.side, axe: [...found], states: [...states] };
      } finally {
        await context.close();
      }
    };
    const metrics = {};
    for (const [name, engine] of [["chromium", browser], ["webkit", wk]]) {
      if (engine.error) {
        metrics[name] = { error: engine.error };
        continue;
      }
      metrics[name] = {};
      for (const [width, height] of [[390, 844], [320, 700]]) {
        metrics[name][`${width}x${height}`] = {};
        // WALK=H2,G1 runs some tasks only (H1 still describes the brief before PR 365).
        for (const id of (process.env.WALK ?? "H1,H2,G1").split(",")) {
          process.stderr.write(`walkthrough ${name} ${width}x${height} ${id}\n`);
          metrics[name][`${width}x${height}`][id] = await task(engine, width, height, id);
        }
      }
    }
    await wk.close?.();
    await page.setViewportSize({ width: 390, height: 844 });
    const briefStates = {};
    for (const [state, message, button] of (process.env.WALK ?? "H1").includes("H1") ? BRIEF_STATES : []) {
      await page.goto(`${origin}/?brief=${state}`);
      await page.addStyleTag({ content: "#root{padding:0!important}" });
      const nextAction = button ? page.getByRole("button", { name: button }) : page.getByText(message, { exact: true });
      briefStates[state] = { nextAction: button ?? message, belowFoldPx: await nextAction.evaluate((el) =>
        Math.max(0, Math.ceil(el.getBoundingClientRect().bottom - innerHeight))) };
      assert.equal(briefStates[state].belowFoldPx, 0, `${state} next action is below the fold`);
    }
    metrics.chromium["390x844"].briefStates = briefStates;
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
    }
    for (const [name, sizes] of Object.entries(metrics)) {
      if (sizes.error) process.stdout.write(`  ${name}: ${sizes.error}\n`);
      for (const [size, tasks] of Object.entries(sizes.error ? {} : sizes)) for (const [id, r] of Object.entries(tasks)) {
        if (id === "briefStates") continue;
        const row = [name, size, id, `taps ${r.taps}`, `scroll ${Math.round(r.scrollPx)}`, `below ${r.scrollBeforeFirstActionPx}`, `words ${r.wordsAboveFirstAction}`, `small ${r.smallTargets.filter((x) => !x.inline).length}`, `font ${r.minFontPx}`, `long ${r.longSentences.length}`, `side ${Object.values(r.sidewaysScroll).some(Boolean)}`, `axe ${r.axe.length}`, `focus ${r.focusVisible.length}/${r.focusObscured.length}`];
        process.stdout.write(`  ${row.join(" | ")}\n`);
      }
    }
  });
  await check("the page has no script errors", async () => assert.deepEqual(errors, []));
  if (OUT && textDumps.size) {
    writeFileSync(path.join(OUT, "words.txt"), execFileSync("wc", ["-w", ...[...textDumps].sort()], { cwd: OUT }));
  }
} finally {
  await browser?.close();
  server.close();
}
