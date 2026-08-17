// ----------------------------------------------------------------------------
// LINE credit bot — `/credit <code>` replies with the family's current credit
// balances plus a Parent Report link, and `/credit setup` registers a staff
// group for the daily run-out digest (credit-digest.ts).
//
// Shares the schedule bot's spine: both routers (schedule-bot.ts DM path,
// schedule-bot-group.ts group path) dispatch here on the "credit" verb AFTER
// their own admin gate has passed, so SCHED-BOT-01 / GRP-BOT-02 are inherited.
// This module adds one gate of its own:
//
//   CRED-BOT-G1  Staff chats only, fail closed AND fully silent. In a group,
//                every /credit command requires the chat's stored audience to
//                be exactly "staff" — read raw from line_group_settings, NOT
//                via groupSettings(), which coerces unknown values to "staff"
//                (permissive in the wrong direction here). A missing row, a
//                "family" audience, or any unexpected value produces NO reply
//                at all: balances, refusal text, and even the help must never
//                appear where a parent can read them.
//
// Balance semantics: raw Wise remainingCredits summed over non-excluded
// packages — deliberately the same numbers as the /student-report page the
// reply links to (NOT the dashboard's adjusted-remaining, which subtracts
// pending deductions).
// ----------------------------------------------------------------------------

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  CREDIT_SETUP_PATTERN,
  HELP_PATTERN,
  exactCodeMatches,
} from "@/lib/line/schedule-bot-command";
import { searchCurrentLineStudentsWithSnapshot } from "@/lib/line/student-links";
import { parseStudentDisplay } from "@/lib/student-schedule/data";
import { REPORT_MAX_STUDENTS, buildReportSearch } from "@/lib/student-report/params";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";
import { roundToHundredth } from "@/lib/credit-control/helpers";
import {
  CREDIT_HELP_DM,
  CREDIT_HELP_GROUP,
  CREDIT_NO_SNAPSHOT,
  CREDIT_SETUP_DM,
  creditBalanceReply,
  creditDigestRegistered,
  creditNotExact,
  type ScheduleBotCandidate,
} from "@/lib/line/schedule-bot-copy";

const MAX_CANDIDATES = 5;

/** How far back the linked Parent Report reaches (matches the workspace default). */
const REPORT_WINDOW_DAYS = 30;

export type CreditBotAction =
  | "credit_help"
  | "credit_balance"
  | "credit_not_exact"
  | "credit_no_snapshot"
  | "credit_silent_audience"
  | "credit_digest_on"
  | "credit_digest_off"
  | "credit_setup_dm_refused";

export interface CreditCommandContext {
  db: Database;
  lineUserId: string;
  /** Text after the /credit prefix, already trimmed by detectTrigger. */
  command: string;
  surface: { kind: "dm" } | { kind: "group"; groupId: string };
  /** Sends one text message back into the originating conversation. */
  respond: (text: string) => Promise<void>;
  now: () => Date;
  baseUrl: string;
}

export interface CreditStudentBalance {
  studentKey: string;
  studentName: string;
  code: string | null;
  totalRemaining: number;
  packages: Array<{ subject: string; packageName: string; remainingCredits: number }>;
}

export type CreditBalanceLookup =
  | { status: "no_snapshot" }
  | { status: "not_exact"; candidates: ScheduleBotCandidate[] }
  | { status: "ok"; snapshotGeneratedAt: Date; students: CreditStudentBalance[] };

/**
 * Reads the chat's stored audience RAW. `null` covers both "no settings row"
 * and any value that is not exactly "staff" — the caller treats all of those
 * as not-a-staff-chat (CRED-BOT-G1 fail-closed).
 */
async function rawStaffGroup(db: Database, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ audience: schema.lineGroupSettings.audience })
    .from(schema.lineGroupSettings)
    .where(eq(schema.lineGroupSettings.groupId, groupId))
    .limit(1);
  return row?.audience === "staff";
}

/**
 * Resolves a nickname code to the whole family's package balances on the
 * active credit-control snapshot.
 *
 * 1. Ranked directory search, then exact-code narrowing — one exact bracketed
 *    -code hit or nothing (same rule as the schedule bot's link path).
 * 2. Sibling fan-out by parentName within the snapshot. A blank parentName
 *    must NOT fan out: the column defaults to "" and matching it would sweep
 *    in every parent-less student on the snapshot.
 * 3. Package balances for every sibling; excluded packages (pretest/trial)
 *    are filtered exactly as the dashboard and report do.
 *
 * Students on the credit-control inactive list are deliberately included —
 * this is raw snapshot truth, matching the report page the reply links to.
 */
