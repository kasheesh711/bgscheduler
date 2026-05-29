import { addDays } from "date-fns";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokTodayIso } from "@/lib/ai/scheduler";
import { getActiveSnapshotIdOrThrow } from "@/lib/data/active-snapshot";
import { getActiveCreditSnapshot } from "@/lib/credit-control/db";
import { ensureIndex } from "@/lib/search/index";
import { executeSearch } from "@/lib/search/engine";
import { parseTimeToMinutes } from "@/lib/normalization/timezone";
import {
  listVerifiedLineContactStudentLinks,
  type LineContactStudentLinkDto,
} from "@/lib/line/student-links";
import type {
  LineOperationalIntentType,
  LineWritebackStatus,
} from "@/lib/line/data";

const BANGKOK_TIME_ZONE = "Asia/Bangkok";
const WRITEBACK_VERIFIED = process.env.WISE_SESSION_OPERATIONS_VERIFIED === "true";

export interface LineOperationalIntentPayload {
  summary: string;
  targetDate?: string;
  targetStartTime?: string;
  resumeDate?: string;
  requestedNewDate?: string;
  requestedNewStartTime?: string;
  confidence: number;
  issues: string[];
  source: "deterministic";
}

export interface LineOperationalCandidateSession {
  wiseSessionId: string;
  wiseClassId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  packageName: string;
  subject: string;
  scheduledStartTime: string;
  scheduledEndTime: string | null;
  startLocalDate: string;
  startLocalTime: string;
  endLocalTime: string | null;
  durationMinutes: number;
  meetingStatus: string;
  teacherGroupId: string | null;
  teacherName: string | null;
  wiseTeacherId: string | null;
  location: string | null;
  score: number;
  reasons: string[];
}

export interface LineOperationalTeacherSuggestion {
  tutorGroupId: string;
  displayName: string;
  score: number;
  reasons: string[];
}

export interface LineOperationalWiseAction {
  id: string;
  type: "cancel_session" | "pause_sessions" | "resume_review" | "reschedule_session";
  label: string;
  wiseSessionIds: string[];
  wiseClassIds: string[];
  endpointVerified: boolean;
  dryRun: true;
  disabledReason: string | null;
  payload: Record<string, unknown>;
}

export interface LineOperationalReviewPlan {
  intentType: LineOperationalIntentType;
  intentPayload: LineOperationalIntentPayload;
  matchedStudentKeys: string[];
  candidateSessions: LineOperationalCandidateSession[];
  proposedWiseActions: LineOperationalWiseAction[];
  adminSelectedSessionIds: string[];
  writebackStatus: LineWritebackStatus;
  proposedDraft: string;
}

interface LoadedFutureSession {
  wiseSessionId: string;
  wiseClassId: string;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  packageName: string;
  subject: string;
  scheduledStartTime: Date;
  scheduledEndTime: Date | null;
  durationMinutes: number;
  meetingStatus: string;
  teacherGroupId: string | null;
  teacherName: string | null;
  wiseTeacherId: string | null;
  location: string | null;
}

const THAI_MONTHS = new Map([
  ["ม.ค.", 1],
  ["มค", 1],
  ["มกราคม", 1],
  ["ก.พ.", 2],
  ["กพ", 2],
  ["กุมภาพันธ์", 2],
  ["มี.ค.", 3],
  ["มีค", 3],
  ["มีนาคม", 3],
  ["เม.ย.", 4],
  ["เมย", 4],
  ["เมษายน", 4],
  ["พ.ค.", 5],
  ["พค", 5],
  ["พฤษภาคม", 5],
  ["มิ.ย.", 6],
  ["มิย", 6],
  ["มิถุนายน", 6],
  ["ก.ค.", 7],
  ["กค", 7],
  ["กรกฎาคม", 7],
  ["ส.ค.", 8],
  ["สค", 8],
  ["สิงหาคม", 8],
  ["ก.ย.", 9],
  ["กย", 9],
  ["กันยายน", 9],
  ["ต.ค.", 10],
  ["ตค", 10],
  ["ตุลาคม", 10],
  ["พ.ย.", 11],
  ["พย", 11],
  ["พฤศจิกายน", 11],
  ["ธ.ค.", 12],
  ["ธค", 12],
  ["ธันวาคม", 12],
]);

