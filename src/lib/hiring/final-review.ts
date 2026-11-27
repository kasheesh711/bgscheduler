import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { headRecommendation, queueFinalResult, sendRefusal, type Decision } from "./decisions";
import { computeSheet, passRulesFor, rubricTotals } from "./marking-sheet";
import { OFFER_LETTERS, type OfferType } from "./offer-letters";
import { contractTestAllowed, HiringError, HR_CALENDAR, normalizeEmail, runtimeWritesAllowed, type HiringConfig } from "./model";
import { highSchoolFraction, profileScore, workRightsPenalty, type Assessment } from "./scoring";
import { callCalendarState, candidateById, enqueue, settings } from "./service";

const PACKET = "final-review-packet";

export function finalReviewAccess(actor: string) {
  return {
    hr: actor === (normalizeEmail(process.env.HIRING_HR_EMAIL) ?? HR_CALENDAR),
    gift: actor === normalizeEmail(process.env.HIRING_FINAL_REVIEWER_EMAIL),
  };
}

async function evidence(db: Database, id: string, lock = true) {
  const candidate = await candidateById(db, id);
  const recommendation = await headRecommendation(db, id);
  if (recommendation?.detail.decision !== "hire") throw new HiringError(409, "The tutor must recommend Yes first.");
  const subject = candidate.visitSubject ?? candidate.subjects[0];
  if (!candidate.resumeSha256 || !candidate.resumePath || !candidate.profileAssessment)
    throw new HiringError(409, "The original résumé and ATS assessment are required.");
  const { config } = await settings(db);
  const paperQuery = db.select().from(s.hiringPaperResults).where(and(eq(s.hiringPaperResults.candidateId, id),
    eq(s.hiringPaperResults.subject, subject), eq(s.hiringPaperResults.status, "done")));
  const [paper] = await (lock ? paperQuery.for("share") : paperQuery);
  const mockQuery = db.select().from(s.hiringMockResults).where(and(eq(s.hiringMockResults.candidateId, id),
    eq(s.hiringMockResults.subject, subject), eq(s.hiringMockResults.status, "done")));
  const [mock] = await (lock ? mockQuery.for("share") : mockQuery);
  const waiver = candidate.paperWaiver?.subject === subject ? candidate.paperWaiver : null;
  if ((!waiver && (!paper?.marks || !paper.fileId)) || !mock?.rubric || mock.source === "tracker" || !rubricTotals(mock.rubric).complete ||
      (recommendation.detail.mockResultId && recommendation.detail.mockResultId !== mock.id))
    throw new HiringError(409, waiver ? "Complete the mock teaching rubric before final review." : "The graded paper and the completed mock rubric are required.");
  const prestige = candidate.universityAssessment?.fraction ?? 0;
  const penalty = workRightsPenalty(candidate.workRightsAnswer, config);
  const school = highSchoolFraction(candidate.profileAssessment, config);
  const { school: schoolWeight, ...oldWeights } = config.profileWeights;
  const ats: {
    score: number;
    criteria: Assessment["criteria"];
    weights?: Omit<HiringConfig["profileWeights"], "school"> & { school?: number };
    prestige?: number;
    penalty?: number;
    school?: number;
  } = {
    score: profileScore(candidate.profileAssessment, config.profileWeights, prestige, penalty, school),
    criteria: candidate.profileAssessment.criteria,
    // With a high-school weight of 0 the evidence keeps the shape of packets saved before that part, so they stay valid.
    weights: schoolWeight ? config.profileWeights : oldWeights, prestige, penalty, ...(schoolWeight ? { school } : {}),
  };
  return {
    name: candidate.name, email: candidate.email, subject, resumeSha256: candidate.resumeSha256,
    ats,
    ...(waiver ? { paperWaiver: waiver } : {}),
    paper: paper?.marks && paper.fileId ? { id: paper.id, fileId: paper.fileId, updatedAt: paper.updatedAt.toISOString(), ...computeSheet(paper.marks, passRulesFor(config, subject)) } : null,
    mock: { id: mock.id, rubric: mock.rubric, total: rubricTotals(mock.rubric).total },
    recommendation: { id: recommendation.id, head: String(recommendation.detail.head), reason: String(recommendation.detail.reason ?? "") },
    call: candidate.callReview?.good?.at ?? null,
  };
}

type Evidence = Awaited<ReturnType<typeof evidence>>;
/** `offerType` is absent on packets saved before the standard letters. */
type Packet = { evidence: Evidence; behavioral: string; offer: string; offerType?: OfferType; fingerprint: string };
type ReviewInput = { behavioral: string; offerType: OfferType };
// Keep the checksum stable for packets saved before the chart fields were added.
const comparableEvidence = (value: Evidence) => ({ ...value, ats: { score: value.ats.score, criteria: value.ats.criteria } });
const fingerprint = (value: Evidence) => createHash("sha256")
  .update(JSON.stringify(comparableEvidence(value))).digest("hex");

/** The packet still shows the current evidence. A charted packet must also match its chart inputs (Kevin, 20 Nov 2026). */
const packetMatches = (packet: Pick<Packet, "evidence" | "fingerprint">, current: Evidence) =>
  packet.fingerprint === fingerprint(current) && (!packet.evidence.ats.weights || isDeepStrictEqual(packet.evidence, current));

