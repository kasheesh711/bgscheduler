import { and, eq, gt, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {
  fetchGoogleSheetRange,
  listGoogleSheetProperties,
  batchUpdateGoogleSpreadsheet,
  updateGoogleSheetRangeValues,
} from "@/lib/sales-dashboard/sheets";
import {
  applicationSchema,
  normalizeEmail,
  normalizeSubjects,
  preScreenSchema,
  TRACKER_ID,
  instant,
  type Application,
  type HiringConfig,
  type Stage,
} from "./model";
import { appInvited } from "./queue";
import { RESUME_MAX_BYTES, sniffResume, storeResume, type ResumeFile } from "./resume-files";
import { answerKey } from "./scoring";
import { audit, inviteToMock, settings, sourceHash } from "./service";
// The one copy stays in status.ts: client components import that file, and this one reaches the database.
import { parseFormTimestamp } from "./status";

export { parseFormTimestamp };
const NEW_FLOW_STAGES: Stage[] = ["onsite_invited", "onsite_booked", "no_reply", "no_booking"];
const OLD_FLOW_STAGES: Stage[] = ["paper_invited", "paper_booked", "paper_passed", "mock_booked"];
/**
 * A new-flow candidate is one whom the app invited (see `appInvited`), or who is at a visit stage. The tracker changes nothing for
 * them. An old stage stays old-flow even if the earlier worker sent that candidate the form.
 */
export const isNewFlow = (candidate: { stage: Stage }, appFormSent: boolean) =>
  NEW_FLOW_STAGES.includes(candidate.stage) ||
  (appFormSent && !OLD_FLOW_STAGES.includes(candidate.stage));

const cell = (row: unknown[], index: number) => String(row[index] ?? "").trim();
export function preScreenRows(rows: unknown[][]) {
  if (
    cell(rows[0] ?? [], 2) !== "Contact Email" ||
    cell(rows[0] ?? [], 17) !==
      "A student is bright but keeps losing motivation and their grades are slipping. How would you approach it?"
  )
    throw new Error("Pre-screen headers changed. Review the source mapping.");
  const latest = new Map<
    string,
    { name: string; pre: ReturnType<typeof preScreenSchema.parse> }
  >();
  rows.slice(1).forEach((row, index) => {
    const email = normalizeEmail(row[2]);
    if (!email) return;
    latest.set(email, {
      name: cell(row, 1),
      pre: preScreenSchema.parse({
        sourceRow: index + 2,
        submittedAt: cell(row, 0),
        degree: cell(row, 3),
        field: cell(row, 4),
        subjects: cell(row, 5),
        curricula: cell(row, 6),
        yearGroups: cell(row, 7),
        english: cell(row, 8),
        englishEvidence: cell(row, 9),
        experience: cell(row, 10),
        portfolio: cell(row, 12),
        availability: cell(row, 13),
        weeklyHours: cell(row, 14),
        motivation: cell(row, 16),
        teachingApproach: cell(row, 17),
      }),
    });
  });
  return latest;
}
export function legacyStage(row: unknown[]): Stage {
  const status = cell(row, 26) || cell(row, 25);
  if (
    /rejected|screened out|withdrawn|hired|waitlist|on hold|no response/i.test(
      status,
    )
  )
    return "stopped";
  if (/mock/i.test(status)) return "mock_booked";
  if (/paper passed/i.test(status) || cell(row, 19) === "Passed")
    return "paper_passed";
  if (/paper scheduled/i.test(status)) return "paper_booked";
  if (
    /scheduling confirmed|ready to invite/i.test(status) ||
    cell(row, 11) === "Qualified"
  )
    return "paper_invited";
  return "review";
}
/** Remember a work-rights answer the settings have not seen, so Kevin can accept it there. It never accepts anything. */
export async function recordWorkRightsAnswer(db: Database, answer: string | null, actor = "seek-import") {
  const text = answer?.trim();
  if (!text) return;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`);
  const { row, config } = await settings(db);
  if (config.seenWorkRights.some((a) => answerKey(a) === answerKey(text))) return;
  // The settings schema allows 200. A longer list would make settings() throw, so stop recording; the candidate keeps the answer.
  if (config.seenWorkRights.length >= 200) return;
  const next = { ...config, seenWorkRights: [...config.seenWorkRights, text] };
  await db
    .insert(s.hiringSettings)
    .values({ id: "default", config: next, revision: (row?.revision ?? 0) + 1, updatedBy: actor })
    .onConflictDoUpdate({
      target: s.hiringSettings.id,
      set: { config: next, revision: (row?.revision ?? 0) + 1, updatedBy: actor, updatedAt: new Date() },
    });
  await audit(db, actor, "work-rights-seen", null, { answer: text });
}
export async function importApplication(value: unknown, db: Database) {
  const input: Application = applicationSchema.parse(value);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"hiring-import:" + (input.email ?? input.applicationId)}))`,
    );
    await recordWorkRightsAnswer(tx, input.workRightsAnswer);
    const [existing] = await tx
      .select()
      .from(s.hiringCandidates)
      .where(
        or(
          eq(s.hiringCandidates.seekApplicationId, input.applicationId),
          sql`${s.hiringCandidates.sourceIds} @> ${JSON.stringify([input.applicationId])}::jsonb`,
          input.email ? eq(s.hiringCandidates.email, input.email) : undefined,
        ),
      )
      .limit(1);
    const text = [input.profileText, input.resumeText]
      .filter(Boolean)
      .join("\n\nResume:\n");
    if (existing) {
      const ids = [...new Set([...existing.sourceIds, input.applicationId])];
      if (
        existing.profileText !== text ||
        ids.length !== existing.sourceIds.length ||
        (input.workRightsAnswer !== null &&
          existing.workRightsAnswer !== input.workRightsAnswer) ||
        (!existing.previouslyContacted && input.previouslyContacted)
      ) {
        await tx
          .update(s.hiringCandidates)
          .set({
            profileText: text,
            sourceIds: ids,
            // A page that shows no answer must not erase one already read.
            workRightsAnswer: input.workRightsAnswer ?? existing.workRightsAnswer,
            previouslyContacted:
              existing.previouslyContacted || input.previouslyContacted,
            updatedAt: new Date(),
            revision: existing.revision + 1,
          })
          .where(eq(s.hiringCandidates.id, existing.id));
        await audit(tx, "seek-import", "source-update", existing.id, {
          applicationId: input.applicationId,
        });
      }
      return existing.id;
    }
    const [created] = await tx
      .insert(s.hiringCandidates)
      .values({
        seekApplicationId: input.applicationId,
        sourceIds: [input.applicationId],
        name: input.name,
        email: input.email,
        profileText: text,
        workRightsAnswer: input.workRightsAnswer,
        previouslyContacted: input.previouslyContacted,
        stage:
          input.previouslyContacted ||
          !input.email ||
          !/^Inbox$/i.test(input.sourceStatus)
            ? "review"
            : "new",
        reviewNote: input.previouslyContacted
          ? "SEEK shows an earlier email. Check contact history before another invitation."
          : null,
      })
      .returning();
    await audit(tx, "seek-import", "source-import", created.id, {
      applicationId: input.applicationId,
    });
    return created.id;
  });
}