function normalize(value: string | null | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function compactKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9ก-๙.]/g, "");
}

function bangkokDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function bangkokTime(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function bangkokInstant(date: string, time = "00:00"): Date {
  return new Date(`${date}T${time}:00+07:00`);
}

function normalizeYear(raw: number, todayYear: number): number {
  if (raw > 2400) return raw - 543;
  if (raw >= 100) return raw;
  if (raw >= 60 && raw <= 99) return 2500 + raw - 543;
  if (raw >= 0 && raw <= 40) return 2000 + raw;
  return todayYear;
}

function isoDateFromParts(day: number, month: number, year: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateFromText(text: string, today = bangkokTodayIso()): string | undefined {
  const normalized = normalize(text);
  if (normalized.includes("พรุ่งนี้") || /\btomorrow\b/i.test(text)) {
    return bangkokDate(addDays(bangkokInstant(today), 1));
  }

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return isoDateFromParts(Number(iso[3]), Number(iso[2]), Number(iso[1]));

  const todayDate = bangkokInstant(today);
  const todayYear = Number(today.slice(0, 4));
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = numeric[3] ? normalizeYear(Number(numeric[3]), todayYear) : todayYear;
    return isoDateFromParts(day, month, year);
  }

  for (const [label, month] of THAI_MONTHS.entries()) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`(?:วันที่\\s*)?(\\d{1,2})\\s*${escaped}`, "i"));
    if (match) return isoDateFromParts(Number(match[1]), month, todayYear);
  }

  const bareDay = text.match(/(?:วันที่|ที่)\s*(\d{1,2})(?!\s*[:.\-/])/);
  if (bareDay) {
    const day = Number(bareDay[1]);
    const thisMonth = todayDate.getMonth() + 1;
    const thisYear = todayDate.getFullYear();
    const candidate = isoDateFromParts(day, thisMonth, thisYear);
    if (!candidate) return undefined;
    if (candidate >= today) return candidate;
    const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;
    return isoDateFromParts(day, nextMonth, nextYear);
  }

  return undefined;
}

function parseTimeFromText(text: string): string | undefined {
  const exact = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (exact) return `${String(Number(exact[1])).padStart(2, "0")}:${exact[2]}`;

  const amPm = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (amPm) {
    let hour = Number(amPm[1]);
    const suffix = amPm[2].toLowerCase();
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) return `${String(hour).padStart(2, "0")}:00`;
  }

  const thaiHour = text.match(/(?:เวลา|ตอน)\s*(\d{1,2})(?!\s*[:.])/);
  if (thaiHour) {
    const hour = Number(thaiHour[1]);
    if (hour >= 0 && hour <= 23) return `${String(hour).padStart(2, "0")}:00`;
  }
  return undefined;
}

