// ----------------------------------------------------------------------------
// LINE feedback bot — `/feedback <code> [subject]` replies with the student's
// five most recent ended classes in ONE subject, from all tutors, and the
// latest stored tutor feedback for each.
//
//   FB-BOT-S1  Subject. Without a subject word, the subject is that of the
//              most recent class the chat's own tutor had with the student.
//              The subject exists only in the Wise class title ("In-Person
//              Session-Chemistry"), read from classroom_assignment_rows. A
//              class with no stored title cannot be matched and is left out.
//
// Unlike /credit and /report, any member of the chat may use it (owner
// decision 2026-11-14): teachers are the audience. The gate is on the chat:
//
//   FB-BOT-G1  Registered teacher chats only, fail closed AND fully silent.
//              The group must be an enabled row of progress_line_groups (an
//              allowlisted admin registered it with `/progress setup <key>`),
//              and the bot that received the message must be the bot that
//              serves that tutor. All other chats get NO reply, help included:
//              the reply shows feedback text and must never reach a parent
//              chat. The bot check also means that one bot answers when both
//              bots are in the same chat.
//
//   FB-BOT-L1  Link. The reply carries a link to /feedback/<token>, a public
//              page with the same classes and the full text. The token is
//              signed with AUTH_SECRET, names one student code and one
//              subject, and expires after 24 hours (owner decision
//              2026-11-14). The page reads the data again on each visit.
//
//   FB-BOT-P1  School and year. Read live from the student's Wise registration
//              form (one GET, 8 s limit). They are extra context only: when
//              Wise does not answer, the reply and the page leave them out.
//
// The classes come from Postgres only (never the credit snapshot).
// ----------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, ilike, inArray, isNull, lte } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { APP_BASE_URL } from "@/lib/leave-requests/config";
import { replyLineMessage } from "@/lib/line/client";
import { progressUsesTutorBot } from "@/lib/line/progress-reminders";
import { createWiseClient } from "@/lib/wise/client";
import { fetchWiseStudentRegistrationData } from "@/lib/wise/fetchers";

const CLASS_LIMIT = 5;
/** Recent classes scanned for the subject match. shortcut: a subject older than this many classes is not found; raise if teachers report it. */
const SCAN_LIMIT = 200;
/** 5 classes × (this + a short header), plus the link and the school line, stays under LINE's 5,000-character text limit. */
const MAX_FEEDBACK_CHARS = 700;

const LINK_HOURS = 24;

const FEEDBACK_PATTERN = /^\/feedback(?:\s+(.*))?$/i;
/** `<code> [subject words]`. */
const COMMAND_PATTERN = /^([A-Za-z0-9._\-\u0E00-\u0E7F]{2,40})(?:\s+(.{1,40}))?$/;

const FEEDBACK_HELP =
  "Type /feedback and the student code, for example: /feedback Tara.Ta\n" +
  "To select a subject, add it: /feedback Tara.Ta math\n" +
  "พิมพ์ /feedback ตามด้วยรหัสนักเรียน เช่น /feedback Tara.Ta";

const FEEDBACK_FIELDS = [
  ["topics", "Topics"],
  ["performance", "Performance"],
  ["improvement", "Needs work"],
  ["homework", "Homework"],
] as const;

const feedbackClassTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export type FeedbackBotAction =
  | "feedback_silent_chat"
  | "feedback_help"
  | "feedback_not_found"
  | "feedback_no_subject"
  | "feedback_reply";

export interface FeedbackClassRow {
  wiseSessionId: string;
  wiseStudentId: string | null;
  studentName: string;
  tutorKey: string | null;
  tutorName: string | null;
  scheduledStartAt: Date;
  topics: string | null;
  performance: string | null;
  improvement: string | null;
  homework: string | null;
}

/** "In-Person Session- Com sci" → "Com sci". A title without "Session" is returned whole. */
export function titleSubject(title: string): string {
  return title.replace(/^.*?session[\s-]*/i, "").replace(/\s+/g, " ").trim();
}

const subjectKey = (subject: string) => subject.toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, "");

export type FeedbackSelection =
  | { status: "ok"; subject: string; rows: FeedbackClassRow[] }
  | { status: "no_subject"; subjects: string[] };

/**
 * FB-BOT-S1. `rows` are newest first; `titles` maps a Wise session id to its
 * class title. A typed subject matches the most recent class whose subject
 * contains it ("chem" → Chemistry); the reply then holds that one subject only.
 */
