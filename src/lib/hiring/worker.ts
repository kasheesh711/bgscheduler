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
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import { pushLineTextMessage, LinePushError } from "@/lib/line/client";
import { progressUsesTutorBot } from "@/lib/line/progress-reminders";
import { runtimeWritesAllowed, type HiringConfig } from "./model";
import {
  askForBriefs,
  availabilityFraction,
  preScreenPoints,
  profileScore,
  validateAssessment,
  validateBriefs,
  validatePreScreenAssessment,
  type Assessment,
  type CriterionId,
  type PreScreenAssessment,
} from "./scoring";
import { profileGate } from "./insights";
import { audit, candidateById, settings, sourceHash } from "./service";
import { formSentAt, releaseQueues, replyCheck, runFollowUps } from "./queue";
import { deliverCalendar } from "./google";
import { syncTracker, mirrorTracker } from "./sources";
import { redactProfile } from "./seek-text";
import { assessPrestige } from "./prestige";

/** `kind` tells the runner which prompt and JSON schema to use. */
export type Assess = (
  source: string,
  key: string,
  kind?: "profile" | "pre-screen",
  /** Pre-screen only: the two written answers as they appear in `source`. */
  written?: string,
) => Promise<unknown>;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type PreScreenRow = NonNullable<typeof s.hiringCandidates.$inferSelect.preScreen>;
// The candidate's own words. Names and contact details in them are redacted like SEEK text before a model sees them.
const FREE_TEXT = ["motivation", "teachingApproach", "englishEvidence", "portfolio"];
export function preScreenText(pre: PreScreenRow, name: string) {
  return Object.entries(pre)
    .filter(([key]) => !["sourceRow", "submittedAt"].includes(key))
    .map(([key, value]) => `${key}: ${FREE_TEXT.includes(key) ? redactProfile(String(value), name) : value}`)
    .join("\n");
}
/** The two written answers, redacted the same way, for the `written` evidence check. */
export const writtenText = (pre: PreScreenRow, name: string) =>
  `${redactProfile(pre.motivation, name)}\n${redactProfile(pre.teachingApproach, name)}`;
const preScreenSource = (c: typeof s.hiringCandidates.$inferSelect) =>
  preScreenText(c.preScreen!, c.name) +
  "\n\nApplication education and experience:\n" +
  c.profileText;