export async function observeSeekState(
  applicationId: string,
  status: string,
  contacted: boolean,
  db: Database,
) {
  await withDatabaseTransaction(db, async (tx) => {
    const [candidate] = await tx
      .select()
      .from(s.hiringCandidates)
      .where(
        sql`${s.hiringCandidates.sourceIds} @> ${JSON.stringify([applicationId])}::jsonb`,
      )
      .limit(1)
      .for("update");
    if (!candidate) return;
    const newlyContacted = contacted && !candidate.previouslyContacted;
    const seekStop = ["Not Suitable", "Accept"].includes(status);
    // The same rule as the staff stop: a future visit is cancelled in Hiring first, and the stop applies on the next read.
    // Only a visit: an old-flow booking has no Cancel visit action, so holding it would strand the candidate.
    const held =
      seekStop &&
      candidate.stage !== "stopped" &&
      (
        await tx
          .select({ id: s.hiringBookings.id })
          .from(s.hiringBookings)
          .where(
            and(
              eq(s.hiringBookings.candidateId, candidate.id),
              eq(s.hiringBookings.status, "confirmed"),
              isNotNull(s.hiringBookings.visitId),
              gt(s.hiringBookings.endTime, new Date()),
            ),
          )
          .limit(1)
      ).length > 0;
    const heldNote = `SEEK status: ${status}. Cancel the visit in Hiring to stop this candidate.`;
    const stopped = seekStop && !held;
    const externallyAdvanced = status !== "Inbox" && candidate.stage === "new";
    // This runs for every known candidate each cycle. A repeated write would raise the revision and break panel clicks.
    if (
      !newlyContacted &&
      !externallyAdvanced &&
      (!stopped || candidate.stage === "stopped") &&
      (!held || candidate.reviewNote === heldNote)
    )
      return;
    await tx
      .update(s.hiringCandidates)
      .set({
        previouslyContacted: candidate.previouslyContacted || contacted,
        stage: stopped
          ? "stopped"
          : externallyAdvanced
            ? "review"
            : candidate.stage,
        reviewNote: held
          ? heldNote
          : `SEEK status: ${status}.${newlyContacted ? " New contact is recorded in SEEK; pending invitations were stopped." : ""}`,
        revision: candidate.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(s.hiringCandidates.id, candidate.id));
    if (newlyContacted || stopped) {
      await tx
        .update(s.hiringOutbox)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(s.hiringOutbox.candidateId, candidate.id),
            sql`${s.hiringOutbox.payload} ? 'workflowStage'`,
            sql`${s.hiringOutbox.status} in ('pending','failed','uncertain')`,
          ),
        );
    }
    await audit(tx, "seek-import", "source-status", candidate.id, {
      applicationId,
      status,
      newlyContacted,
    });
  });
}