export function selectSubjectClasses(
  rows: readonly FeedbackClassRow[],
  titles: ReadonlyMap<string, string>,
  chatTutorKey: string,
  wanted: string,
  exact = false,
): FeedbackSelection {
  const withSubject = rows
    .map((row) => ({ row, subject: titleSubject(titles.get(row.wiseSessionId) ?? "") }))
    .filter((entry) => subjectKey(entry.subject));
  const wantedKey = subjectKey(wanted);
  const anchor = withSubject.find((entry) =>
    !wantedKey ? entry.row.tutorKey === chatTutorKey
      : exact ? subjectKey(entry.subject) === wantedKey
      : subjectKey(entry.subject).includes(wantedKey));
  if (!anchor) {
    const subjects = new Map(withSubject.map((entry) => [subjectKey(entry.subject), entry.subject]));
    return { status: "no_subject", subjects: [...subjects.values()].slice(0, 10) };
  }
  const key = subjectKey(anchor.subject);
  return {
    status: "ok",
    subject: anchor.subject,
    rows: withSubject.filter((entry) => subjectKey(entry.subject) === key).slice(0, CLASS_LIMIT).map((entry) => entry.row),
  };
}

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(`feedback-link:${payload}`).digest();

/** FB-BOT-L1. Null when AUTH_SECRET is not set: the reply then has no link. */
export function feedbackLinkToken(
  code: string,
  subject: string,
  now: Date,
  secret = process.env.AUTH_SECRET,
): string | null {
  if (!secret) return null;
  const exp = Math.floor(now.getTime() / 1000) + LINK_HOURS * 3600;
  const payload = Buffer.from(JSON.stringify({ c: code, s: subject, exp })).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

/** Null for every failure (malformed, wrong signature, expired), so the page gives one answer. */
export function readFeedbackLinkToken(
  token: string,
  now = new Date(),
  secret = process.env.AUTH_SECRET,
): { code: string; subject: string; expiresAt: Date } | null {
  try {
    if (!secret || token.length > 600) return null;
    const [payload, signature, extra] = token.split(".");
    const expected = sign(payload, secret);
    const actual = Buffer.from(signature ?? "", "base64url");
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as { c?: unknown; s?: unknown; exp?: unknown };
    if (typeof value.c !== "string" || typeof value.s !== "string" || typeof value.exp !== "number") return null;
    if (value.exp <= now.getTime() / 1000) return null;
    return { code: value.c, subject: value.s, expiresAt: new Date(value.exp * 1000) };
  } catch {
    return null;
  }
}

/** Wise registration form question ids ("School Name", "Current Year/Grade level"). */
const WISE_SCHOOL_FIELD_ID = "5l92yygp";
const WISE_YEAR_FIELD_ID = "if89sblj";

export interface StudentProfile {
  school: string;
  year: string;
}

async function fetchRegistrationFields(wiseStudentId: string) {
  const client = createWiseClient({ signal: AbortSignal.timeout(8000) });
  const data = await fetchWiseStudentRegistrationData(
    client,
    process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413",
    wiseStudentId,
  );
  return data.registrationData?.fields ?? [];
}

/** FB-BOT-P1. Never throws: blank values mean "not known". */
export async function loadStudentProfile(
  wiseStudentId: string | null | undefined,
  fetchFields: typeof fetchRegistrationFields = fetchRegistrationFields,
): Promise<StudentProfile> {
  if (!wiseStudentId) return { school: "", year: "" };
  try {
    const fields = await fetchFields(wiseStudentId);
    const answer = (id: string) => String(fields.find((field) => field.questionId === id)?.answer ?? "").trim().slice(0, 80);
    return { school: answer(WISE_SCHOOL_FIELD_ID), year: answer(WISE_YEAR_FIELD_ID) };
  } catch (error) {
    console.error("LINE feedback: Wise student profile read failed", error instanceof Error ? error.name : "Error");
    return { school: "", year: "" };
  }
}

export function feedbackReply(
  subject: string,
  rows: readonly FeedbackClassRow[],
  url: string | null = null,
  profile: StudentProfile = { school: "", year: "" },
): string {
  const names = [...new Set(rows.map((row) => row.studentName.trim()))].join(" / ");
  const blocks = rows.map((row, index) => {
    const body = FEEDBACK_FIELDS
      .map(([key, label]) => [label, row[key]?.trim() ?? ""] as const)
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
    // Cut by code point: half an emoji makes LINE refuse the message.
    const feedback = body.length > MAX_FEEDBACK_CHARS ? `${Array.from(body).slice(0, MAX_FEEDBACK_CHARS).join("")}…` : body;
    const title = [feedbackClassTime.format(row.scheduledStartAt), row.tutorName].filter(Boolean).join(" · ");
    return `${index + 1}) ${title}\n${feedback || "No feedback yet."}`;
  });
  const count = `last ${rows.length} ${rows.length === 1 ? "class" : "classes"}, all tutors`;
  const header = `Feedback: ${names} · ${subject} (${count})`;
  const top = [
    header,
    [profile.school && `School: ${profile.school}`, profile.year && `Year: ${profile.year}`].filter(Boolean).join(" · "),
    url && `Full view (link works for ${LINK_HOURS} hours): ${url}`,
  ].filter(Boolean).join("\n");
  return [top, ...blocks].join("\n\n");
}

/** The student's recent ended classes (newest first) and the Wise title of each. */
export async function loadFeedbackClasses(
  db: Database,
  code: string,
  now: Date,
): Promise<{ rows: FeedbackClassRow[]; titles: Map<string, string> }> {
  const rows = await db
    .select({
      wiseSessionId: schema.postClassSessions.wiseSessionId,
      wiseStudentId: schema.postClassSessionParticipants.wiseStudentId,
      studentName: schema.postClassSessionParticipants.studentName,
      tutorKey: schema.postClassSessions.canonicalTutorKey,
      tutorName: schema.postClassSessions.canonicalTutorName,
      scheduledStartAt: schema.postClassSessions.scheduledStartAt,
      topics: schema.postClassFeedbackVersions.topics,
      performance: schema.postClassFeedbackVersions.performance,
      improvement: schema.postClassFeedbackVersions.improvement,
      homework: schema.postClassFeedbackVersions.homework,
    })
    .from(schema.postClassSessionParticipants)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassSessions.id, schema.postClassSessionParticipants.sessionId),
    )
    .leftJoin(
      schema.postClassFeedbackVersions,
      eq(schema.postClassFeedbackVersions.id, schema.postClassSessions.latestFeedbackVersionId),
    )
    .where(and(
      // Wise names carry the code in brackets: "Aarak (Arav.Sr) Srikueja". "_" is an ILIKE wildcard.
      ilike(schema.postClassSessionParticipants.studentName, `%(${code.replace(/_/g, "\\_")})%`),
      eq(schema.postClassSessions.finalStatus, "ENDED"),
      isNull(schema.postClassSessions.wiseDeletedAt),
      lte(schema.postClassSessions.scheduledStartAt, now),
    ))
    .orderBy(desc(schema.postClassSessions.scheduledStartAt))
    .limit(SCAN_LIMIT);
  if (rows.length === 0) return { rows, titles: new Map() };

  const titleRows = await db
    .select({
      wiseSessionId: schema.classroomAssignmentRows.wiseSessionId,
      title: schema.classroomAssignmentRows.title,
    })
    .from(schema.classroomAssignmentRows)
    .where(inArray(schema.classroomAssignmentRows.wiseSessionId, rows.map((row) => row.wiseSessionId)));
  const titles = new Map<string, string>();
  for (const row of titleRows) if (row.title?.trim()) titles.set(row.wiseSessionId, row.title);

  return { rows, titles };
}

