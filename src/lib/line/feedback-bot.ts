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
// Reads Postgres only (never Wise, never the credit snapshot).
// ----------------------------------------------------------------------------

import { and, desc, eq, ilike, inArray, isNull, lte } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { replyLineMessage } from "@/lib/line/client";
import { progressUsesTutorBot } from "@/lib/line/progress-reminders";

const CLASS_LIMIT = 5;
/** Recent classes scanned for the subject match. shortcut: a subject older than this many classes is not found; raise if teachers report it. */
const SCAN_LIMIT = 200;
/** 5 classes × (this + a short header) stays under LINE's 5,000-character text limit. */
const MAX_FEEDBACK_CHARS = 800;

const FEEDBACK_PATTERN = /^\/feedback(?:\s+(.*))?$/i;
/** `<code> [subject words]`. */
const COMMAND_PATTERN = /^([A-Za-z0-9._\-\u0E00-\u0E7F]{2,40})(?:\s+(.{1,40}))?$/;

const FEEDBACK_HELP =
  "Type /feedback and the student code, for example: /feedback Tara.Ta\n" +
  "To select a subject, add it: /feedback Tara.Ta math\n" +
  "พิมพ์ /feedback ตามด้วยรหัสนักเรียน เช่น /feedback Tara.Ta";

const FIELDS = [
  ["topics", "Topics"],
  ["performance", "Performance"],
  ["improvement", "Needs work"],
  ["homework", "Homework"],
] as const;

const classTime = new Intl.DateTimeFormat("en-GB", {
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
): FeedbackSelection {
  const withSubject = rows
    .map((row) => ({ row, subject: titleSubject(titles.get(row.wiseSessionId) ?? "") }))
    .filter((entry) => subjectKey(entry.subject));
  const wantedKey = subjectKey(wanted);
  const anchor = withSubject.find((entry) =>
    wantedKey ? subjectKey(entry.subject).includes(wantedKey) : entry.row.tutorKey === chatTutorKey);
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

export function feedbackReply(subject: string, rows: readonly FeedbackClassRow[]): string {
  const names = [...new Set(rows.map((row) => row.studentName.trim()))].join(" / ");
  const blocks = rows.map((row, index) => {
    const body = FIELDS
      .map(([key, label]) => [label, row[key]?.trim() ?? ""] as const)
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
    // Cut by code point: half an emoji makes LINE refuse the message.
    const feedback = body.length > MAX_FEEDBACK_CHARS ? `${Array.from(body).slice(0, MAX_FEEDBACK_CHARS).join("")}…` : body;
    const title = [classTime.format(row.scheduledStartAt), row.tutorName].filter(Boolean).join(" · ");
    return `${index + 1}) ${title}\n${feedback || "No feedback yet."}`;
  });
  const count = `last ${rows.length} ${rows.length === 1 ? "class" : "classes"}, all tutors`;
  return [`Feedback: ${names} · ${subject} (${count})`, ...blocks].join("\n\n");
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

  const rows = await input.db
    .select({
      wiseSessionId: schema.postClassSessions.wiseSessionId,
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
      lte(schema.postClassSessions.scheduledStartAt, input.now ?? new Date()),
    ))
    .orderBy(desc(schema.postClassSessions.scheduledStartAt))
    .limit(SCAN_LIMIT);
  if (rows.length === 0) {
    await respond(
      `No ended classes found for student code "${code}". Check the code in the brackets of the student name in Wise.\n` +
      `ไม่พบคลาสของรหัสนักเรียน "${code}"`,
    );
    return "feedback_not_found";
  }

  const titleRows = await input.db
    .select({
      wiseSessionId: schema.classroomAssignmentRows.wiseSessionId,
      title: schema.classroomAssignmentRows.title,
    })
    .from(schema.classroomAssignmentRows)
    .where(inArray(schema.classroomAssignmentRows.wiseSessionId, rows.map((row) => row.wiseSessionId)));
  const titles = new Map<string, string>();
  for (const row of titleRows) if (row.title?.trim()) titles.set(row.wiseSessionId, row.title);

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

  await respond(feedbackReply(selection.subject, selection.rows));
  return "feedback_reply";
}