export async function syncTracker(db: Database, config: HiringConfig) {
  const properties = await listGoogleSheetProperties(
    config.connectedEmail,
    TRACKER_ID,
  );
  const read = async (name: string, lastColumn: string) => {
    const tab = properties.find((p) => p.title === name);
    if (!tab) throw new Error(`Required tracker tab is missing: ${name}`);
    if (tab.rowCount > 10000)
      throw new Error("Tracker grew beyond the verified import range.");
    return fetchGoogleSheetRange(
      config.connectedEmail,
      TRACKER_ID,
      `'${name}'!A1:${lastColumn}${tab.rowCount}`,
    );
  };
  const [preRows, recruit, mockRows] = await Promise.all([
    read("Pre-screen Responses", "W"),
    read("Recruitment Sheet", "AD"),
    read("Mock Teaching Test Log", "J"),
  ]);
  const pres = preScreenRows(preRows);
  if (
    !cell(recruit[1] ?? [], 0).includes("Applicant ID") ||
    !cell(recruit[1] ?? [], 19).includes("Paper Outcome")
  )
    throw new Error("Recruitment headers changed. Review the source mapping.");
  for (const row of recruit.slice(2)) {
    if (!/^APP-\d+$/.test(cell(row, 0))) continue;
    const email = normalizeEmail(row[2]);
    if (!email) continue;
    const hash = sourceHash(
      [0, 2, 11, 13, 16, 17, 19, 20, 25, 26].map((i) => row[i]),
    );
    await withDatabaseTransaction(db, async (tx) => {
      await tx.execute(
        sql`select id from hiring_candidates where email=${email} for update`,
      );
      const [existing] = await tx
        .select()
        .from(s.hiringCandidates)
        .where(eq(s.hiringCandidates.email, email));
      if (existing?.trackerHash === hash) return;
      if (existing && isNewFlow(existing, await appInvited(tx, existing.id))) {
        await tx
          .update(s.hiringCandidates)
          .set({ trackerHash: hash })
          .where(eq(s.hiringCandidates.id, existing.id));
        return;
      }
      const passed =
        cell(row, 19) === "Passed" ? normalizeSubjects(cell(row, 20)) : [];
      const stage = legacyStage(row);
      const data = {
        applicantId: cell(row, 0),
        trackerHash: hash,
        name: cell(row, 1),
        email,
        stage,
        previouslyContacted: true,
        subjects: normalizeSubjects(
          cell(row, 13) || cell(row, 12) || cell(row, 6),
        ),
        paperPassedSubjects: passed,
        reviewNote: `Tracker state: ${cell(row, 26) || cell(row, 25)}. ${cell(row, 29)}`,
      };
      if (existing) {
        // Unchanged source values never overwrite a decision made in Scheduling.
        const [updated] = await tx
          .update(s.hiringCandidates)
          .set({
            ...data,
            revision: existing.revision + 1,
            updatedAt: new Date(),
            ...(passed.length
              ? {
                  paperPassedAt: existing.paperPassedAt ?? new Date(),
                  paperRecordedBy: "tracker",
                }
              : {}),
          })
          .where(eq(s.hiringCandidates.id, existing.id))
          .returning();
        if (
          existing.trackerHash &&
          stage === "paper_passed" &&
          passed.length &&
          JSON.stringify(existing.paperPassedSubjects) !==
            JSON.stringify(passed)
        ) {
          await inviteToMock(
            tx,
            updated,
            config,
            `${updated.id}:tracker-mock:${hash}`,
          );
          await audit(tx, "tracker", "paper-pass", updated.id, {
            sourceRow: recruit.indexOf(row) + 1,
            subjects: passed,
          });
        }
      } else
        await tx.insert(s.hiringCandidates).values({
          ...data,
          ...(passed.length
            ? { paperPassedAt: new Date(), paperRecordedBy: "tracker" }
            : {}),
        });
    });
  }
  for (const [email, { name, pre }] of pres) {
    await withDatabaseTransaction(db, async (tx) => {
      const [existing] = await tx
        .select()
        .from(s.hiringCandidates)
        .where(eq(s.hiringCandidates.email, email))
        .for("update");
      if (existing) {
        if (sourceHash(existing.preScreen) === sourceHash(pre)) return;
        const first = !existing.preScreen;
        // A row that only moved in the sheet is the same response.
        const answered =
          first ||
          sourceHash({ ...existing.preScreen, sourceRow: 0 }) !==
            sourceHash({ ...pre, sourceRow: 0 });
        await tx
          .update(s.hiringCandidates)
          .set({
            preScreen: pre,
            ...(first
              ? { preScreenRepliedAt: parseFormTimestamp(pre.submittedAt) }
              : answered
                ? { preScreenResubmitted: true }
                : {}),
            ...(answered && existing.stage === "no_reply"
              ? { stage: "pre_screen" as const }
              : {}),
            // A person's score was for the old answers. A changed response is held for a person either way.
            ...(answered ? { preScreenOverride: null } : {}),
            updatedAt: new Date(),
            revision: existing.revision + 1,
          })
          .where(eq(s.hiringCandidates.id, existing.id));
        // They answered, so an unsent form or reminder must not follow. An uncertain row may already have left: it stays counted.
        if (answered)
          await tx
            .update(s.hiringOutbox)
            .set({ status: "cancelled" })
            .where(
              and(
                eq(s.hiringOutbox.candidateId, existing.id),
                sql`${s.hiringOutbox.payload}->>'workflowStage' = 'pre_screen'`,
                inArray(s.hiringOutbox.status, ["pending", "failed"]),
              ),
            );
      } else
        await tx.insert(s.hiringCandidates).values({
          name,
          email,
          preScreen: pre,
          preScreenRepliedAt: parseFormTimestamp(pre.submittedAt),
          previouslyContacted: true,
          stage: "review",
          reviewNote:
            "Imported pre-screen response has no prior application record. Review identity before sending.",
        });
    });
  }
  const applicantEmails = new Map(
    recruit.slice(2).map((row) => [cell(row, 0), normalizeEmail(row[2])]),
  );
  for (let index = 2; index < mockRows.length; index++) {
    const row = mockRows[index];
    if (!/^APP-\d+$/.test(cell(row, 0)) || !row[4] || !row[5]) continue;
    const serial = Number(row[4]);
    const date = Number.isFinite(serial)
      ? new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000)
          .toISOString()
          .slice(0, 10)
      : cell(row, 4);
    const times = cell(row, 5).match(
      /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/,
    );
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !times)
      throw new Error(
        `Mock Teaching Test Log row ${index + 1} needs a valid date and time.`,
      );
    const start = instant(date, Number(times[1]) * 60 + Number(times[2])),
      end = instant(date, Number(times[3]) * 60 + Number(times[4]));
    if (start <= new Date()) continue;
    const applicant = (where: SQL) => db.select().from(s.hiringCandidates).where(where);
    const email = applicantEmails.get(cell(row, 0));
    // A new-flow row never stores the applicant ID, so such a candidate is found by the email on the Recruitment Sheet.
    let [candidate] = await applicant(eq(s.hiringCandidates.applicantId, cell(row, 0)));
    if (!candidate && email)
      [candidate] = await applicant(eq(s.hiringCandidates.email, email));
    if (candidate && isNewFlow(candidate, await appInvited(db, candidate.id)))
      continue;
    const subjects = normalizeSubjects(cell(row, 2));
    const key = cell(row, 3).replace(/^Kru\s+/i, "");
    const interviewer = config.interviewers.find(
      (i) => i.canonicalKey.toLowerCase() === key.toLowerCase(),
    );
    const [group] = interviewer
      ? await db
          .select()
          .from(s.progressLineGroups)
          .where(
            and(
              eq(s.progressLineGroups.canonicalKey, interviewer.canonicalKey),
              eq(s.progressLineGroups.enabled, true),
            ),
          )
      : [];
    if (!candidate || subjects.length !== 1 || !interviewer || !group)
      throw new Error(
        `Mock Teaching Test Log row ${index + 1} has an unresolved applicant, subject, or interviewer.`,
      );
    const prior = await db
      .select()
      .from(s.hiringBookings)
      .where(
        and(
          eq(s.hiringBookings.candidateId, candidate.id),
          eq(s.hiringBookings.kind, "mock"),
          eq(s.hiringBookings.status, "confirmed"),
        ),
      );
    if (prior.some((b) => b.subjects.includes(subjects[0]))) continue;
    await db.insert(s.hiringBookings).values({
      candidateId: candidate.id,
      kind: "mock",
      subjects,
      interviewerKey: interviewer.canonicalKey,
      interviewerEmail: interviewer.email,
      lineGroupId: group.groupId,
      calendarOwner: config.connectedEmail,
      startTime: start,
      endTime: end,
      evidence: { source: "tracker", row: index + 1 },
    });
  }
  return {
    preScreenResponses: pres.size,
    trackerRows: recruit.filter((r) => /^APP-\d+$/.test(cell(r, 0))).length,
  };
}

