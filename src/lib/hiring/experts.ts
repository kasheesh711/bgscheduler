import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { fetchLineGroupMember, fetchLineGroupRoster, fetchLineGroupSummary } from "@/lib/line/client";
import { expertsGroup, hiringOrigin, lineUserIdPattern, requireExpertsGroup } from "./onboarding-config";
import { HiringError, HR_CALENDAR, normalizeEmail } from "./model";
import { audit } from "./service";

const b = s.expertsBaselines;
const m = s.expertsMembers;
const c = s.expertsCases;

export function expertsAlertsEnabled() {
  return process.env.EXPERTS_LINE_ENABLED === "true" && !!expertsGroup()
    && process.env.VERCEL_ENV !== "preview" && process.env.PREVIEW_SANDBOX_ENABLED !== "true";
}

export const expertsHrAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("baseline"), count: z.int().min(1).max(500),
    unresolved: z.array(z.string().trim().min(1).max(120)).max(500), confirmed: z.literal(true) }),
  z.object({ action: z.literal("resolve-baseline"), memberId: z.uuid(), lineUserId: z.string().regex(lineUserIdPattern) }),
  z.object({ action: z.literal("resolve-case"), caseId: z.uuid(),
    outcome: z.enum(["removed", "verified-absent", "roster-checked", "bot-restored"]) }),
  z.object({ action: z.literal("revoke"), memberId: z.uuid() }),
  z.object({ action: z.literal("reconcile") }),
]);

// The baseline and every later membership write take the same group lock.
async function lockBaseline(tx: Database, group: NonNullable<ReturnType<typeof expertsGroup>>) {
  const [baseline] = await tx.select().from(b).where(eq(b.groupId, group.id)).for("update");
  return baseline?.tutorBot === group.tutorBot ? baseline : null;
}

async function captureBaseline(db: Database, group: NonNullable<ReturnType<typeof expertsGroup>>,
  input: Extract<z.infer<typeof expertsHrAction>, { action: "baseline" }>, actor: string, now: Date) {
  const summary = await fetchLineGroupSummary(group.id, group.tutorBot);
  if (summary.groupName !== group.name) throw new HiringError(409, "The LINE group name does not match the approved group.");
  const roster = await fetchLineGroupRoster(group.id, group.tutorBot);
  if (roster.count !== input.count || input.unresolved.length !== roster.count - roster.ids.length) {
    throw new HiringError(409, `LINE reports ${roster.count} people and ${roster.ids.length} available account IDs. Enter one label for each missing ID and verify the group count.`);
  }
  await withDatabaseTransaction(db, async (tx) => {
    const [saved] = await tx.insert(b).values({ groupId: group.id, tutorBot: group.tutorBot, appCount: input.count,
      capturedAt: now, capturedBy: actor }).onConflictDoNothing().returning({ id: b.groupId });
    if (!saved) throw new HiringError(409, "The Experts roster already has a baseline.");
    const defaults = { groupId: group.id, source: "baseline" as const, approvedAt: now, approvedBy: actor };
    await tx.insert(m).values([
      ...roster.ids.map((lineUserId) => ({ ...defaults, lineUserId })),
      ...input.unresolved.map((label) => ({ ...defaults, label })),
    ]);
    await audit(tx, actor, "experts-baseline", null, { groupId: group.id, count: input.count, unresolved: input.unresolved.length });
  });
}

type CaseInput = Pick<typeof c.$inferInsert, "groupId" | "lineUserId" | "eventKey" | "occurredAt" | "reason">;

async function recordCase(tx: Database, input: CaseInput, checkApproval = true) {
  if (input.lineUserId && checkApproval) {
    const [member] = await tx.select({ id: m.id }).from(m).where(and(eq(m.groupId, input.groupId),
      eq(m.lineUserId, input.lineUserId), isNull(m.revokedAt)));
    if (member) return false;
  }
  const subject = input.lineUserId
    ? eq(c.lineUserId, input.lineUserId)
    : and(isNull(c.lineUserId), eq(c.reason, input.reason));
  const [existing] = await tx.select({ id: c.id }).from(c)
    .where(and(eq(c.groupId, input.groupId), subject, or(isNull(c.resolvedAt), gte(c.resolvedAt, input.occurredAt))));
  if (existing) return false;
  const [row] = await tx.insert(c).values(input).onConflictDoNothing().returning({ id: c.id });
  return Boolean(row);
}