function addMinutesToTime(time: string, minutes: number): string {
  const total = parseTimeToMinutes(time) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function parseResumeDate(text: string): string | undefined {
  if (/ปลายเดือน|end of month|end of/i.test(text)) return undefined;
  return parseDateFromText(text);
}

export function inferLineOperationalIntent(
  messageText: string,
  classifierCategory: string,
): { intentType: LineOperationalIntentType; payload: LineOperationalIntentPayload } {
  const targetDate = parseDateFromText(messageText);
  const targetStartTime = parseTimeFromText(messageText);
  const issues: string[] = [];

  let intentType: LineOperationalIntentType = classifierCategory === "scheduling_request"
    ? "new_request"
    : "unclear_change";
  if (/(เลื่อน|ย้าย|เปลี่ยนเวลา|เปลี่ยนวัน|resched|move|change.+time|change.+date)/i.test(messageText)) {
    intentType = "reschedule";
  } else if (/(ขอหยุด|งด|ยกเลิก|cancel|skip|can't attend|cannot attend)/i.test(messageText) && /(เปิดเทอม|จนถึง|ถึงวันที่|until|pause|พัก|break)/i.test(messageText)) {
    intentType = "pause_until";
  } else if (/(เริ่มเรียนอีกที|กลับมาเรียน|resume|restart)/i.test(messageText)) {
    intentType = "resume";
  } else if (/(ขอหยุด|งด|ยกเลิก|cancel|skip|can't attend|cannot attend)/i.test(messageText)) {
    intentType = "cancel_one_off";
  }

  const resumeDate = intentType === "pause_until" || intentType === "resume"
    ? parseResumeDate(messageText)
    : undefined;
  if (intentType === "pause_until" && !resumeDate) {
    issues.push("Pause request needs an exact resume date before selecting classes to cancel.");
  }
  if ((intentType === "cancel_one_off" || intentType === "reschedule") && !targetDate) {
    issues.push("Request needs an exact target class date before a Wise class can be selected.");
  }

  return {
    intentType,
    payload: {
      summary: messageText.trim().slice(0, 280),
      targetDate,
      targetStartTime,
      resumeDate,
      requestedNewDate: intentType === "reschedule" ? targetDate : undefined,
      requestedNewStartTime: intentType === "reschedule" ? targetStartTime : undefined,
      confidence: intentType === "unclear_change" ? 0.35 : 0.82,
      issues,
      source: "deterministic",
    },
  };
}

function linkMentionScore(link: LineContactStudentLinkDto, messageText: string): number {
  const message = compactKey(messageText);
  const tokens = [
    link.studentName,
    link.studentName.split(".")[0],
    link.studentKey.split("::")[0],
  ].map(compactKey).filter(Boolean);
  return tokens.some((token) => token.length >= 3 && message.includes(token)) ? 1 : 0;
}

function chooseStudentLinks(input: {
  links: LineContactStudentLinkDto[];
  messageText: string;
}): { selected: LineContactStudentLinkDto[]; issues: string[] } {
  if (input.links.length === 0) {
    return { selected: [], issues: ["Verify this LINE contact's student code before suggesting operational Wise actions."] };
  }
  if (input.links.length === 1) return { selected: input.links, issues: [] };

  const mentioned = input.links.filter((link) => linkMentionScore(link, input.messageText) > 0);
  if (mentioned.length === 1) return { selected: mentioned, issues: [] };
  return {
    selected: [],
    issues: ["Multiple verified children are linked to this LINE contact. Select the child before applying this operation."],
  };
}

export function selectVerifiedStudentLinksForOperationalMessage(input: {
  links: LineContactStudentLinkDto[];
  messageText: string;
}): { selected: LineContactStudentLinkDto[]; issues: string[] } {
  return chooseStudentLinks(input);
}

export function selectPauseSessionsBeforeResumeDate(
  sessions: LineOperationalCandidateSession[],
  resumeDate: string,
): LineOperationalCandidateSession[] {
  const resumeBoundary = bangkokInstant(resumeDate);
  return sessions.filter((session) => new Date(session.scheduledStartTime) < resumeBoundary);
}

async function loadFutureSessionsForStudents(
  db: Database,
  wiseStudentIds: string[],
): Promise<LoadedFutureSession[]> {
  if (wiseStudentIds.length === 0) return [];
  const creditSnapshot = await getActiveCreditSnapshot(db);
  if (!creditSnapshot) return [];
  const snapshotId = await getActiveSnapshotIdOrThrow(db).catch(() => null);
  const conditions = [
    eq(schema.creditControlSessions.snapshotId, creditSnapshot.id),
    eq(schema.creditControlSessions.sessionKind, "future"),
    inArray(schema.creditControlSessions.wiseStudentId, wiseStudentIds),
    gte(schema.creditControlSessions.scheduledStartTime, new Date()),
  ];

  const rows = await db
    .select({
      wiseSessionId: schema.creditControlSessions.wiseSessionId,
      wiseClassId: schema.creditControlSessions.wiseClassId,
      wiseStudentId: schema.creditControlSessions.wiseStudentId,
      studentKey: schema.creditControlSessions.studentKey,
      studentName: schema.creditControlSessions.studentName,
      packageName: schema.creditControlSessions.packageName,
      subject: schema.creditControlSessions.subject,
      scheduledStartTime: schema.creditControlSessions.scheduledStartTime,
      scheduledEndTime: schema.creditControlSessions.scheduledEndTime,
      durationMinutes: schema.creditControlSessions.durationMinutes,
      meetingStatus: schema.creditControlSessions.meetingStatus,
      teacherGroupId: schema.futureSessionBlocks.groupId,
      teacherName: schema.tutorIdentityGroups.displayName,
      wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId,
      location: schema.futureSessionBlocks.location,
    })
    .from(schema.creditControlSessions)
    .leftJoin(
      schema.futureSessionBlocks,
      and(
        eq(schema.futureSessionBlocks.wiseSessionId, schema.creditControlSessions.wiseSessionId),
        snapshotId ? eq(schema.futureSessionBlocks.snapshotId, snapshotId) : undefined,
      ),
    )
    .leftJoin(schema.tutorIdentityGroups, eq(schema.tutorIdentityGroups.id, schema.futureSessionBlocks.groupId))
    .where(and(...conditions))
    .orderBy(schema.creditControlSessions.scheduledStartTime);

  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.wiseSessionId}:${row.wiseStudentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      ...row,
      teacherGroupId: row.teacherGroupId ?? null,
      teacherName: row.teacherName ?? null,
      wiseTeacherId: row.wiseTeacherId ?? null,
      location: row.location ?? null,
    }));
}

