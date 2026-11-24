import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { fetchLineGroupMember } from "@/lib/line/client";
import { HiringError, normalizeEmail, runtimeWritesAllowed } from "./model";
import { expertsGroup, lineUserIdPattern, onboardingEnabled, requireExpertsGroup, tutorGroupName, tutorGroupTemplate } from "./onboarding-config";
import { audit } from "./service";
import { readBookingToken } from "./tokens";

const email = z.email().max(254).transform((value) => value.toLowerCase());
export const onboardingIntake = z.object({
  legalName: z.string().trim().min(2).max(160),
  preferredName: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{M}\p{N} ._'’()-]+$/u),
  phone: z.string().trim().min(7).max(32).regex(/^\+?[0-9 ()-]+$/),
  onsiteEmail: z.string().trim().pipe(email),
  onlineEmail: z.string().trim().pipe(email),
  lineId: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  earliestStart: z.iso.date(),
}).strict().refine((value) => value.onsiteEmail !== value.onlineEmail, {
  message: "Use different email addresses for the Onsite and Online Wise accounts.",
  path: ["onlineEmail"],
});
export type OnboardingIntake = z.infer<typeof onboardingIntake>;

const o = s.hiringOnboarding;
const m = s.expertsMembers;

async function deliveredOffer(db: Database, token: string, now: Date) {
  if (!onboardingEnabled()) throw new HiringError(503, "Tutor onboarding is temporarily unavailable.");
  const cap = readBookingToken(token, now);
  if (cap.kind !== "onboarding") throw new HiringError(404, "This onboarding link is invalid.");
  const [offer] = await db.select({ candidateId: s.hiringCandidates.id, decisionId: s.hiringDecisions.id })
    .from(s.hiringDecisions)
    .innerJoin(s.hiringCandidates, eq(s.hiringCandidates.id, s.hiringDecisions.candidateId))
    .innerJoin(s.hiringOutbox, eq(s.hiringOutbox.key, s.hiringDecisions.outboxKey))
    .where(and(eq(s.hiringDecisions.id, cap.id), eq(s.hiringDecisions.decision, "hire"),
      eq(s.hiringDecisions.status, "sent"), eq(s.hiringCandidates.stage, "hired"), eq(s.hiringOutbox.status, "sent")));
  if (!offer) throw new HiringError(404, "This onboarding link is no longer active.");
  return offer;
}

export async function onboardingView(db: Database, token: string, now = new Date()) {
  const offer = await deliveredOffer(db, token, now);
  const [row] = await db.select({ lineUserId: o.lineUserId, signedAt: o.signedAt }).from(o)
    .where(and(eq(o.candidateId, offer.candidateId), eq(o.decisionId, offer.decisionId)));
  return { submitted: Boolean(row), linked: Boolean(row?.lineUserId), locked: Boolean(row?.signedAt) };
}

export async function submitOnboarding(db: Database, token: string, raw: unknown, now = new Date()) {
  if (!runtimeWritesAllowed()) throw new HiringError(503, "Tutor onboarding is temporarily unavailable.");
  const intake = onboardingIntake.parse(raw);
  return withDatabaseTransaction(db, async (tx) => {
    const offer = await deliveredOffer(tx, token, now);
    await tx.select({ id: s.hiringCandidates.id }).from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, offer.candidateId)).for("update");
    await deliveredOffer(tx, token, now);
    const [row] = await tx.select().from(o).where(eq(o.candidateId, offer.candidateId)).for("update");
    if (!row) {
      await tx.insert(o).values({ ...offer, intake, submittedAt: now });
      await audit(tx, "candidate-link", "onboarding-submitted", offer.candidateId, {});
      return { linked: false };
    }
    if (row.decisionId !== offer.decisionId) throw new HiringError(409, "Ask BeGifted to review your existing submission.");
    const changed = (Object.keys(intake) as (keyof OnboardingIntake)[]).some((key) => intake[key] !== row.intake[key]);
    if (!changed) return { linked: Boolean(row.lineUserId) };
    if (row.signedAt) throw new HiringError(409, "Ask BeGifted to correct your details after signing.");
    const relink = row.intake.lineId !== intake.lineId;
    await tx.update(o).set({ intake, ...(relink ? { lineUserId: null, lineName: null } : {}) })
      .where(eq(o.candidateId, offer.candidateId));
    await audit(tx, "candidate-link", "onboarding-corrected", offer.candidateId, {});
    return { linked: Boolean(row.lineUserId) && !relink };
  });
}