const expertsEvent = z.object({
  type: z.enum(["memberJoined", "message", "leave"]),
  source: z.object({ type: z.literal("group"), groupId: z.string(), userId: z.string().optional() }),
  webhookEventId: z.string().min(1).max(100),
  timestamp: z.number().int().positive().max(8_640_000_000_000_000),
  joined: z.object({ members: z.array(z.object({ userId: z.string().optional() })).max(500) }).optional(),
});

export async function recordExpertsEvent(db: Database, tutorBot: boolean, raw: unknown) {
  if (!expertsAlertsEnabled()) return false;
  const group = requireExpertsGroup();
  const result = expertsEvent.safeParse(raw);
  if (!result.success || tutorBot !== group.tutorBot || result.data.source.groupId !== group.id) return false;
  const event = result.data;
  const occurredAt = new Date(event.timestamp);
  const ids = event.type === "memberJoined"
    ? (event.joined?.members.length ? event.joined.members.map((member) => member.userId) : [undefined])
    : [event.type === "message" ? event.source.userId : undefined];
  return withDatabaseTransaction(db, async (tx) => {
    const baseline = await lockBaseline(tx, group);
    if (!baseline || occurredAt < baseline.capturedAt) return false;
    let queued = false;
    for (const id of new Set(ids.map((item) => item && lineUserIdPattern.test(item) ? item : null))) {
      const reason = event.type === "leave" ? "bot-left" : !id ? "identity-missing" : event.type === "message" ? "message" : "join";
      if (await recordCase(tx, { groupId: group.id, eventKey: `${event.webhookEventId}:${id ?? reason}`, lineUserId: id, reason, occurredAt })) queued = true;
    }
    return queued;
  });
}

export async function updateExperts(db: Database, input: z.infer<typeof expertsHrAction>, actor: string, now = new Date()) {
  const group = requireExpertsGroup();
  if (input.action === "baseline") return captureBaseline(db, group, input, actor, now);
  const roster = input.action === "reconcile" ? await fetchLineGroupRoster(group.id, group.tutorBot) : null;
  await withDatabaseTransaction(db, async (tx) => {
    const baseline = await lockBaseline(tx, group);
    if (!baseline) throw new HiringError(409, "Approve the Experts roster first.");
    if (input.action === "resolve-baseline") {
      const [member] = await tx.select().from(m).where(and(eq(m.id, input.memberId), eq(m.groupId, group.id)));
      if (!member || member.lineUserId || member.revokedAt) throw new HiringError(409, "Select an unresolved baseline member.");
      const [known] = await tx.select({ id: m.id }).from(m).where(and(eq(m.groupId, group.id), eq(m.lineUserId, input.lineUserId)));
      if (known) throw new HiringError(409, "This LINE account already has a roster record.");
      if (!await fetchLineGroupMember(group.id, input.lineUserId, group.tutorBot)) {
        throw new HiringError(409, "LINE could not confirm this account in the Experts group.");
      }
      await tx.update(m).set({ lineUserId: input.lineUserId }).where(eq(m.id, member.id));
      await tx.update(c).set({ resolvedAt: now, resolvedBy: actor, resolution: "baseline-verified" })
        .where(and(eq(c.groupId, group.id), eq(c.lineUserId, input.lineUserId), isNull(c.resolvedAt)));
    } else if (input.action === "revoke") {
      const [member] = await tx.update(m).set({ revokedAt: now })
        .where(and(eq(m.id, input.memberId), eq(m.groupId, group.id), isNull(m.revokedAt))).returning();
      if (!member) return;
      await recordCase(tx, { groupId: group.id, eventKey: randomUUID(), lineUserId: member.lineUserId, reason: "revoked", occurredAt: now }, false);
    } else if (input.action === "resolve-case") {
      const [incident] = await tx.select().from(c).where(and(eq(c.id, input.caseId), eq(c.groupId, group.id), isNull(c.resolvedAt)));
      if (!incident) return;
      if (incident.reason === "bot-left") {
        const summary = await fetchLineGroupSummary(group.id, group.tutorBot);
        if (input.outcome !== "bot-restored" || summary.groupName !== group.name) {
          throw new HiringError(409, "Restore the Official Account to the verified Experts group first.");
        }
      } else if (input.outcome === "bot-restored" || (input.outcome === "roster-checked" && incident.lineUserId)) {
        throw new HiringError(409, "Choose the result that matches the LINE check.");
      }
      if (incident.lineUserId) {
        const summary = await fetchLineGroupSummary(group.id, group.tutorBot);
        if (summary.groupName !== group.name) throw new HiringError(409, "The LINE group could not be verified.");
        if (await fetchLineGroupMember(group.id, incident.lineUserId, group.tutorBot)) {
          throw new HiringError(409, "This account is still in the Experts group.");
        }
      }
      await tx.update(c).set({ resolvedAt: now, resolvedBy: actor, resolution: input.outcome }).where(eq(c.id, input.caseId));
    } else if (roster) {
      for (const id of roster.ids) {
        await recordCase(tx, { groupId: group.id, eventKey: randomUUID(), lineUserId: id, reason: "join", occurredAt: now });
      }
      if (roster.count > roster.ids.length) {
        await recordCase(tx, { groupId: group.id, eventKey: randomUUID(), lineUserId: null, reason: "identity-missing", occurredAt: now });
      }
    }
    await audit(tx, actor, `experts-${input.action}`, null, {
      groupId: group.id, ...("memberId" in input ? { memberId: input.memberId } : {}),
      ...("caseId" in input ? { caseId: input.caseId, outcome: input.outcome } : {}),
    });
  });
}

