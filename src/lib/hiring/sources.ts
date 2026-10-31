import { and, eq, or, sql } from "drizzle-orm";
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
import { audit, inviteToBooking, sourceHash } from "./service";

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
export async function importApplication(value: unknown, db: Database) {
  const input: Application = applicationSchema.parse(value);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"hiring-import:" + (input.email ?? input.applicationId)}))`,
    );
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
        existing.workRightsConfirmed !== input.workRightsConfirmed ||
        (!existing.previouslyContacted && input.previouslyContacted)
      ) {
        await tx
          .update(s.hiringCandidates)
          .set({
            profileText: text,
            sourceIds: ids,
            workRightsConfirmed: input.workRightsConfirmed,
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
        workRightsConfirmed: input.workRightsConfirmed,
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
    const stopped = ["Not Suitable", "Accept"].includes(status);
    const externallyAdvanced = status !== "Inbox" && candidate.stage === "new";
    if (
      !newlyContacted &&
      !externallyAdvanced &&
      (!stopped || candidate.stage === "stopped")
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
        reviewNote: `SEEK status: ${status}.${newlyContacted ? " New contact is recorded in SEEK; pending invitations were stopped." : ""}`,
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
          await inviteToBooking(
            tx,
            updated,
            "mock",
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
        if (sourceHash(existing.preScreen) !== sourceHash(pre))
          await tx
            .update(s.hiringCandidates)
            .set({
              preScreen: pre,
              updatedAt: new Date(),
              revision: existing.revision + 1,
            })
            .where(eq(s.hiringCandidates.id, existing.id));
      } else
        await tx.insert(s.hiringCandidates).values({
          name,
          email,
          preScreen: pre,
          previouslyContacted: true,
          stage: "review",
          reviewNote:
            "Imported pre-screen response has no prior application record. Review identity before sending.",
        });
    });
  }
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
    const [candidate] = await db
      .select()
      .from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.applicantId, cell(row, 0)));
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