/**
 * Handles one group text message. Returns false when the text is not a
 * /feedback command, so the caller continues to the other group commands.
 */
export async function handleFeedbackGroupCommand(input: {
  db: Database;
  groupId: string;
  text: string;
  replyToken: string | null;
  tutorBot?: boolean;
  now?: Date;
  reply?: typeof replyLineMessage;
  profile?: typeof loadStudentProfile;
}): Promise<false | FeedbackBotAction> {
  const match = FEEDBACK_PATTERN.exec(input.text.trim());
  if (!match) return false;

  // FB-BOT-G1
  const [group] = await input.db
    .select({ canonicalKey: schema.progressLineGroups.canonicalKey })
    .from(schema.progressLineGroups)
    .where(and(
      eq(schema.progressLineGroups.groupId, input.groupId),
      eq(schema.progressLineGroups.enabled, true),
    ))
    .limit(1);
  if (!group || progressUsesTutorBot(group.canonicalKey) !== Boolean(input.tutorBot) || !input.replyToken) {
    return "feedback_silent_chat";
  }
  const respond = (text: string) =>
    (input.reply ?? replyLineMessage)({ replyToken: input.replyToken!, text, tutorBot: input.tutorBot });

  const command = COMMAND_PATTERN.exec((match[1] ?? "").trim());
  if (!command) {
    await respond(FEEDBACK_HELP);
    return "feedback_help";
  }
  const [, code, wanted = ""] = command;

  const now = input.now ?? new Date();
  const { rows, titles } = await loadFeedbackClasses(input.db, code, now);
  if (rows.length === 0) {
    await respond(
      `No ended classes found for student code "${code}". Check the code in the brackets of the student name in Wise.\n` +
      `ไม่พบคลาสของรหัสนักเรียน "${code}"`,
    );
    return "feedback_not_found";
  }


  const selection = selectSubjectClasses(rows, titles, group.canonicalKey, wanted);
  if (selection.status === "no_subject") {
    const reason = wanted
      ? `No "${wanted.trim()}" classes found for ${code}.`
      : `The teacher of this chat has no ended class with ${code}.`;
    await respond(
      `${reason} Add the subject, for example: /feedback ${code} ${selection.subjects[0] ?? "math"}` +
      (selection.subjects.length ? `\nSubjects: ${selection.subjects.join(", ")}` : ""),
    );
    return "feedback_no_subject";
  }

  const token = feedbackLinkToken(code, selection.subject, now);
  const url = token ? `${APP_BASE_URL.replace(/\/$/, "")}/feedback/${token}` : null;
  const profile = await (input.profile ?? loadStudentProfile)(selection.rows[0]?.wiseStudentId);
  await respond(feedbackReply(selection.subject, selection.rows, url, profile));
  return "feedback_reply";
}