export async function expertsRoster(db: Database) {
  const group = expertsGroup();
  if (!group) return { group, baseline: null, members: [], cases: [], alerts: false };
  const [baseline] = await db.select().from(b).where(and(eq(b.groupId, group.id), eq(b.tutorBot, group.tutorBot)));
  const [members, cases] = baseline ? await Promise.all([
    db.select().from(m).where(eq(m.groupId, group.id)).orderBy(desc(m.approvedAt)),
    db.select().from(c).where(and(eq(c.groupId, group.id), isNull(c.resolvedAt))).orderBy(desc(c.occurredAt)),
  ]) : [[], []];
  return { group, baseline: baseline ?? null, members, cases, alerts: expertsAlertsEnabled() };
}

export async function expertsCaseProfile(db: Database, id: string) {
  const group = requireExpertsGroup();
  const [incident] = await db.select({ lineUserId: c.lineUserId }).from(c)
    .innerJoin(b, eq(c.groupId, b.groupId))
    .where(and(eq(c.id, id), eq(c.groupId, group.id), eq(b.tutorBot, group.tutorBot), isNull(c.resolvedAt)));
  if (!incident?.lineUserId) throw new HiringError(404, "This case has no LINE account to look up.");
  const profile = await fetchLineGroupMember(group.id, incident.lineUserId, group.tutorBot);
  return { available: Boolean(profile), displayName: profile?.displayName ?? null };
}

export async function deliverExpertsAlerts(db: Database, now = new Date()) {
  if (!expertsAlertsEnabled()) return 0;
  const group = requireExpertsGroup();
  const to = normalizeEmail(process.env.HIRING_HR_EMAIL) ?? HR_CALENDAR;
  const [baseline] = await db.select().from(b).where(and(eq(b.groupId, group.id), eq(b.tutorBot, group.tutorBot)));
  if (!baseline) return 0;
  // A process can stop after Gmail accepts a send. Leave that case for review.
  await db.update(c).set({ alertStatus: "review" }).where(and(eq(c.groupId, group.id), eq(c.alertStatus, "sending"),
    lt(c.alertAttemptAt, new Date(now.getTime() - 15 * 60_000))));
  const pending = await db.select({ id: c.id }).from(c).where(and(eq(c.groupId, group.id), isNull(c.resolvedAt),
    eq(c.alertStatus, "pending"), or(isNull(c.alertAttemptAt), lt(c.alertAttemptAt, new Date(now.getTime() - 5 * 60_000)))))
    .orderBy(c.occurredAt).limit(10);
  const sender = createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" });
  let sent = 0;
  for (const { id } of pending) {
    const [row] = await db.update(c).set({ alertStatus: "sending", alertAttemptAt: now })
      .where(and(eq(c.id, id), eq(c.alertStatus, "pending"), isNull(c.resolvedAt),
        or(isNull(c.alertAttemptAt), lt(c.alertAttemptAt, new Date(now.getTime() - 5 * 60_000))))).returning();
    if (!row) continue;
    try {
      await sender.sendEmail({ to, idempotencyKey: `experts:${id}`,
        subject: "BeGifted Experts group needs review",
        text: `Check the Experts group case in Hiring: ${hiringOrigin()}/hiring/onboarding#case-${id}`,
        html: `<p>Check the Experts group case in <a href="${hiringOrigin()}/hiring/onboarding#case-${id}">Hiring</a>.</p>`,
      });
    } catch (error) {
      await db.update(c).set({ alertStatus: error instanceof ScheduleEmailRejection ? "pending" : "review" }).where(eq(c.id, id));
      continue;
    }
    await db.update(c).set({ alertStatus: "sent" }).where(eq(c.id, id));
    sent++;
  }
  return sent;
}