export async function loadCreditBalances(
  db: Database,
  query: string,
): Promise<CreditBalanceLookup> {
  const { snapshot, rows } = await searchCurrentLineStudentsWithSnapshot(db, query, MAX_CANDIDATES);
  if (!snapshot) return { status: "no_snapshot" };

  const exact = exactCodeMatches(query, rows);
  if (exact.length !== 1) {
    return {
      status: "not_exact",
      candidates: rows.map((row) => ({
        code: parseStudentDisplay(row.studentName).code,
        studentName: row.studentName,
      })),
    };
  }

  const target = exact[0];
  const parentName = target.parentName?.trim() ?? "";
  const siblingRows = parentName === ""
    ? [{ studentKey: target.studentKey, studentName: target.studentName }]
    : await db
      .select({
        studentKey: schema.creditControlStudents.studentKey,
        studentName: schema.creditControlStudents.studentName,
      })
      .from(schema.creditControlStudents)
      .where(and(
        eq(schema.creditControlStudents.snapshotId, snapshot.id),
        eq(schema.creditControlStudents.parentName, target.parentName),
      ))
      .orderBy(asc(schema.creditControlStudents.studentName));

  // Queried student first, then siblings in name order; de-duped by key.
  const ordered = new Map<string, string>([[target.studentKey, target.studentName]]);
  for (const row of siblingRows) {
    if (!ordered.has(row.studentKey)) ordered.set(row.studentKey, row.studentName);
  }
  const studentKeys = [...ordered.keys()];

  const packageRows = await db
    .select({
      studentKey: schema.creditControlPackages.studentKey,
      subject: schema.creditControlPackages.subject,
      packageName: schema.creditControlPackages.packageName,
      remainingCredits: schema.creditControlPackages.remainingCredits,
    })
    .from(schema.creditControlPackages)
    .where(and(
      eq(schema.creditControlPackages.snapshotId, snapshot.id),
      inArray(schema.creditControlPackages.studentKey, studentKeys),
      isNull(schema.creditControlPackages.excludedReason),
    ));

  const packagesByStudent = new Map<string, CreditStudentBalance["packages"]>();
  for (const row of packageRows) {
    const list = packagesByStudent.get(row.studentKey) ?? [];
    list.push({
      subject: row.subject,
      packageName: row.packageName,
      remainingCredits: row.remainingCredits,
    });
    packagesByStudent.set(row.studentKey, list);
  }

  const students = studentKeys.map((studentKey) => {
    const packages = (packagesByStudent.get(studentKey) ?? [])
      .sort((a, b) => (a.subject || a.packageName).localeCompare(b.subject || b.packageName));
    return {
      studentKey,
      studentName: ordered.get(studentKey) ?? studentKey,
      code: parseStudentDisplay(ordered.get(studentKey) ?? "").code,
      totalRemaining: roundToHundredth(
        packages.reduce((sum, pkg) => sum + pkg.remainingCredits, 0),
      ),
      packages,
    };
  });

  return { status: "ok", snapshotGeneratedAt: snapshot.generatedAt, students };
}

/** `/credit setup [on|off]` inside an already-staff-gated group. */
async function handleSetup(
  ctx: CreditCommandContext & { surface: { kind: "group"; groupId: string } },
  enable: boolean,
): Promise<{ handled: true; action: CreditBotAction }> {
  await ctx.db
    .update(schema.lineGroupSettings)
    .set({
      creditDigestEnabled: enable,
      creditDigestSetByLineUserId: ctx.lineUserId,
      creditDigestUpdatedAt: ctx.now(),
    })
    .where(eq(schema.lineGroupSettings.groupId, ctx.surface.groupId));
  await ctx.respond(creditDigestRegistered(enable));
  return { handled: true, action: enable ? "credit_digest_on" : "credit_digest_off" };
}

/**
 * Routes one /credit command from either surface. The caller's admin gate has
 * already passed; this function owns the staff-chat gate and the command
 * sub-grammar (help · setup · nickname code).
 */
export async function handleCreditCommand(
  ctx: CreditCommandContext,
): Promise<{ handled: true; action: CreditBotAction }> {
  // CRED-BOT-G1 — every group use, help included, requires a raw "staff"
  // audience. Anything else exits with no reply whatsoever.
  if (ctx.surface.kind === "group" && !(await rawStaffGroup(ctx.db, ctx.surface.groupId))) {
    return { handled: true, action: "credit_silent_audience" };
  }

  const command = ctx.command.trim();
  if (!command || HELP_PATTERN.test(command)) {
    await ctx.respond(ctx.surface.kind === "dm" ? CREDIT_HELP_DM : CREDIT_HELP_GROUP);
    return { handled: true, action: "credit_help" };
  }

  const setupMatch = CREDIT_SETUP_PATTERN.exec(command);
  if (setupMatch) {
    if (ctx.surface.kind === "dm") {
      await ctx.respond(CREDIT_SETUP_DM);
      return { handled: true, action: "credit_setup_dm_refused" };
    }
    return handleSetup(
      ctx as CreditCommandContext & { surface: { kind: "group"; groupId: string } },
      (setupMatch[1] ?? "on").toLowerCase() !== "off",
    );
  }

  const lookup = await loadCreditBalances(ctx.db, command);
  if (lookup.status === "no_snapshot") {
    await ctx.respond(CREDIT_NO_SNAPSHOT);
    return { handled: true, action: "credit_no_snapshot" };
  }
  if (lookup.status === "not_exact") {
    await ctx.respond(creditNotExact(command, lookup.candidates));
    return { handled: true, action: "credit_not_exact" };
  }

  const to = todayBangkok(ctx.now());
  const from = addBangkokDays(to, -REPORT_WINDOW_DAYS);
  const linkedKeys = lookup.students
    .map((student) => student.studentKey)
    .slice(0, REPORT_MAX_STUDENTS);
  const url = `${ctx.baseUrl}/student-report/report?${buildReportSearch({
    studentKeys: linkedKeys,
    from,
    to,
  })}`;

  await ctx.respond(creditBalanceReply({
    students: lookup.students,
    url,
    truncatedCount: lookup.students.length - linkedKeys.length,
    generatedAt: lookup.snapshotGeneratedAt,
  }));
  return { handled: true, action: "credit_balance" };
}