function scoreSession(
  session: LoadedFutureSession,
  payload: LineOperationalIntentPayload,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const localDate = bangkokDate(session.scheduledStartTime);
  const localTime = bangkokTime(session.scheduledStartTime);
  if (payload.targetDate && localDate === payload.targetDate) {
    score += 60;
    reasons.push(`same date ${payload.targetDate}`);
  }
  if (payload.targetStartTime) {
    const delta = Math.abs(parseTimeToMinutes(localTime) - parseTimeToMinutes(payload.targetStartTime));
    if (delta <= 15) {
      score += 30;
      reasons.push(`same time ${payload.targetStartTime}`);
    }
  }
  return { score, reasons };
}

function candidateFromSession(
  session: LoadedFutureSession,
  payload: LineOperationalIntentPayload,
): LineOperationalCandidateSession {
  const scored = scoreSession(session, payload);
  return {
    wiseSessionId: session.wiseSessionId,
    wiseClassId: session.wiseClassId,
    wiseStudentId: session.wiseStudentId,
    studentKey: session.studentKey,
    studentName: session.studentName,
    packageName: session.packageName,
    subject: session.subject,
    scheduledStartTime: session.scheduledStartTime.toISOString(),
    scheduledEndTime: session.scheduledEndTime?.toISOString() ?? null,
    startLocalDate: bangkokDate(session.scheduledStartTime),
    startLocalTime: bangkokTime(session.scheduledStartTime),
    endLocalTime: session.scheduledEndTime ? bangkokTime(session.scheduledEndTime) : null,
    durationMinutes: session.durationMinutes,
    meetingStatus: session.meetingStatus,
    teacherGroupId: session.teacherGroupId,
    teacherName: session.teacherName,
    wiseTeacherId: session.wiseTeacherId,
    location: session.location,
    score: scored.score,
    reasons: scored.reasons,
  };
}

function actionDisabledReason(): string | null {
  return WRITEBACK_VERIFIED ? null : "Wise cancel/reschedule endpoint contract is not verified in this environment.";
}

function buildAction(input: {
  id: string;
  type: LineOperationalWiseAction["type"];
  label: string;
  sessions: LineOperationalCandidateSession[];
  payload: Record<string, unknown>;
}): LineOperationalWiseAction {
  return {
    id: input.id,
    type: input.type,
    label: input.label,
    wiseSessionIds: input.sessions.map((session) => session.wiseSessionId),
    wiseClassIds: [...new Set(input.sessions.map((session) => session.wiseClassId))],
    endpointVerified: WRITEBACK_VERIFIED,
    dryRun: true,
    disabledReason: actionDisabledReason(),
    payload: input.payload,
  };
}

function writebackStatusFor(actions: LineOperationalWiseAction[]): LineWritebackStatus {
  if (actions.length === 0) return "not_applicable";
  return actions.every((action) => action.endpointVerified) ? "ready" : "manual_required";
}