export async function linkOnboardingLine(db: Database, token: string, profile: { sub: string; name?: string }, now = new Date()) {
  if (!runtimeWritesAllowed() || !lineUserIdPattern.test(profile.sub)) throw new HiringError(403, "LINE could not verify this account.");
  await withDatabaseTransaction(db, async (tx) => {
    const offer = await deliveredOffer(tx, token, now);
    await tx.select({ id: s.hiringCandidates.id }).from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, offer.candidateId)).for("update");
    await deliveredOffer(tx, token, now);
    const [row] = await tx.select().from(o).where(and(eq(o.candidateId, offer.candidateId), eq(o.decisionId, offer.decisionId))).for("update");
    if (row?.lineUserId === profile.sub) return;
    if (!row || row.lineUserId) throw new HiringError(409, "Ask BeGifted to review the linked LINE account.");
    await tx.update(o).set({ lineUserId: profile.sub, lineName: profile.name?.slice(0, 120) || null }).where(eq(o.candidateId, row.candidateId));
    await audit(tx, "candidate-link", "onboarding-line-linked", row.candidateId, {});
  });
}

export const onboardingHrAction = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["signed", "invited", "joined", "reset-line"]), candidateId: z.uuid() }),
  z.object({ action: z.enum(["approve", "ready"]), candidateId: z.uuid(), verified: z.literal(true) }),
  z.object({ action: z.literal("tutor-key"), candidateId: z.uuid(), key: z.string().trim().min(1).max(160) }),
]);