export async function latestReviewPacket(db: Database, id: string) {
  const [row] = await db.select().from(s.hiringAudit).where(and(eq(s.hiringAudit.candidateId, id), eq(s.hiringAudit.action, PACKET)))
    .orderBy(desc(s.hiringAudit.createdAt)).limit(1);
  return row ? { id: row.id, author: row.actor, at: row.createdAt, ...(row.detail as unknown as Packet) } : null;
}

export async function reviewPacketValid(db: Database, id: string, packet: ReviewPacket | null): Promise<boolean | null> {
  if (!packet) return false;
  let currentEvidence: Evidence;
  try {
    currentEvidence = await evidence(db, id, false);
  } catch (error) {
    if (error instanceof HiringError && error.status === 409) return false;
    // Unknown, not stale: the page keeps sign-off locked and asks to check again.
    console.error(`[hiring] packet check failed: ${error instanceof Error ? error.name : "unknown"}`);
    return null;
  }
  return packetMatches(packet, currentEvidence);
}

/** The packet as it would be saved now. Nothing is written. HR only. */
export async function draftReviewPacket(db: Database, id: string, actor: string, input?: ReviewInput): Promise<ReviewPacket> {
  if (!finalReviewAccess(actor).hr) throw new HiringError(403, "Only the final review sender prepares the review packet.");
  const material = await evidence(db, id, false);
  return {
    id: "draft", author: actor, at: new Date(), evidence: material, fingerprint: fingerprint(material),
    behavioral: input?.behavioral ?? "", offerType: input?.offerType,
    offer: input ? OFFER_LETTERS[input.offerType].text(material.name, material.subject) : "",
  };
}

export async function submitReview(db: Database, id: string, actor: string, { behavioral, offerType }: ReviewInput) {
  if (!finalReviewAccess(actor).hr) throw new HiringError(403, "Only the final review sender prepares the review packet.");
  if (!runtimeWritesAllowed()) throw new HiringError(503, "Review packets can be saved only on the live site.");
  const reviewer = normalizeEmail(process.env.HIRING_FINAL_REVIEWER_EMAIL);
  if (!reviewer || reviewer === actor) throw new HiringError(409, "Set up Gift’s sign-in before submitting the review.");
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${id} for no key update`);
    const candidate = await candidateById(tx, id);
    if (["stopped", "hired", "rejected"].includes(candidate.stage)) throw new HiringError(409, "This application is closed.");
    const material = await evidence(tx, id);
    const input = { behavioral, offerType, offer: OFFER_LETTERS[offerType].text(material.name, material.subject) };
    const detail = { evidence: material, fingerprint: fingerprint(material), ...input };
    const previous = await latestReviewPacket(tx, id);
    if (previous?.fingerprint === detail.fingerprint && (previous.evidence.ats.weights
      ? isDeepStrictEqual(previous.evidence, material)
      : isDeepStrictEqual(comparableEvidence(previous.evidence), comparableEvidence(material))) &&
        previous.behavioral === input.behavioral && previous.offer === input.offer)
      return `${id}:final-review:${previous.id}`;
    const [row] = await tx.insert(s.hiringAudit).values({ action: PACKET, actor, candidateId: id, detail }).returning({ id: s.hiringAudit.id });
    const link = new URL(`/hiring?view=hr#review-${id}`, process.env.APP_BASE_URL || "https://bgscheduler.vercel.app");
    const key = `${id}:final-review:${row.id}`;
    await enqueue(tx, { key, candidateId: id, kind: "email",
      payload: { to: reviewer, cc: [], subject: "BeGifted hiring review ready", closeLoop: true, text: `A hiring review is ready for your sign-off.\n\n${link}` } });
    return key;
  });
}

export async function signOffReview(db: Database, id: string, packetId: string, actor: string, decision: Decision, reason: string, now = new Date()) {
  if (!finalReviewAccess(actor).gift) throw new HiringError(403, "Gift’s sign-in is required for final approval.");
  if (!runtimeWritesAllowed()) throw new HiringError(503, "Sign-off is available only on the live site.");
  const { config } = await settings(db);
  if (decision === "hire" && await callCalendarState(db, config, now) !== "readable")
    throw new HiringError(409, "Connect the signing calendar before approving an offer.");
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${id} for no key update`);
    const candidate = await candidateById(tx, id);
    const packet = await latestReviewPacket(tx, id);
    if (!packet || packet.id !== packetId || !packetMatches(packet, await evidence(tx, id)))
      throw new HiringError(409, "The evidence changed. Ask Kevin to submit a new review packet.");
    const latest = (await settings(tx)).config;
    if (decision === "hire" && latest.connectedEmail !== config.connectedEmail)
      throw new HiringError(409, "The signing calendar changed. Refresh and review again.");
    const refusal = decision === "hire" && contractTestAllowed(latest, id) ? null : sendRefusal(latest);
    if (refusal) throw new HiringError(409, refusal);
    const key = await queueFinalResult(tx, candidate, decision, reason, actor, packet.offer, now);
    await tx.insert(s.hiringAudit).values({ actor, action: "final-review-signed", candidateId: id, detail: { packetId, decision, reason, key } });
    return key;
  });
}

export type ReviewPacket = NonNullable<Awaited<ReturnType<typeof latestReviewPacket>>>;