export async function assessCandidates(
  db: Database,
  config: HiringConfig,
  assess: Assess,
  max = 10,
  scoreOnly = false,
  candidateId?: string,
  retryInvalid = false,
  // Called when a finished model answer could not be stored because the row or the settings changed meanwhile.
  onVoided?: () => void,
  // No new assessment starts after this time. Rows left over wait for the next cycle.
  stopAt = Infinity,
) {
  const rows = await db
    .select()
    .from(s.hiringCandidates)
    .where(scoreOnly ? (candidateId ? eq(s.hiringCandidates.id, candidateId) : undefined) : inArray(s.hiringCandidates.stage, ["new", "review", "pre_screen", "no_reply"]))
    .orderBy(asc(s.hiringCandidates.createdAt));
  let calls = 0;
  for (const candidate of rows) {
    if (calls >= max || Date.now() >= stopAt) break;
    const phase = !scoreOnly && candidate.preScreen ? "pre" : "profile";
    const source =
      phase === "pre" ? preScreenSource(candidate) : candidate.profileText;
    if (!source.trim()) continue;
    const hash = sourceHash(source);
    const oldHash =
      phase === "pre" ? candidate.preScreenHash : candidate.profileHash;
    let assessment: Assessment | PreScreenAssessment | null =
      phase === "pre"
        ? candidate.preScreenAssessment
        : candidate.profileAssessment;
    if (scoreOnly && assessment && oldHash === hash &&
      candidate.universityAssessment?.catalogHash === sourceHash(config.universities)) continue;
    if (!assessment && oldHash === hash && !(scoreOnly && retryInvalid)) continue;
    if (!assessment || oldHash !== hash) {
      const value = await assess(
        source,
        `${candidate.id}:${phase}:${hash}`,
        phase === "pre" ? "pre-screen" : "profile",
        phase === "pre" ? writtenText(candidate.preScreen!, candidate.name) : undefined,
      );
      calls++;
      try {
        assessment =
          phase === "pre"
            ? validatePreScreenAssessment(value, source, writtenText(candidate.preScreen!, candidate.name))
            : validateAssessment(value, source);
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
          else onVoided?.();
        });
        continue;
      }
    }
    const catalogHash = sourceHash(config.universities);
    // Only the profile's universities count, so a reply keeps the stored result, as in scorePreScreens. A missing or
    // old-catalog result is recomputed from the profile. A changed profile is recomputed from its new assessment.
    const recomputed =
      candidate.universityAssessment?.catalogHash !== catalogHash || (phase === "profile" && oldHash !== hash)
        ? await assessPrestige(
            (phase === "pre" ? (candidate.profileAssessment ?? assessment) : assessment).universities,
            config,
            catalogHash,
          )
        : null;
    await withDatabaseTransaction(db, async (tx) => {
      await tx.execute(
        sql`select id from hiring_candidates where id=${candidate.id} for update`,
      );
      const fresh = await candidateById(tx, candidate.id),
        current = await settings(tx),
        prestige = recomputed ?? fresh.universityAssessment!;
      if (
        fresh.revision !== candidate.revision ||
        sourceHash(current.config.universities) !== catalogHash ||
        (scoreOnly ? current.config.enabled || current.config.deliveryEnabled : !current.config.enabled) ||
        !current.config.rubricApproved ||
        !runtimeWritesAllowed()
      ) {
        onVoided?.();
        return;
      }
      const update =
        phase === "pre"
          ? { preScreenHash: hash, preScreenAssessment: assessment as PreScreenAssessment }
          : { profileHash: hash, profileAssessment: assessment as Assessment };
      await tx
        .update(s.hiringCandidates)
        .set({
          ...update,
          ...(recomputed ? { universityAssessment: recomputed } : {}),
          ...(scoreOnly && fresh.reviewNote === "AI evidence could not be verified. Review this application before advancing it."
            ? { reviewNote: null } : {}),
        })
        .where(eq(s.hiringCandidates.id, candidate.id));
      if (scoreOnly) {
        await audit(tx, "subscription-assessment", "profile-score-only", candidate.id, { sourceHash: hash });
        return;
      }
      // This step only stores results and moves a row to review. Sends leave through the queue.
      const toReview = async (reasons: string[]) => {
        await tx
          .update(s.hiringCandidates)
          .set({ stage: "review", reviewNote: reasons.join(" "), revision: fresh.revision + 1, updatedAt: new Date() })
          .where(eq(s.hiringCandidates.id, candidate.id));
        await audit(tx, "hiring-worker", "move-to-review", candidate.id, { phase, reasons });
      };
      if (phase === "pre") {
        // A person's review stays as it is. A response at `new` has no matching send, so it goes to review too.
        if (["new", "pre_screen", "no_reply"].includes(fresh.stage)) {
          const check = replyCheck(
            {
              ...fresh,
              preScreenAssessment: assessment as PreScreenAssessment,
              universityAssessment: prestige,
            },
            await formSentAt(tx, candidate.id),
            current.config,
          );
          if (check.kind === "hold") await toReview([check.reason]);
        }
      } else if (fresh.stage === "new") {
        const gate = profileGate(
          {
            ...fresh,
            profileAssessment: assessment as Assessment,
            universityAssessment: prestige,
          },
          current.config,
        );
        // A failure a setting can cure stays at `new`: this sweep runs on every row each cycle, and review has no way back.
        if (gate.review.length) await toReview(gate.reasons);
      }
      if (oldHash !== hash)
        await audit(
          tx,
          "subscription-assessment",
          `${phase}-assessment`,
          candidate.id,
          {
            sourceHash: hash,
            score:
              phase === "pre"
                ? preScreenPoints(
                    assessment!,
                    current.config.preScreenWeights,
                    prestige.fraction,
                    availabilityFraction(candidate.preScreen!),
                  ).total
                : profileScore(
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

/**
 * Score every held pre-screen response, at any stage, with no stage change and no message.
 * It refuses to run while hiring or delivery is on, and it writes one audit row per scored response.
 */
export async function scorePreScreens(
  db: Database,
  config: HiringConfig,
  assess: Assess,
  opts: {
    candidateId?: string;
    retryInvalid?: boolean;
    /** Called when a finished model answer could not be stored because the row or the settings changed meanwhile. */
    onVoided?: () => void;
  } = {},
) {
  if (config.enabled || config.deliveryEnabled)
    throw new Error("Pause live hiring and messages before pre-screen scoring.");
  if (!config.rubricApproved)
    throw new Error("Approve the rubric before pre-screen scoring.");
  const rows = await db
    .select()
    .from(s.hiringCandidates)
    .where(
      and(
        isNotNull(s.hiringCandidates.preScreen),
        opts.candidateId ? eq(s.hiringCandidates.id, opts.candidateId) : undefined,
      ),
    )
    .orderBy(asc(s.hiringCandidates.createdAt));
  const catalogHash = sourceHash(config.universities);
  let calls = 0;
  for (const candidate of rows) {
    const source = preScreenSource(candidate);
    const written = writtenText(candidate.preScreen!, candidate.name);
    const hash = sourceHash(source);
    // An unchanged response is not scored again. One whose answer failed validation is retried only on request.
    if (
      candidate.preScreenHash === hash &&
      (candidate.preScreenAssessment || !opts.retryInvalid)
    )
      continue;
    const value = await assess(source, `${candidate.id}:pre:${hash}`, "pre-screen", written);
    calls++;
    let assessment: PreScreenAssessment | null = null;
    try {
      assessment = validatePreScreenAssessment(value, source, written);
    } catch {
      // The hash is saved so a bad answer is not paid for twice. The note and the stage stay as they are.
    }
    // Leave the stored university result alone: a person may correct it while the model runs, and a stale copy would
    // overwrite that. Only a missing or old-catalog result is recomputed, from the profile's universities, because the
    // profile pass skips a row whose catalog hash is current.
    const recomputed =
      assessment && candidate.universityAssessment?.catalogHash !== catalogHash
        ? await assessPrestige(
            (candidate.profileAssessment ?? assessment).universities,
            config,
            catalogHash,
          )
        : null;
    await withDatabaseTransaction(db, async (tx) => {
      await tx.execute(
        sql`select id from hiring_candidates where id=${candidate.id} for update`,
      );
      const fresh = await candidateById(tx, candidate.id),
        current = await settings(tx);
      if (
        fresh.revision !== candidate.revision ||
        sourceHash(current.config.universities) !== catalogHash ||
        current.config.enabled ||
        current.config.deliveryEnabled ||
        !current.config.rubricApproved ||
        !runtimeWritesAllowed()
      ) {
        opts.onVoided?.();
        return;
      }
      await tx
        .update(s.hiringCandidates)
        .set({
          preScreenHash: hash,
          preScreenAssessment: assessment,
          ...(recomputed ? { universityAssessment: recomputed } : {}),
        })
        .where(eq(s.hiringCandidates.id, candidate.id));
      await audit(
        tx,
        "subscription-assessment",
        assessment ? "pre-screen-score-only" : "pre-screen-invalid-evidence",
        candidate.id,
        {
          sourceHash: hash,
          ...(assessment
            ? {
                score: preScreenPoints(
                  assessment,
                  current.config.preScreenWeights,
                  (recomputed ?? candidate.universityAssessment)?.fraction ?? 0,
                  availabilityFraction(candidate.preScreen!),
                ).total,
              }
            : {}),
        },
      );
    });
  }
  return calls;
}

/** One model call for the brief rewrite: the user text and an audit key in, the raw answer out. */
export type Rewrite = (user: string, key: string) => Promise<unknown>;
const withBriefs = <T extends Assessment | PreScreenAssessment>(
  a: T,
  out: ReturnType<typeof validateBriefs>,
): T => ({
  ...a,
  briefSummary: out.briefSummary,
  criteria: a.criteria.map((c) => ({ ...c, brief: out.briefs[c.id as CriterionId] })),
});
/**
 * Fill the short display lines of stored assessments that have none. It writes only `briefSummary` and each criterion's
 * `brief` into the assessment column: result, evidence, reason, stage, revision, `updatedAt` and the outbox stay as they
 * are. The model sees the summary and reasons, never the source. A line that still breaks its limit after three retries
 * leaves the row as it is. It refuses to run while hiring or messages are on. `max` limits assessments, not retries, and
 * the return value counts the assessments sent to the model.
 */
export async function rewriteBriefs(
  db: Database,
  rewrite: Rewrite,
  opts: {
    max: number;
    candidateId?: string;
    /** Called when a finished rewrite could not be stored because the row or the settings changed meanwhile. */
    onVoided?: () => void;
  },
) {
  const paused = (c: HiringConfig) => !c.enabled && !c.deliveryEnabled;
  if (!paused((await settings(db)).config))
    throw new Error("Pause live hiring and messages before the brief rewrite.");
  const lacks = (column: typeof s.hiringCandidates.profileAssessment | typeof s.hiringCandidates.preScreenAssessment) =>
    and(isNotNull(column), sql`${column}->>'briefSummary' is null`);
  const rows = await db
    .select()
    .from(s.hiringCandidates)
    .where(
      and(
        or(lacks(s.hiringCandidates.profileAssessment), lacks(s.hiringCandidates.preScreenAssessment)),
        opts.candidateId ? eq(s.hiringCandidates.id, opts.candidateId) : undefined,
      ),
    )
    .orderBy(asc(s.hiringCandidates.createdAt))
    .limit(opts.max);
  let calls = 0;
  for (const candidate of rows)
    for (const field of ["profileAssessment", "preScreenAssessment"] as const) {
      const assessment = candidate[field];
      if (!assessment || assessment.briefSummary || calls >= opts.max) continue;
      calls++;
      const user = JSON.stringify({
        summary: assessment.summary,
        criteria: assessment.criteria.map(({ id, result, reason }) => ({ id, result, reason })),
      });
      let attempt = 0;
      const { value, problem } = await askForBriefs(
        (feedback) => rewrite(user + feedback, `${candidate.id}:${field}:briefs:${++attempt}`),
        (answer) => {
          try {
            const out = validateBriefs(answer);
            const missing = assessment.criteria.filter((c) => !out.briefs[c.id as CriterionId]);
            return missing.length
              ? `The brief for ${missing.map((c) => c.id).join(", ")} is missing.`
              : null;
          } catch (error) {
            return error instanceof Error ? error.message : "The answer does not fit the schema.";
          }
        },
      );
      if (problem) {
        await audit(db, "subscription-assessment", "brief-rewrite-skipped", candidate.id, {
          field,
          problem: problem.slice(0, 300),
        });
        continue;
      }
      const out = validateBriefs(value);
      await withDatabaseTransaction(db, async (tx) => {
        await tx.execute(
          sql`select id from hiring_candidates where id=${candidate.id} for update`,
        );
        const fresh = await candidateById(tx, candidate.id),
          current = await settings(tx);
        // A rescored assessment or a switched-on pipeline voids the briefs, which were written for the old text.
        if (
          !paused(current.config) ||
          !runtimeWritesAllowed() ||
          JSON.stringify(fresh[field]) !== JSON.stringify(assessment)
        ) {
          opts.onVoided?.();
          return;
        }
        await tx
          .update(s.hiringCandidates)
          .set(
            field === "profileAssessment"
              ? { profileAssessment: withBriefs(assessment as Assessment, out) }
              : { preScreenAssessment: withBriefs(assessment as PreScreenAssessment, out) },
          )
          .where(eq(s.hiringCandidates.id, candidate.id));
        await audit(tx, "subscription-assessment", "brief-rewrite", candidate.id, { field });
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
      const notice = job.payload.notice as "moved" | "cancelled" | undefined;
      // These report that a visit ended, so they still leave after a cancel, a no-show or a stop.
      const closing = job.kind === "calendar_cancel" || notice === "cancelled";
      if (
        (candidate.stage === "stopped" && !closing) ||
        (job.payload.workflowStage &&
          candidate.stage !== job.payload.workflowStage) ||
        (booking && booking.status !== "confirmed" && !closing) ||
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
          const movedFrom = job.payload.movedFrom as string | undefined;
          const title =
            notice === "moved"
              ? `Mock teaching moved. The old time ${movedFrom ? `${new Date(movedFrom).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })} (Bangkok) ` : ""}is cancelled. The new time is below.`
              : notice === "cancelled"
                ? "Mock teaching cancelled"
                : "Mock teaching interview";
          const message = `${title}\nCandidate: ${candidate.name}\nSubject: ${booking.subjects.join(", ")}\nTime: ${booking.startTime.toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}–${booking.endTime.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" })} (Bangkok)\nPlace: ${current.config.location}\nInterviewer: ${booking.interviewerKey}`;
          receipt = {
            ...(await pushLineTextMessage({
              to: booking.lineGroupId,
              text: message,
              retryKey: job.id,
              tutorBot: progressUsesTutorBot(booking.interviewerKey),
            })),
          };
        } else {
          receipt = await deliverCalendar(
            booking,
            candidate,
            current.config.location,
            db,
            job.kind === "calendar_cancel",
          );
          // Another delivery can run the cancel while this event is being created, and find nothing to cancel yet.
          if (job.kind === "calendar") {
            const [latest] = await db
              .select({ status: s.hiringBookings.status })
              .from(s.hiringBookings)
              .where(eq(s.hiringBookings.id, booking.id));
            if (latest?.status !== "confirmed")
              receipt = await deliverCalendar(booking, candidate, current.config.location, db, true);
          }
        }
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

/** For `after()`: booking messages leave without the Mac. A failure stays out of the response, and the cron retries. */
export async function deliverBookingMessages(db: Database = getDb()) {
  try {
    const { config } = await settings(db);
    return await deliverOutbox(db, config, 20, true);
  } catch (error) {
    console.error("Hiring booking delivery failed", error instanceof Error ? error.name : "UnknownError");
    return 0;
  }
}

// A brief retry makes one assessment up to 4 calls at 180 seconds, and `max` counts assessments, so 10 could hold the
// cycle for two hours. With this budget a cycle stops starting them after 10 minutes, and one already running can add 12.
const ASSESS_BUDGET_MS = 10 * 60000;
export async function runHiringCycle(db: Database, assess: Assess) {
  const { config } = await settings(db);
  if (!config.enabled || !runtimeWritesAllowed())
    throw new Error(
      "Hiring is not enabled. No source writes or messages were made.",
    );
  try {
    const imported = await syncTracker(db, config);
    const calls = await assessCandidates(
      db,
      config,
      assess,
      10,
      false,
      undefined,
      false,
      undefined,
      Date.now() + ASSESS_BUDGET_MS,
    );
    const followUps = await runFollowUps(db);
    const released = await releaseQueues(db);
    await mirrorTracker(db, config);
    await db
      .update(s.hiringSettings)
      .set({ workerAt: new Date(), workerError: null })
      .where(eq(s.hiringSettings.id, "default"));
    return { ...imported, calls, ...followUps, ...released };
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
