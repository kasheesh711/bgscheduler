import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { availableSlots, verifyLiveSlot } from "./availability";
import {
  bookingSchema,
  configSchema,
  HiringError,
  PRE_SCREEN_URL,
  overlap,
  runtimeWritesAllowed,
  type HiringConfig,
  type InterviewKind,
  type Subject,
} from "./model";
import { profileScore } from "./scoring";
import { googleConnectionStatus } from "./google";
import { bookingToken, readBookingToken } from "./tokens";

export type Candidate = typeof s.hiringCandidates.$inferSelect;
export async function settings(db: Database = getDb()) {
  const [row] = await db
    .select()
    .from(s.hiringSettings)
    .where(eq(s.hiringSettings.id, "default"));
  return { row, config: configSchema.parse(row?.config ?? {}) };
}
export async function audit(
  db: Database,
  actor: string,
  action: string,
  candidateId: string | null,
  detail: Record<string, unknown> = {},
) {
  await db.insert(s.hiringAudit).values({ actor, action, candidateId, detail });
}
export async function saveSettings(
  value: unknown,
  revision: number,
  actor: string,
  db: Database = getDb(),
) {
  const config = configSchema.parse(value);
  if (
    (config.enabled || config.deliveryEnabled) &&
    (!config.rubricApproved || !runtimeWritesAllowed())
  )
    throw new HiringError(
      409,
      "Approve the rubric and enable the production write gate before starting automation.",
    );
  if (
    config.enabled &&
    (!config.interviewers.length ||
      new Set(config.interviewers.map((i) => i.canonicalKey)).size !==
        config.interviewers.length)
  )
    throw new HiringError(
      400,
      "Choose distinct interviewers before enabling hiring.",
    );
  if (
    config.deliveryEnabled &&
    !(await googleConnectionStatus(config.connectedEmail, db)).connected
  )
    throw new HiringError(
      409,
      "Connect the organizer's Google Calendar before enabling messages.",
    );
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`,
    );
    const current = await settings(tx);
    if ((current.row?.revision ?? 0) !== revision)
      throw new HiringError(409, "Settings changed. Refresh this page.");
    await tx
      .insert(s.hiringSettings)
      .values({
        id: "default",
        config,
        revision: revision + 1,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: s.hiringSettings.id,
        set: {
          config,
          revision: revision + 1,
          updatedBy: actor,
          updatedAt: new Date(),
        },
      });
    await audit(tx, actor, "settings", null, {
      revision: revision + 1,
      config,
    });
  });
}
export async function candidateById(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(s.hiringCandidates)
    .where(eq(s.hiringCandidates.id, id));
  if (!row) throw new HiringError(404, "Candidate not found.");
  return row;
}
export async function enqueue(
  db: Database,
  value: typeof s.hiringOutbox.$inferInsert,
) {
  await db
    .insert(s.hiringOutbox)
    .values(value)
    .onConflictDoNothing({ target: s.hiringOutbox.key });
}
export async function inviteToBooking(
  db: Database,
  candidate: Candidate,
  kind: InterviewKind,
  config: HiringConfig,
  key: string,
) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  const expiry = new Date(Date.now() + 14 * 86400000);
  const token = bookingToken(candidate.id, kind, expiry);
  const url = new URL(
    `/hiring/book/${token}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
  const text =
    kind === "paper"
      ? `Dear ${candidate.name},\n\nThank you for your interest in BeGifted. We invite you to our paper-based assessment. Each subject takes about two hours. Please select your subjects and book an onsite appointment:\n${url}\n\nUse the same email as your application. Add our LINE Official Account at https://lin.ee/OjMHF41 for follow-up.\n\nLocation: ${config.location}\n\nBeGifted Education`
      : `Dear ${candidate.name},\n\nYou have passed the recorded paper assessment for ${candidate.paperPassedSubjects.join(", ")}. Please book your onsite mock teaching session:\n${url}\n\nEach subject has a one-hour session. Prepare one IGCSE topic of your choice. The interviewer will also select a topic, which may be from another level. You may use teaching materials or tools.\n\nLocation: ${config.location}\n\nBeGifted Education`;
  await enqueue(db, {
    key,
    candidateId: candidate.id,
    kind: "email",
    payload: {
      to: candidate.email,
      subject:
        kind === "paper"
          ? "BeGifted paper assessment invitation"
          : "BeGifted mock teaching invitation",
      text,
      workflowStage: kind === "paper" ? "paper_invited" : "paper_passed",
    },
  });
  await db
    .update(s.hiringCandidates)
    .set({ inviteExpiresAt: expiry, updatedAt: new Date() })
    .where(eq(s.hiringCandidates.id, candidate.id));
}
export async function inviteToPreScreen(db: Database, candidate: Candidate) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  await enqueue(db, {
    key: `${candidate.id}:pre-screen`,
    candidateId: candidate.id,
    kind: "email",
    payload: {
      to: candidate.email,
      subject: "BeGifted tutor pre-screening questionnaire",
      workflowStage: "pre_screen",
      text: `Dear ${candidate.name},\n\nThank you for your interest in joining BeGifted. Please complete our short pre-screening questionnaire:\n${PRE_SCREEN_URL}\n\nUse this application email: ${candidate.email}. The form takes about 5–7 minutes. We will contact you after reviewing your response.\n\nBeGifted Education`,
    },
  });
}
export async function dashboard(db: Database = getDb()) {
  const [
    { row, config },
    candidates,
    bookings,
    outbox,
    contacts,
    groups,
    auditRows,
  ] = await Promise.all([
    settings(db),
    db
      .select()
      .from(s.hiringCandidates)
      .orderBy(desc(s.hiringCandidates.updatedAt))
      .limit(2000),
    db
      .select()
      .from(s.hiringBookings)
      .orderBy(desc(s.hiringBookings.startTime))
      .limit(2000),
    db
      .select({
        id: s.hiringOutbox.id,
        candidateId: s.hiringOutbox.candidateId,
        kind: s.hiringOutbox.kind,
        status: s.hiringOutbox.status,
        error: s.hiringOutbox.error,
        sentAt: s.hiringOutbox.sentAt,
      })
      .from(s.hiringOutbox)
      .orderBy(desc(s.hiringOutbox.createdAt))
      .limit(4000),
    db.select().from(s.tutorContacts).where(eq(s.tutorContacts.active, true)),
    db.select().from(s.progressLineGroups),
    db
      .select()
      .from(s.hiringAudit)
      .orderBy(desc(s.hiringAudit.createdAt))
      .limit(50),
  ]);
  if (!row) {
    const suggested: Record<string, Subject[]> = {
      Peat: ["Mathematics", "Physics"],
      Ek: ["Mathematics", "Physics"],
      Mimi: ["Chemistry"],
      Tito: ["EFL/ESL", "English Language", "English Literature", "IELTS"],
      Gift: [
        "Biology",
        "Computer Science",
        "ICT",
        "Economics",
        "Business Studies",
        "Psychology",
        "Geography",
        "History",
        "Thai",
        "French",
        "Art & Design Technology",
      ],
    };
    config.interviewers = Object.entries(suggested).flatMap(
      ([key, subjects]) => {
        const contact = contacts.find((c) => c.canonicalKey === key);
        const email = contact?.onsiteEmail ?? contact?.primaryEmail;
        return email ? [{ canonicalKey: key, email, subjects }] : [];
      },
    );
  }
  return {
    config,
    revision: row?.revision ?? 0,
    workerAt: row?.workerAt ?? null,
    workerSummary: row?.workerSummary ?? null,
    workerError: row?.workerError ?? null,
    writeGate: runtimeWritesAllowed(),
    candidates: candidates.map((c) => ({
      ...c,
      profileText: undefined,
      profileScore: c.profileAssessment
        ? profileScore(
            c.profileAssessment,
            config.profileWeights,
            c.universityAssessment?.fraction ?? 0,
          )
        : null,
      preScreenScore: c.preScreenAssessment
        ? profileScore(
            c.preScreenAssessment,
            config.profileWeights,
            c.universityAssessment?.fraction ?? 0,
          )
        : null,
    })),
    bookings,
    outbox,
    audit: auditRows,
    tutors: contacts.map((c) => ({
      canonicalKey: c.canonicalKey,
      name: c.displayName,
      email: c.onsiteEmail ?? c.primaryEmail ?? null,
      lineReady: groups.some(
        (g) => g.canonicalKey === c.canonicalKey && g.enabled,
      ),
    })),
  };
}
export async function bookingView(
  token: string,
  subjects?: Subject[],
  db: Database = getDb(),
  now = new Date(),
) {
  const cap = readBookingToken(token, now);
  const candidate = await candidateById(db, cap.id);
  const { config } = await settings(db);
  const permitted =
    cap.kind === "paper" ? candidate.subjects : candidate.paperPassedSubjects;
  if (
    candidate.stage === "stopped" ||
    !candidate.inviteExpiresAt ||
    candidate.inviteExpiresAt.getTime() < cap.exp * 1000
  )
    throw new HiringError(404, "This booking link is no longer active.");
  if (cap.kind === "mock" && !candidate.paperPassedAt)
    throw new HiringError(409, "The paper result has not been confirmed.");
  if (
    cap.kind === "paper" &&
    !["paper_invited", "paper_booked"].includes(candidate.stage)
  )
    throw new HiringError(409, "This assessment is not ready to book.");
  const chosen = subjects ?? permitted.slice(0, 1);
  if (chosen.some((v) => !permitted.includes(v)) || !chosen.length)
    throw new HiringError(400, "Select a permitted subject.");
  const booked = await db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, candidate.id),
        eq(s.hiringBookings.status, "confirmed"),
      ),
    );
  const remaining = chosen.filter(
    (subject) =>
      !booked.some((b) => b.kind === cap.kind && b.subjects.includes(subject)),
  );
  const canBook =
    config.enabled && config.rubricApproved && runtimeWritesAllowed();
  return {
    kind: cap.kind,
    subjects: permitted,
    selectedSubjects: chosen,
    location: config.location,
    enabled: canBook,
    bookings: booked.map((b) => ({
      id: b.id,
      kind: b.kind,
      subjects: b.subjects,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      interviewer: b.interviewerKey,
    })),
    slots:
      canBook && remaining.length === chosen.length
        ? (await availableSlots(db, config, cap.kind, chosen, now)).filter(
            (slot) =>
              !booked.some((b) =>
                overlap(
                  { start: new Date(slot.start), end: new Date(slot.end) },
                  { start: b.startTime, end: b.endTime },
                ),
              ),
          )
        : [],
  };
}
export async function bookInterview(
  token: string,
  value: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const input = bookingSchema.parse(value);
  const cap = readBookingToken(token, now);
  if (new Set(input.subjects).size !== input.subjects.length)
    throw new HiringError(400, "A subject can only be selected once.");
  const { config } = await settings(db);
  if (!config.enabled || !config.rubricApproved || !runtimeWritesAllowed())
    throw new HiringError(503, "Booking is temporarily unavailable.");
  // Retries return the original appointment, even after the candidate has advanced.
  const prior = await db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, cap.id),
        eq(s.hiringBookings.kind, cap.kind),
        eq(s.hiringBookings.status, "confirmed"),
      ),
    );
  const same = prior.find(
    (b) =>
      b.startTime.toISOString() === input.start &&
      b.interviewerKey === input.interviewerKey &&
      JSON.stringify([...b.subjects].sort()) ===
        JSON.stringify([...input.subjects].sort()),
  );
  if (same) return same;
  const view = await bookingView(token, input.subjects, db, now);
  const slot = view.slots.find(
    (s) => s.start === input.start && s.interviewerKey === input.interviewerKey,
  );
  if (!slot)
    throw new HiringError(
      409,
      "That appointment is no longer available. Refresh the available times.",
    );
  const evidence = await verifyLiveSlot(db, slot);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select id from hiring_candidates where id=${cap.id} for update`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + cap.id},0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${slot.interviewerKey ? "sit-in:" + slot.interviewerKey : "hiring:paper"},0))`,
    );
    const candidate = await candidateById(tx, cap.id);
    if (
      candidate.stage === "stopped" ||
      !candidate.inviteExpiresAt ||
      candidate.inviteExpiresAt.getTime() < cap.exp * 1000
    )
      throw new HiringError(409, "This invitation changed. Contact BeGifted.");
    const existing = await tx
      .select()
      .from(s.hiringBookings)
      .where(
        and(
          eq(s.hiringBookings.candidateId, candidate.id),
          eq(s.hiringBookings.kind, cap.kind),
          eq(s.hiringBookings.status, "confirmed"),
        ),
      );
    const identical = existing.find(
      (b) =>
        b.startTime.toISOString() === input.start &&
        b.interviewerKey === input.interviewerKey &&
        JSON.stringify([...b.subjects].sort()) ===
          JSON.stringify([...input.subjects].sort()),
    );
    if (identical) return identical;
    if (
      existing.some((b) =>
        b.subjects.some((subject) => input.subjects.includes(subject)),
      )
    )
      throw new HiringError(409, "This subject already has an appointment.");
    if (
      cap.kind === "mock" &&
      (!candidate.paperPassedAt ||
        input.subjects.some(
          (subject) => !candidate.paperPassedSubjects.includes(subject),
        ))
    )
      throw new HiringError(409, "The paper result changed. Contact BeGifted.");
    const latest = await settings(tx);
    if (
      !latest.config.enabled ||
      !latest.config.rubricApproved ||
      !runtimeWritesAllowed()
    )
      throw new HiringError(503, "Booking has been paused.");
    const fresh = (
      await availableSlots(
        tx,
        latest.config,
        cap.kind,
        input.subjects,
        new Date(),
      )
    ).find(
      (s) =>
        s.start === input.start && s.interviewerKey === input.interviewerKey,
    );
    if (!fresh)
      throw new HiringError(
        409,
        "This appointment was just taken or availability changed. Choose another time.",
      );
    const interviewer = latest.config.interviewers.find(
      (i) => i.canonicalKey === slot.interviewerKey,
    );
    const [group] = slot.interviewerKey
      ? await tx
          .select()
          .from(s.progressLineGroups)
          .where(
            and(
              eq(s.progressLineGroups.canonicalKey, slot.interviewerKey),
              eq(s.progressLineGroups.enabled, true),
            ),
          )
      : [];
    if (cap.kind === "mock" && (!interviewer || !group))
      throw new HiringError(
        409,
        "Interviewer notifications are not configured.",
      );
    const id = randomUUID();
    const [booking] = await tx
      .insert(s.hiringBookings)
      .values({
        id,
        candidateId: cap.id,
        kind: cap.kind,
        subjects: input.subjects,
        interviewerKey: slot.interviewerKey,
        interviewerEmail: interviewer?.email,
        lineGroupId: group?.groupId,
        calendarOwner: latest.config.connectedEmail,
        startTime: new Date(slot.start),
        endTime: new Date(slot.end),
        evidence,
      })
      .returning();
    await tx
      .update(s.hiringCandidates)
      .set({
        stage: cap.kind === "mock" ? "mock_booked" : "paper_booked",
        revision: candidate.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(s.hiringCandidates.id, candidate.id));
    if (candidate.email)
      await enqueue(tx, {
        key: `booking:${id}:email`,
        candidateId: cap.id,
        bookingId: id,
        kind: "email",
        payload: {
          to: candidate.email,
          subject: `BeGifted ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} confirmed`,
          text: `Dear ${candidate.name},\n\nYour ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} appointment is confirmed.\nSubjects: ${input.subjects.join(", ")}\nTime: ${new Date(slot.start).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}–${new Date(slot.end).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" })} (Bangkok)\nLocation: ${latest.config.location}\n${interviewer ? `Interviewer: ${interviewer.canonicalKey}\n` : ""}\nFor changes, contact BeGifted at https://lin.ee/OjMHF41.\n\nBeGifted Education`,
        },
      });
    await enqueue(tx, {
      key: `booking:${id}:calendar`,
      candidateId: cap.id,
      bookingId: id,
      kind: "calendar",
      payload: {},
    });
    if (group)
      await enqueue(tx, {
        key: `booking:${id}:line`,
        candidateId: cap.id,
        bookingId: id,
        kind: "line",
        payload: {},
      });
    await audit(tx, "candidate-link", "booking", cap.id, {
      bookingId: id,
      kind: cap.kind,
      subjects: input.subjects,
      interviewer: slot.interviewerKey,
    });
    return booking;
  });
}
export async function reviewCandidate(
  id: string,
  input: {
    revision: number;
    action: "advance" | "paper_pass" | "stop";
    subjects: Subject[];
    reason: string;
  },
  actor: string,
  db: Database = getDb(),
) {
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select id from hiring_candidates where id=${id} for update`,
    );
    const c = await candidateById(tx, id),
      { config } = await settings(tx);
    if (c.revision !== input.revision)
      throw new HiringError(409, "This candidate changed. Refresh the page.");
    if (input.action === "stop") {
      const appointments = await tx
        .select()
        .from(s.hiringBookings)
        .where(
          and(
            eq(s.hiringBookings.candidateId, id),
            eq(s.hiringBookings.status, "confirmed"),
          ),
        );
      if (appointments.some((b) => b.endTime > new Date()))
        throw new HiringError(
          409,
          "This candidate has a future appointment. Resolve it with the hiring coordinator before stopping processing.",
        );
      await tx
        .update(s.hiringCandidates)
        .set({
          stage: "stopped",
          reviewNote: input.reason,
          revision: c.revision + 1,
          inviteExpiresAt: null,
        })
        .where(eq(s.hiringCandidates.id, id));
      await tx
        .update(s.hiringOutbox)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(s.hiringOutbox.candidateId, id),
            inArray(s.hiringOutbox.status, ["pending", "failed"]),
          ),
        );
    } else {
      if (
        !input.subjects.length ||
        new Set(input.subjects).size !== input.subjects.length
      )
        throw new HiringError(400, "Select at least one distinct subject.");
      if (input.action === "paper_pass") {
        if (
          ![
            "paper_booked",
            "paper_invited",
            "paper_passed",
            "mock_booked",
          ].includes(c.stage) ||
          input.subjects.some((subject) => !c.subjects.includes(subject))
        )
          throw new HiringError(
            409,
            "Record a pass only for subjects selected for the paper assessment.",
          );
        const papers = await tx
          .select()
          .from(s.hiringBookings)
          .where(
            and(
              eq(s.hiringBookings.candidateId, id),
              eq(s.hiringBookings.kind, "paper"),
              eq(s.hiringBookings.status, "confirmed"),
            ),
          );
        if (papers.some((p) => p.endTime > new Date()))
          throw new HiringError(
            409,
            "The booked paper assessment has not finished.",
          );
        const [updated] = await tx
          .update(s.hiringCandidates)
          .set({
            stage: "paper_passed",
            paperPassedSubjects: input.subjects,
            paperPassedAt: new Date(),
            paperRecordedBy: actor,
            reviewNote: input.reason,
            revision: c.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.hiringCandidates.id, id))
          .returning();
        await inviteToBooking(
          tx,
          updated,
          "mock",
          config,
          `${id}:mock-invite:${updated.revision}`,
        );
      } else {
        if (!["new", "review", "pre_screen"].includes(c.stage))
          throw new HiringError(
            409,
            "This candidate has already advanced. Do not send another paper invitation.",
          );
        if (c.stage === "stopped")
          throw new HiringError(
            409,
            "A stopped candidate must be reviewed before a new application.",
          );
        const [updated] = await tx
          .update(s.hiringCandidates)
          .set({
            stage: c.preScreen ? "paper_invited" : "pre_screen",
            subjects: input.subjects,
            reviewNote: input.reason,
            revision: c.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.hiringCandidates.id, id))
          .returning();
        if (c.preScreen)
          await inviteToBooking(
            tx,
            updated,
            "paper",
            config,
            `${id}:paper-invite:${updated.revision}`,
          );
        else await inviteToPreScreen(tx, updated);
      }
    }
    await audit(tx, actor, input.action, id, {
      subjects: input.subjects,
      reason: input.reason,
    });
  });
}
// Postgres JSONB reorders keys; evidence hashes must survive that round trip.
export const sourceHash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest("hex");