export async function mirrorTracker(db: Database, config: HiringConfig) {
  const title = "Hiring Automation";
  const tabs = await listGoogleSheetProperties(
    config.connectedEmail,
    TRACKER_ID,
  );
  if (!tabs.some((t) => t.title === title))
    await batchUpdateGoogleSpreadsheet(config.connectedEmail, TRACKER_ID, [
      {
        addSheet: {
          properties: {
            title,
            gridProperties: {
              rowCount: 2500,
              columnCount: 10,
              frozenRowCount: 2,
            },
          },
        },
      },
    ]);
  const head = await fetchGoogleSheetRange(
    config.connectedEmail,
    TRACKER_ID,
    `'${title}'!A1:A1`,
  );
  if (head[0]?.[0] && head[0][0] !== "Managed by Scheduling hiring automation")
    throw new Error(
      "The Hiring Automation tab contains other data. It was not overwritten.",
    );
  const candidates = await db
    .select()
    .from(s.hiringCandidates)
    .orderBy(s.hiringCandidates.createdAt)
    .limit(2001);
  if (candidates.length > 2000)
    throw new Error(
      "Hiring mirror exceeds 2,000 candidates; expand its verified range.",
    );
  const rows: (string | number | boolean | null)[][] = [
    ["Managed by Scheduling hiring automation"],
    [
      "Applicant ID",
      "Name",
      "Email",
      "Stage",
      "Subjects",
      "Passed paper subjects",
      "Updated at",
      "Review note",
    ],
  ];
  for (const c of candidates)
    rows.push([
      c.applicantId ?? c.id,
      c.name,
      c.email ?? "",
      c.stage,
      c.subjects.join(", "),
      c.paperPassedSubjects.join(", "),
      c.updatedAt.toISOString(),
      c.reviewNote ?? "",
    ]);
  await updateGoogleSheetRangeValues(
    config.connectedEmail,
    TRACKER_ID,
    `'${title}'!A1:H${rows.length}`,
    rows,
    "RAW",
  );
}