function parentDraftForOperationalPlan(input: {
  intentType: LineOperationalIntentType;
  ready: boolean;
  candidateCount: number;
}): string {
  if (input.intentType === "cancel_one_off") {
    return input.ready
      ? "รับทราบค่ะ เดี๋ยวทางทีมขอตรวจสอบและดำเนินการยกเลิกคลาสให้นะคะ"
      : "รับทราบค่ะ เดี๋ยวทางทีมขอตรวจสอบคลาสที่ต้องยกเลิกและยืนยันกลับไปนะคะ";
  }
  if (input.intentType === "pause_until") {
    return input.ready
      ? "รับทราบค่ะ เดี๋ยวทางทีมขอตรวจสอบรายการคลาสที่จะพักและยืนยันกลับไปนะคะ"
      : "รับทราบค่ะ ขอทีมตรวจสอบวันเริ่มเรียนอีกครั้งก่อนดำเนินการพักคลาสนะคะ";
  }
  if (input.intentType === "reschedule") {
    return input.ready
      ? "รับทราบค่ะ เดี๋ยวทางทีมเช็กเวลาเรียนใหม่กับคุณครูและยืนยันกลับไปนะคะ"
      : "รับทราบค่ะ ขอทีมตรวจสอบคลาสเดิมและตัวเลือกเวลาใหม่ก่อนยืนยันนะคะ";
  }
  if (input.intentType === "resume") {
    return input.candidateCount > 0
      ? "รับทราบค่ะ เดี๋ยวทางทีมตรวจสอบคลาสถัดไปและยืนยันกลับไปนะคะ"
      : "รับทราบค่ะ เดี๋ยวทางทีมเช็กตารางสำหรับเริ่มเรียนใหม่และยืนยันกลับไปนะคะ";
  }
  return "รับทราบค่ะ เดี๋ยวทางทีมตรวจสอบรายละเอียดและยืนยันกลับไปนะคะ";
}

async function rescheduleTeacherSuggestions(input: {
  db: Database;
  candidate: LineOperationalCandidateSession | null;
  payload: LineOperationalIntentPayload;
}): Promise<LineOperationalTeacherSuggestion[]> {
  if (!input.candidate?.teacherGroupId) return [];
  const index = await ensureIndex(input.db).catch(() => null);
  if (!index) return [];
  const original = index.tutorGroups.find((group) => group.id === input.candidate?.teacherGroupId);
  if (!original) return [];

  const filters = { subject: input.candidate.subject || undefined };
  const targetDate = input.payload.requestedNewDate;
  const targetStart = input.payload.requestedNewStartTime;
  const sameTeacherAvailable = targetDate && targetStart
    ? executeSearch(index, {
      searchMode: "one_time",
      slots: [{
        id: "requested-reschedule",
        date: targetDate,
        start: targetStart,
        end: addMinutesToTime(targetStart, Math.max(30, input.candidate.durationMinutes || 60)),
        mode: "either",
      }],
      filters,
    }).perSlotResults[0]?.available.some((tutor) => tutor.tutorGroupId === original.id)
    : false;

  if (sameTeacherAvailable) {
    return [{
      tutorGroupId: original.id,
      displayName: original.displayName,
      score: 100,
      reasons: ["Original teacher is available for the requested replacement time."],
    }];
  }

  const originalProfile = original.businessProfile;
  return index.tutorGroups
    .filter((group) => group.id !== original.id)
    .map((group) => {
      let score = 0;
      const reasons: string[] = [];
      if (input.candidate?.subject && group.qualifications.some((q) => normalize(q.subject) === normalize(input.candidate?.subject))) {
        score += 50;
        reasons.push(`Wise qualification match: ${input.candidate.subject}`);
      }
      const strengthOverlap = new Set((originalProfile?.strengthTags ?? []).map(normalize));
      for (const tag of group.businessProfile?.strengthTags ?? []) {
        if (strengthOverlap.has(normalize(tag))) score += 8;
      }
      const styleOverlap = new Set((originalProfile?.teachingStyleTags ?? []).map(normalize));
      for (const tag of group.businessProfile?.teachingStyleTags ?? []) {
        if (styleOverlap.has(normalize(tag))) score += 5;
      }
      if (score > 50) reasons.push("Tutor profile overlaps with original teacher.");
      return { tutorGroupId: group.id, displayName: group.displayName, score, reasons };
    })
    .filter((suggestion) => suggestion.score > 0)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .slice(0, 3);
}