export async function updateOnboarding(db: Database, input: z.infer<typeof onboardingHrAction>, actor: string, now = new Date()) {
  await withDatabaseTransaction(db, async (tx) => {
    const [candidate] = await tx.select({ stage: s.hiringCandidates.stage }).from(s.hiringCandidates)
      .where(eq(s.hiringCandidates.id, input.candidateId)).for("update");
    const [row] = await tx.select().from(o).where(eq(o.candidateId, input.candidateId)).for("update");
    if (!row || candidate?.stage !== "hired") throw new HiringError(404, "This onboarding record is unavailable.");
    const save = async (values: Partial<typeof o.$inferInsert>) => {
      await tx.update(o).set(values).where(eq(o.candidateId, row.candidateId));
    };
    if (input.action === "signed") {
      if (row.signedAt) return;
      await save({ signedAt: now });
    } else if (input.action === "reset-line") {
      if (!row.lineUserId) return;
      const [used] = await tx.select({ id: m.id }).from(m).where(eq(m.lineUserId, row.lineUserId)).limit(1);
      if (used || row.invitedAt) throw new HiringError(409, "Review access for this account before changing it.");
      await save({ lineUserId: null, lineName: null });
    } else {
      if (!row.signedAt || !row.lineUserId) throw new HiringError(409, "Confirm the signed contract and linked LINE account first.");
      if (input.action === "tutor-key") {
        if (row.tutorKey === input.key) return;
        if (row.tutorKey) throw new HiringError(409, "This tutor key is already set. Review it before changing the group.");
        const [contact] = await tx.select().from(s.tutorContacts)
          .where(and(eq(s.tutorContacts.canonicalKey, input.key), eq(s.tutorContacts.active, true)));
        if (!contact || normalizeEmail(contact.onsiteEmail) !== row.intake.onsiteEmail ||
          normalizeEmail(contact.onlineEmail) !== row.intake.onlineEmail) {
          throw new HiringError(409, "Use the active tutor key with the same Onsite and Online Wise emails.");
        }
        const [binding] = await tx.select({ groupId: s.progressLineGroups.groupId }).from(s.progressLineGroups)
          .where(eq(s.progressLineGroups.canonicalKey, input.key));
        if (binding) throw new HiringError(409, "This tutor already has a Progress Check group. Review that group first.");
        await save({ tutorKey: contact.canonicalKey });
      } else if (input.action === "ready") {
        if (row.tutorGroupReadyAt) return;
        if (!row.tutorKey || !tutorGroupTemplate()) throw new HiringError(409, "Verify the tutor key and staff checklist first.");
        const [binding] = await tx.select().from(s.progressLineGroups).where(eq(s.progressLineGroups.canonicalKey, row.tutorKey));
        if (!binding?.tutorBot || binding.groupName !== tutorGroupName(row.intake.preferredName)) {
          throw new HiringError(409, "Register Progress Check in the new tutor group first.");
        }
        const member = await fetchLineGroupMember(binding.groupId, row.lineUserId, true);
        if (!member) throw new HiringError(409, "LINE could not confirm the tutor in the new group.");
        await tx.update(s.progressLineGroups).set({ enabled: true, updatedAt: now })
          .where(eq(s.progressLineGroups.canonicalKey, row.tutorKey));
        await save({ tutorGroupReadyAt: now });
      } else {
        const group = requireExpertsGroup();
        const [baseline] = await tx.select().from(s.expertsBaselines)
          .where(eq(s.expertsBaselines.groupId, group.id)).for("update");
        if (!baseline || baseline.tutorBot !== group.tutorBot) throw new HiringError(409, "Approve the Experts roster first.");
        const [member] = await tx.select().from(m)
          .where(and(eq(m.groupId, group.id), eq(m.lineUserId, row.lineUserId)));
        if (input.action === "approve") {
          if (member && !member.revokedAt) return;
          if (member) {
            await tx.update(m).set({ revokedAt: null, approvedAt: now, approvedBy: actor }).where(eq(m.id, member.id));
            await save({ invitedAt: null, joinedAt: null });
          } else {
            await tx.insert(m).values({ groupId: group.id, lineUserId: row.lineUserId, source: "hire", approvedAt: now, approvedBy: actor });
          }
          await tx.update(s.expertsCases).set({ resolvedAt: now, resolvedBy: actor, resolution: "approved" })
            .where(and(eq(s.expertsCases.groupId, group.id), eq(s.expertsCases.lineUserId, row.lineUserId), isNull(s.expertsCases.resolvedAt)));
        } else {
          if (!member || member.revokedAt) throw new HiringError(409, "Approve the LINE account for Experts first.");
          if (input.action === "invited") {
            if (row.invitedAt) return;
            await save({ invitedAt: now });
          } else {
            if (row.joinedAt) return;
            if (!row.invitedAt) throw new HiringError(409, "Record the direct invitation first.");
            if (!await fetchLineGroupMember(group.id, row.lineUserId, group.tutorBot)) {
              throw new HiringError(409, "LINE could not confirm the account in Experts.");
            }
            await save({ joinedAt: now });
          }
        }
      }
    }
    await audit(tx, actor, `onboarding-${input.action}`, row.candidateId, {});
  });
}

export async function onboardingRoster(db: Database) {
  const rows = await db.select({ record: o, name: s.hiringCandidates.name, stage: s.hiringCandidates.stage,
    binding: { groupId: s.progressLineGroups.groupId, name: s.progressLineGroups.groupName, enabled: s.progressLineGroups.enabled, tutorBot: s.progressLineGroups.tutorBot },
    approvedAt: m.approvedAt, revokedAt: m.revokedAt,
  }).from(o).innerJoin(s.hiringCandidates, eq(o.candidateId, s.hiringCandidates.id))
    .leftJoin(s.progressLineGroups, eq(o.tutorKey, s.progressLineGroups.canonicalKey))
    .leftJoin(m, and(eq(o.lineUserId, m.lineUserId), eq(m.groupId, (expertsGroup()?.id ?? ""))))
    .orderBy(sql`${o.submittedAt} desc`);
  return rows;
}