// ---- One-time passes. Neither sends a message or changes a stage. ----

const BACKFILL_ACTOR = "hiring-backfill";

/** A pass that writes source data runs only while live hiring and messages are paused. */
export async function assertAutomationOff(db: Database) {
  const { config } = await settings(db);
  if (config.enabled || config.deliveryEnabled) throw new Error("Pause live hiring and messages before this pass.");
}

const holdsApplication = (applicationId: string) =>
  sql`${s.hiringCandidates.sourceIds} @> ${JSON.stringify([applicationId])}::jsonb`;

/**
 * Whether a SEEK pass still has to read this application. `notOurs`: no candidate holds it. `done`: the file was deleted by
 * retention, the candidate has an answer and a file, or an earlier pass already read the page (even if it showed no file).
 */
export async function backfillStatus(
  db: Database,
  applicationId: string,
): Promise<{ state: "todo"; candidateId: string } | { state: "done" | "notOurs" }> {
  const c = s.hiringCandidates;
  const [row] = await db
    .select({ id: c.id, answer: c.workRightsAnswer, path: c.resumePath, storedAt: c.resumeStoredAt })
    .from(c)
    .where(holdsApplication(applicationId))
    .limit(1);
  if (!row) return { state: "notOurs" };
  if ((!row.path && row.storedAt) || (row.answer !== null && row.path)) return { state: "done" };
  const [marked] = await db
    .select({ id: s.hiringAudit.id })
    .from(s.hiringAudit)
    .where(and(eq(s.hiringAudit.candidateId, row.id), eq(s.hiringAudit.action, "seek-backfill")))
    .limit(1);
  return marked ? { state: "done" } : { state: "todo", candidateId: row.id };
}

