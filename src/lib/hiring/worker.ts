import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import { pushLineTextMessage, LinePushError } from "@/lib/line/client";
import { progressUsesTutorBot } from "@/lib/line/progress-reminders";
import {
  normalizeSubjects,
  runtimeWritesAllowed,
  type HiringConfig,
} from "./model";
import {
  preScreenResult,
  profileCanAdvance,
  profileScore,
  validateAssessment,
  type Assessment,
} from "./scoring";
import {
  audit,
  candidateById,
  inviteToBooking,
  inviteToPreScreen,
  settings,
  sourceHash,
} from "./service";
import { deliverCalendar } from "./google";
import { syncTracker, mirrorTracker } from "./sources";
import { assessPrestige } from "./prestige";

export type Assess = (source: string, key: string) => Promise<unknown>;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function preScreenText(
  pre: NonNullable<typeof s.hiringCandidates.$inferSelect.preScreen>,
) {
  return Object.entries(pre)
    .filter(([key]) => !["sourceRow", "submittedAt"].includes(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export async function assessCandidates(
  db: Database,
  config: HiringConfig,
  assess: Assess,
  max = 10,
  scoreOnly = false,
) {
  const rows = await db
    .select()
    .from(s.hiringCandidates)
    .where(scoreOnly ? undefined : inArray(s.hiringCandidates.stage, ["new", "review", "pre_screen"]))
    .orderBy(asc(s.hiringCandidates.createdAt));
  let calls = 0;
  for (const candidate of rows) {
    if (calls >= max) break;
    const phase = !scoreOnly && candidate.preScreen ? "pre" : "profile";
    const source =
      phase === "pre"
        ? preScreenText(candidate.preScreen!) +
          "\n\nApplication education and experience:\n" +
          candidate.profileText
        : candidate.profileText;
    if (!source.trim()) continue;
    const hash = sourceHash(source);
    const oldHash =
      phase === "pre" ? candidate.preScreenHash : candidate.profileHash;
    let assessment: Assessment | null =
      phase === "pre"
        ? candidate.preScreenAssessment
        : candidate.profileAssessment;
    if (!assessment && oldHash === hash) continue;
    if (!assessment || oldHash !== hash) {
      const value = await assess(source, `${candidate.id}:${phase}:${hash}`);
      calls++;
      try {
        assessment = validateAssessment(value, source);
      } catch {
        await withDatabaseTransaction(db, async (tx) => {
          const [held] = await tx
            .update(s.hiringCandidates)
            .set({
              ...(scoreOnly ? {} : { stage: "review" as const }),
              ...(phase === "pre"
                ? { preScreenHash: hash, preScreenAssessment: null }
                : { profileHash: hash, profileAssessment: null }),
              reviewNote:
                "AI evidence could not be verified. Review this application before advancing it.",
              revision: candidate.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(s.hiringCandidates.id, candidate.id),
                eq(s.hiringCandidates.revision, candidate.revision),
              ),
            )
            .returning();
          if (held)
            await audit(
              tx,
              "subscription-assessment",
              "invalid-evidence",
              candidate.id,
              { sourceHash: hash, phase },
            );
        });
        continue;
      }
    }
    const catalogHash = sourceHash(config.universities);
    const prestige =
      !candidate.universityAssessment ||
      candidate.universityAssessment.catalogHash !== catalogHash ||
      oldHash !== hash
        ? await assessPrestige(assessment.universities, config, catalogHash)
        : candidate.universityAssessment;
    await withDatabaseTransaction(db, async (tx) => {
      await tx.execute(
        sql`select id from hiring_candidates where id=${candidate.id} for update`,
      );
      const fresh = await candidateById(tx, candidate.id),
        current = await settings(tx);
      if (
        fresh.revision !== candidate.revision ||
        sourceHash(current.config.universities) !== catalogHash ||
        (scoreOnly ? current.config.enabled || current.config.deliveryEnabled : !current.config.enabled) ||
        !current.config.rubricApproved ||
        !runtimeWritesAllowed()
      )
        return;
      const update =
        phase === "pre"
          ? { preScreenHash: hash, preScreenAssessment: assessment }
          : { profileHash: hash, profileAssessment: assessment };
      await tx
        .update(s.hiringCandidates)
        .set({ ...update, universityAssessment: prestige })
        .where(eq(s.hiringCandidates.id, candidate.id));
      if (scoreOnly) {
        await audit(tx, "subscription-assessment", "profile-score-only", candidate.id, { sourceHash: hash });
        return;
      }
      // Historical messages are not a safe invitation ledger. Keep the first import for review.
      const historical =
        candidate.previouslyContacted && !candidate.profileText;
      if (phase === "pre") {
        const declared = normalizeSubjects(candidate.preScreen!.subjects);
        const scoped = {
          ...assessment!,
          subjects: assessment!.subjects.filter((subject) =>
            declared.includes(subject.subject),
          ),
        };
        const result = preScreenResult(
          candidate.preScreen!,
          scoped,
          current.config.requireWeekendAndWeekday,
        );
        if (
          result.eligible &&
          profileScore(
            assessment!,
            current.config.profileWeights,
            prestige.fraction,
          ) >= current.config.profileThreshold &&
          !historical &&
          fresh.stage !== "review"
        ) {
          const [updated] = await tx
            .update(s.hiringCandidates)
            .set({
              stage: "paper_invited",
              subjects: result.subjects,
              revision: fresh.revision + 1,
              updatedAt: new Date(),
              reviewNote: result.issues.join(" ") || null,
            })
            .where(eq(s.hiringCandidates.id, candidate.id))
            .returning();
          await inviteToBooking(
            tx,
            updated,
            "paper",
            current.config,
            `${candidate.id}:paper:${hash}`,
          );
        } else
          await tx
            .update(s.hiringCandidates)
            .set({
              stage: "review",
              reviewNote: historical
                ? "Historical contact requires review before a new invitation."
                : result.issues.join(" ") ||
                  "Pre-screen assessment needs review.",
            })
            .where(eq(s.hiringCandidates.id, candidate.id));
      } else if (
        profileCanAdvance(
          assessment!,
          current.config.profileThreshold,
          current.config.profileWeights,
          prestige.fraction,
        ) &&
        fresh.workRightsConfirmed === true &&
        fresh.stage === "new" &&
        !fresh.previouslyContacted &&
        fresh.email
      ) {
        await inviteToPreScreen(tx, fresh);
        await tx
          .update(s.hiringCandidates)
          .set({
            stage: "pre_screen",
            subjects: assessment!.subjects
              .filter((s) => s.relevant)
              .map((s) => s.subject),
            revision: fresh.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.hiringCandidates.id, candidate.id));
      } else if (phase === "profile" && fresh.stage === "new")
        await tx
          .update(s.hiringCandidates)
          .set({
            stage: "review",
            reviewNote: "Profile evidence needs review; no rejection was sent.",
          })
          .where(eq(s.hiringCandidates.id, candidate.id));
      if (oldHash !== hash)
        await audit(
          tx,
          "subscription-assessment",
          `${phase}-assessment`,
          candidate.id,
          {
            sourceHash: hash,
            score: profileScore(
              assessment!,
              current.config.profileWeights,
              prestige.fraction,
            ),
            university: prestige,
          },
        );
    });
  }
  return calls;
}

export async function deliverOutbox(
  db: Database,
  config: HiringConfig,
  max = 50,
  bookingsOnly = false,
) {
  if (!config.enabled || !config.deliveryEnabled || !runtimeWritesAllowed())
    return 0;
  const now = new Date();
  // A process may have died after provider acceptance. Preserve the original retry key.
  await db
    .update(s.hiringOutbox)
    .set({
      status: "uncertain",
      error: "The previous worker stopped before recording a receipt.",
    })
    .where(
      and(
        eq(s.hiringOutbox.status, "processing"),
        lte(s.hiringOutbox.leaseUntil, now),
      ),
    );
  const jobs = await db
    .select()
    .from(s.hiringOutbox)
    .where(
      and(
        inArray(s.hiringOutbox.status, ["pending", "failed", "uncertain"]),
        bookingsOnly ? isNotNull(s.hiringOutbox.bookingId) : undefined,
        or(
          isNull(s.hiringOutbox.nextAttemptAt),
          lte(s.hiringOutbox.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(asc(s.hiringOutbox.createdAt))
    .limit(max);
  let sent = 0;
  for (const job of jobs) {
    const current = await settings(db);
    if (
      !current.config.enabled ||
      !current.config.deliveryEnabled ||
      !runtimeWritesAllowed()
    )
      break;
    if (
      job.status === "uncertain" &&
      !["calendar", "calendar_cancel"].includes(job.kind) &&
      job.firstAttemptAt &&
      now.getTime() - job.firstAttemptAt.getTime() > 23 * 3600000
    )
      continue;
    const [claimed] = await db
      .update(s.hiringOutbox)
      .set({
        status: "processing",
        attempts: job.attempts + 1,
        firstAttemptAt: job.firstAttemptAt ?? now,
        leaseUntil: new Date(Date.now() + 120000),
      })
      .where(
        and(
          eq(s.hiringOutbox.id, job.id),
          eq(s.hiringOutbox.status, job.status),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      const candidate = await candidateById(db, job.candidateId);
      const [booking] = job.bookingId
        ? await db
            .select()
            .from(s.hiringBookings)
            .where(eq(s.hiringBookings.id, job.bookingId))
        : [];
      if (
        candidate.stage === "stopped" ||
        (job.payload.workflowStage &&
          candidate.stage !== job.payload.workflowStage) ||
        (booking?.status === "cancelled" && job.kind !== "calendar_cancel") ||
        (booking &&
          booking.endTime <= now &&
          !job.firstAttemptAt &&
          job.kind !== "calendar_cancel")
      ) {
        await db
          .update(s.hiringOutbox)
          .set({ status: "cancelled", leaseUntil: null })
          .where(eq(s.hiringOutbox.id, job.id));
        continue;
      }
      let receipt: Record<string, unknown>;
      if (job.kind === "email") {
        const payload = job.payload as {
          to: string;
          subject: string;
          text: string;
        };
        receipt = await createOutboundEmailSender("primary", {
          strictOutcome: true,
          audience: "teacher",
        }).sendEmail({
          ...payload,
          html: `<p>${escape(payload.text).replace(/\n/g, "<br>")}</p>`,
          idempotencyKey: job.id,
        });
      } else {
        if (!booking) throw new Error("Booking record is missing.");
        if (job.kind === "line") {
          if (!booking.lineGroupId || !booking.interviewerKey)
            throw new Error("Interviewer LINE group is missing.");
          const active = await db
            .select()
            .from(s.progressLineGroups)
            .where(
              and(
                eq(s.progressLineGroups.canonicalKey, booking.interviewerKey),
                eq(s.progressLineGroups.groupId, booking.lineGroupId),
                eq(s.progressLineGroups.enabled, true),
              ),
            );
          if (!active.length)
            throw new Error(
              "The interviewer group registration changed. Review delivery.",
            );
          const message = `Mock teaching interview\nCandidate: ${candidate.name}\nSubject: ${booking.subjects.join(", ")}\nTime: ${booking.startTime.toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}–${booking.endTime.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" })} (Bangkok)\nPlace: ${current.config.location}\nInterviewer: ${booking.interviewerKey}`;
          receipt = {
            ...(await pushLineTextMessage({
              to: booking.lineGroupId,
              text: message,
              retryKey: job.id,
              tutorBot: progressUsesTutorBot(booking.interviewerKey),
            })),
          };
        } else
          receipt = await deliverCalendar(
            booking,
            candidate,
            current.config.location,
            db,
            job.kind === "calendar_cancel",
          );
      }
      await db
        .update(s.hiringOutbox)
        .set({
          status: "sent",
          receipt,
          sentAt: new Date(),
          leaseUntil: null,
          error: null,
        })
        .where(eq(s.hiringOutbox.id, job.id));
      sent++;
    } catch (error) {
      const rejected =
        error instanceof ScheduleEmailRejection ||
        (error instanceof LinePushError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408);
      await db
        .update(s.hiringOutbox)
        .set({
          status: rejected ? "failed" : "uncertain",
          error:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "Delivery needs review.",
          leaseUntil: null,
          nextAttemptAt: new Date(
            Date.now() +
              Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6)) * 1000,
          ),
        })
        .where(eq(s.hiringOutbox.id, job.id));
    }
  }
  return sent;
}

export async function runHiringCycle(db: Database, assess: Assess) {
  const { config } = await settings(db);
  if (!config.enabled || !runtimeWritesAllowed())
    throw new Error(
      "Hiring is not enabled. No source writes or messages were made.",
    );
  try {
    const imported = await syncTracker(db, config);
    const calls = await assessCandidates(db, config, assess);
    await mirrorTracker(db, config);
    await db
      .update(s.hiringSettings)
      .set({ workerAt: new Date(), workerError: null })
      .where(eq(s.hiringSettings.id, "default"));
    return { ...imported, calls };
  } catch (error) {
    await db
      .update(s.hiringSettings)
      .set({
        workerError:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Hiring worker failed.",
      })
      .where(eq(s.hiringSettings.id, "default"));
    throw error;
  }
}