export async function buildLineOperationalReviewPlan(input: {
  db: Database;
  contactId: string;
  messageText: string;
  classifierCategory: string;
}): Promise<LineOperationalReviewPlan> {
  const { intentType, payload } = inferLineOperationalIntent(input.messageText, input.classifierCategory);
  if (intentType === "new_request") {
    return {
      intentType,
      intentPayload: payload,
      matchedStudentKeys: [],
      candidateSessions: [],
      proposedWiseActions: [],
      adminSelectedSessionIds: [],
      writebackStatus: "not_applicable",
      proposedDraft: "",
    };
  }

  const verifiedLinks = await listVerifiedLineContactStudentLinks(input.db, input.contactId);
  const selectedLinks = chooseStudentLinks({ links: verifiedLinks, messageText: input.messageText });
  const issues = [...payload.issues, ...selectedLinks.issues];
  const sessions = await loadFutureSessionsForStudents(
    input.db,
    selectedLinks.selected.map((link) => link.wiseStudentId),
  );

  let candidateSessions: LineOperationalCandidateSession[] = [];
  let proposedWiseActions: LineOperationalWiseAction[] = [];
  if (intentType === "pause_until" && payload.resumeDate) {
    const resumeBoundary = bangkokInstant(payload.resumeDate);
    candidateSessions = sessions
      .filter((session) => session.scheduledStartTime < resumeBoundary)
      .map((session) => candidateFromSession(session, payload));
    if (candidateSessions.length > 0) {
      proposedWiseActions = [buildAction({
        id: "pause-before-resume",
        type: "pause_sessions",
        label: `Cancel ${candidateSessions.length} class${candidateSessions.length === 1 ? "" : "es"} before ${payload.resumeDate}`,
        sessions: candidateSessions,
        payload: { resumeDate: payload.resumeDate },
      })];
    }
  } else if (intentType === "resume") {
    const boundary = payload.resumeDate ? bangkokInstant(payload.resumeDate) : new Date();
    candidateSessions = sessions
      .filter((session) => session.scheduledStartTime >= boundary)
      .slice(0, 3)
      .map((session) => candidateFromSession(session, payload));
    if (candidateSessions.length > 0) {
      proposedWiseActions = [buildAction({
        id: "resume-review",
        type: "resume_review",
        label: "Review next scheduled class after resume request",
        sessions: candidateSessions.slice(0, 1),
        payload: { resumeDate: payload.resumeDate ?? null },
      })];
    }
  } else {
    candidateSessions = sessions
      .map((session) => candidateFromSession(session, payload))
      .filter((session) => session.score > 0)
      .sort((a, b) => b.score - a.score || a.scheduledStartTime.localeCompare(b.scheduledStartTime))
      .slice(0, 5);
    const ready = candidateSessions.length === 1 && candidateSessions[0].score >= 60 && issues.length === 0;
    if (ready) {
      const top = candidateSessions[0];
      const suggestions = intentType === "reschedule"
        ? await rescheduleTeacherSuggestions({ db: input.db, candidate: top, payload })
        : [];
      proposedWiseActions = [buildAction({
        id: intentType === "reschedule" ? "reschedule-target-session" : "cancel-target-session",
        type: intentType === "reschedule" ? "reschedule_session" : "cancel_session",
        label: intentType === "reschedule"
          ? `Reschedule ${top.studentName}'s ${top.startLocalDate} ${top.startLocalTime} class`
          : `Cancel ${top.studentName}'s ${top.startLocalDate} ${top.startLocalTime} class`,
        sessions: [top],
        payload: {
          targetSession: top,
          replacementTeachers: suggestions,
          requestedNewDate: payload.requestedNewDate ?? null,
          requestedNewStartTime: payload.requestedNewStartTime ?? null,
        },
      })];
    } else if (candidateSessions.length > 1) {
      issues.push("Multiple future classes match this request. Admin must select the correct class.");
    }
  }

  const ready = issues.length === 0 && proposedWiseActions.length > 0;
  return {
    intentType,
    intentPayload: { ...payload, issues },
    matchedStudentKeys: selectedLinks.selected.map((link) => link.studentKey),
    candidateSessions,
    proposedWiseActions,
    adminSelectedSessionIds: proposedWiseActions.flatMap((action) => action.wiseSessionIds),
    writebackStatus: writebackStatusFor(proposedWiseActions),
    proposedDraft: parentDraftForOperationalPlan({
      intentType,
      ready,
      candidateCount: candidateSessions.length,
    }),
  };
}