/** What one page showed. `resumeFailed`: a résumé control was there but the download failed. `resumeUnusable`: the file can never be read. */
export type BackfillPage = {
  workRightsAnswer: string | null;
  file: ResumeFile | null;
  resumeFailed?: boolean;
  resumeUnusable?: boolean;
};
export type BackfillOutcome = {
  answer: "none" | "filled" | "same" | "replaced";
  file: "stored" | "kept" | "none" | "failed" | "unusable";
};

/**
 * Stores what a SEEK page showed: the exact work-rights answer and the original file. It writes only `work_rights_answer`,
 * the résumé columns, `seenWorkRights` and one audit row. Stage, revision, `updated_at`, text, hashes, review note and outbox
 * stay as they were, so nothing re-scores and nothing is sent. A different answer replaces the stored one and is never accepted.
 *
 * The `seek-backfill` row marks the candidate as read. A failed download or upload saves the answer but leaves that row out
 * (a `seek-backfill-retry` row records the answer), so the next run reads the candidate again. A file that can never be read
 * (`.doc`, over the page limit, encrypted, not a PDF or Word file) is marked `unusable` and not retried.
 * Returns null when no candidate holds the application, or retention deleted its file.
 */
export async function applyBackfill(
  db: Database,
  applicationId: string,
  { workRightsAnswer, file, resumeFailed, resumeUnusable }: BackfillPage,
): Promise<BackfillOutcome | null> {
  await assertAutomationOff(db);
  const c = s.hiringCandidates;
  const [row] = await db
    .select({ id: c.id, path: c.resumePath, storedAt: c.resumeStoredAt })
    .from(c)
    .where(holdsApplication(applicationId))
    .limit(1);
  // Retention deleted this file on purpose, so it is not stored again.
  if (!row || (!row.path && row.storedAt)) return null;
  let stored: BackfillOutcome["file"] = row.path ? "kept" : "none";
  if (!row.path) {
    // The file goes first, outside the transaction. Its failure must not stop the answer from being saved.
    if (file && (!sniffResume(file.bytes) || file.bytes.length > RESUME_MAX_BYTES)) stored = "unusable";
    else if (file)
      try {
        await storeResume(row.id, file, db);
        stored = "stored";
      } catch {
        stored = "failed";
      }
    else if (resumeFailed) stored = "failed";
    else if (resumeUnusable) stored = "unusable";
  }
  const text = workRightsAnswer?.trim() || null;
  return withDatabaseTransaction(db, async (tx) => {
    await recordWorkRightsAnswer(tx, text, BACKFILL_ACTOR);
    const [now] = await tx.select({ answer: c.workRightsAnswer }).from(c).where(eq(c.id, row.id)).for("update");
    const answer = !text ? "none" : now.answer === null ? "filled" : now.answer === text ? "same" : "replaced";
    if (text && answer !== "same") await tx.update(c).set({ workRightsAnswer: text }).where(eq(c.id, row.id));
    await audit(tx, BACKFILL_ACTOR, stored === "failed" ? "seek-backfill-retry" : "seek-backfill", row.id, {
      answer,
      ...(answer === "replaced" ? { previous: now.answer } : {}),
      file: stored,
    });
    return { answer, file: stored };
  });
}

/** The tabs the design names. Neither is read by the live sync. */
const PEOPLE_TABS = [
  { key: "sourcing", title: "Sourcing Log" },
  { key: "scheduling", title: "Scheduling Responses" },
] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number]["key"];

/** People on one tab. The email (and name) columns are found by header text in the first rows, so a moved column fails loudly. */
export function trackerPeople(rows: unknown[][]) {
  const at = rows.slice(0, 5).findIndex((r) => r.some((v) => /e-?mail/i.test(String(v ?? ""))));
  if (at < 0) throw new Error("Tracker headers changed. Review the source mapping.");
  const head = rows[at].map((v) => String(v ?? ""));
  const emailCol = head.findIndex((h) => /e-?mail/i.test(h));
  const nameCol = head.findIndex((h) => /name/i.test(h) && !/e-?mail/i.test(h));
  return rows.slice(at + 1).flatMap((row, i) =>
    row.some((v) => String(v ?? "").trim())
      ? [{ row: at + i + 2, email: normalizeEmail(row[emailCol]), name: nameCol >= 0 ? cell(row, nameCol) : "" }]
      : [],
  );
}

/** The Sourcing Log column that holds an invitation. It is found by header text, so a moved column fails loudly. */
function inviteColumn(rows: unknown[][]) {
  const column = Math.max(-1, ...rows.slice(0, 5).map((r) => r.findIndex((v) => /send email to invite/i.test(String(v ?? "")))));
  if (column < 0) throw new Error('Tracker headers changed: "Send email to invite" is missing. Review the source mapping.');
  return column;
}

type TrackerPerson = { tab: PeopleTab; sourceTab: string; row: number; email: string | null; name: string; contacted: boolean };

async function readPeople(config: HiringConfig) {
  const properties = await listGoogleSheetProperties(config.connectedEmail, TRACKER_ID);
  const found: TrackerPerson[] = [];
  for (const { key, title } of PEOPLE_TABS) {
    const tab = properties.find((p) => p.title === title);
    if (!tab) throw new Error(`Required tracker tab is missing: ${title}`);
    if (tab.rowCount > 10000) throw new Error("Tracker grew beyond the verified import range.");
    const rows = await fetchGoogleSheetRange(config.connectedEmail, TRACKER_ID, `'${title}'!A1:AD${tab.rowCount}`);
    // Scheduling Responses means they were emailed. A Sourcing Log row only records a view until its invite column has a value.
    const invite = key === "sourcing" ? inviteColumn(rows) : null;
    for (const person of trackerPeople(rows))
      found.push({
        tab: key,
        sourceTab: title,
        ...person,
        contacted: invite === null || !!cell(rows[person.row - 1], invite),
      });
  }
  return found;
}

/** People on the two tabs who are not in the app, one per email per tab. Rows with no valid email are counted apart. */
async function missingPeople(db: Database, people: TrackerPerson[]) {
  const known = new Set(
    (await db.select({ email: s.hiringCandidates.email }).from(s.hiringCandidates).where(isNotNull(s.hiringCandidates.email)))
      .map((r) => r.email!.trim().toLowerCase()),
  );
  const noEmail = { sourcing: 0, scheduling: 0 };
  const seen = new Set<string>();
  const missing: TrackerPerson[] = [];
  for (const person of people) {
    if (!person.email) noEmail[person.tab]++;
    else if (!known.has(person.email) && !seen.has(`${person.tab}:${person.email}`)) {
      seen.add(`${person.tab}:${person.email}`);
      missing.push(person);
    }
  }
  return { missing, noEmail };
}

/** People in the app at `new`, not marked as contacted, whom the tracker shows as already emailed. */
async function contactedAtNew(db: Database, people: TrackerPerson[]) {
  const c = s.hiringCandidates;
  const contacted = new Map(people.flatMap((p) => (p.contacted && p.email ? [[p.email, p] as const] : [])));
  const rows = await db
    .select({ id: c.id, email: c.email })
    .from(c)
    .where(and(eq(c.stage, "new"), eq(c.previouslyContacted, false), isNotNull(c.email)));
  return rows.flatMap(({ id, email }) => {
    const person = contacted.get(email!.trim().toLowerCase());
    return person ? [{ id, sourceTab: person.sourceTab, row: person.row }] : [];
  });
}

/**
 * Report only: it reads the app and the sheet and writes to neither. `sourcing` and `scheduling` count people missing
 * from the app. `alreadyContactedAtNew` counts the people `markTrackerContacted` would mark.
 */
export async function reconcileTracker(db: Database, config: HiringConfig) {
  const people = await readPeople(config);
  const { missing, noEmail } = await missingPeople(db, people);
  return {
    sourcing: missing.filter((m) => m.tab === "sourcing").length,
    scheduling: missing.filter((m) => m.tab === "scheduling").length,
    missing: missing.map((m) => ({ sourceTab: m.sourceTab, row: m.row })),
    noEmail,
    alreadyContactedAtNew: (await contactedAtNew(db, people)).length,
  };
}

/**
 * Sets the earlier-contact flag on the people `contactedAtNew` finds, with one audit row each, so the queue sends them no
 * form. It writes that column only. Stage, revision, `updated_at` and outbox stay as they were: nothing reads the flag
 * through a saved copy, because each release locks and rereads the row. The first live cycle then moves them to review.
 */
export async function markTrackerContacted(db: Database, config: HiringConfig) {
  await assertAutomationOff(db);
  const c = s.hiringCandidates;
  let marked = 0;
  for (const { id, sourceTab, row } of await contactedAtNew(db, await readPeople(config)))
    await withDatabaseTransaction(db, async (tx) => {
      const [held] = await tx
        .update(c)
        .set({ previouslyContacted: true })
        .where(and(eq(c.id, id), eq(c.stage, "new"), eq(c.previouslyContacted, false)))
        .returning({ id: c.id });
      if (!held) return;
      await audit(tx, BACKFILL_ACTOR, "tracker-mark-contacted", id, { sourceTab, row });
      marked++;
    });
  return marked;
}

/**
 * Adds the people `reconcileTracker` reports, keyed by normalized email, so a rerun adds none. Each has earlier contact,
 * stage `review`, no text, no score and no outbox row, so no queue can pick them. A tracker-only person has no SEEK
 * application id and no applicant id (both unique columns stay null); a later SEEK import of the same email merges into the row.
 */
export async function importMissingTracker(db: Database, config: HiringConfig) {
  await assertAutomationOff(db);
  const { missing } = await missingPeople(db, await readPeople(config));
  let added = 0;
  const done = new Set<string>();
  for (const person of missing) {
    if (done.has(person.email!)) continue;
    done.add(person.email!);
    await withDatabaseTransaction(db, async (tx) => {
      // The same lock as a SEEK import of this email, so the two cannot both create the row.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hiring-import:" + person.email}))`);
      const [created] = await tx
        .insert(s.hiringCandidates)
        .values({
          name: person.name || person.email!,
          email: person.email,
          previouslyContacted: true,
          stage: "review",
          reviewNote: "Added from the tracker. No SEEK application is linked yet.",
        })
        .onConflictDoNothing({ target: s.hiringCandidates.email })
        .returning({ id: s.hiringCandidates.id });
      if (!created) return;
      await audit(tx, BACKFILL_ACTOR, "tracker-import", created.id, { sourceTab: person.sourceTab, row: person.row });
      added++;
    });
  }
  return added;
}
