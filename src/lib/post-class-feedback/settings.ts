import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { bangkokDateStartUtc, todayBangkok } from "@/lib/room-capacity/dates";

import { PostClassConflictError, PostClassNotFoundError, PostClassValidationError } from "./errors";
import { withPostClassTransaction } from "./transaction";

const FIELD_KEYS = ["topics", "performance", "improvement", "homework"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

interface Actor {
  email: string;
  name?: string;
}

export interface PostClassSettingsPatch {
  mode?: "shadow" | "live" | "paused";
  effectiveAt?: string | null;
  mapping?: Partial<Record<FieldKey, string | null>>;
  digestRecipientEmails?: string[];
  expectedVersion: number;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new PostClassValidationError(`Invalid email address: ${email}`);
  }
  return normalized;
}

function normalizeQuestion(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

export function postClassActivationIsBackdated(
  effectiveAt: Date,
  now: Date,
  hasPriorLiveWindow: boolean,
): boolean {
  return !hasPriorLiveWindow && effectiveAt.getTime() < now.getTime() - 60_000;
}

async function roleCoverage(db: Database) {
  const rows = await db
    .select({ capability: schema.postClassAccessGrants.capability })
    .from(schema.postClassAccessGrants)
    .innerJoin(
      schema.adminUsers,
      sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.postClassAccessGrants.email}))`,
    )
    .where(inArray(schema.postClassAccessGrants.capability, ["reviewer", "finance", "access_manager"]));
  const capabilities = new Set(rows.map((row) => row.capability));
  return {
    reviewer: capabilities.has("reviewer"),
    finance: capabilities.has("finance"),
    accessManager: capabilities.has("access_manager"),
  };
}

export function postClassTutorEmailCoverageReady(
  requiredTutorKeys: Iterable<string>,
  contacts: Array<{
    canonicalKey: string;
    primaryEmail: string | null;
    onsiteEmail: string | null;
    onlineEmail: string | null;
  }>,
): boolean {
  const keys = new Set(requiredTutorKeys);
  if (keys.size === 0) return false;
  const contactByTutor = new Map(contacts.map((contact) => [contact.canonicalKey, contact]));
  return [...keys].every((key) => {
    const contact = contactByTutor.get(key);
    if (!contact) return false;
    if (contact.primaryEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.primaryEmail.trim())) {
      return true;
    }
    const wiseEmails = new Set([contact.onsiteEmail, contact.onlineEmail]
      .map((email) => email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))));
    return wiseEmails.size === 1;
  });
}

export async function updatePostClassSettings(
  actor: Actor,
  patch: PostClassSettingsPatch,
  db: Database = getDb(),
) {
  return withPostClassTransaction(db, async (tx) => {
    const [current] = await tx.select().from(schema.postClassSettings).limit(1);
    if (!current) throw new PostClassNotFoundError("Post-class feedback settings are not initialized.");
    if (patch.expectedVersion !== current.version) {
      throw new PostClassConflictError();
    }

    const currentDigestRecipients = await tx
      .select({ email: schema.postClassDigestRecipients.email })
      .from(schema.postClassDigestRecipients)
      .innerJoin(
        schema.adminUsers,
        sql<boolean>`lower(btrim(${schema.adminUsers.email})) = lower(btrim(${schema.postClassDigestRecipients.email}))`,
      )
      .where(eq(schema.postClassDigestRecipients.enabled, true));
    let digestRecipientEmails = currentDigestRecipients
      .map((row) => row.email.trim().toLowerCase())
      .toSorted();

    const before = {
      mode: current.enforcementMode,
      effectiveAt: current.policyEffectiveAt?.toISOString() ?? null,
      mappingVersion: current.formMappingVersion,
      formMappingValid: current.formMappingValid,
      digestRecipientEmails,
      version: current.version,
    };
    const now = new Date();
    let mappingVersion = current.formMappingVersion;
    let mappingValid = current.formMappingValid;

    if (patch.mapping) {
      if (current.enforcementMode === "live") {
        throw new PostClassValidationError("Pause enforcement before changing the Wise form mapping.");
      }
      const existingRows = await tx
        .select()
        .from(schema.postClassFieldMappings)
        .where(and(
          eq(schema.postClassFieldMappings.mappingVersion, current.formMappingVersion),
          eq(schema.postClassFieldMappings.active, true),
        ));
      const currentMap = new Map(existingRows.map((row) => [row.fieldKey, row.wiseQuestionText]));
      const next = Object.fromEntries(FIELD_KEYS.map((key) => [
        key,
        patch.mapping?.[key] === undefined ? currentMap.get(key) ?? null : patch.mapping[key],
      ])) as Record<FieldKey, string | null>;
      mappingValid = Boolean(next.topics?.trim() && next.performance?.trim() && next.improvement?.trim());
      mappingVersion = current.formMappingVersion + 1;
      await tx.insert(schema.postClassFieldMappings).values(FIELD_KEYS.map((key) => ({
        mappingVersion,
        fieldKey: key,
        wiseQuestionText: next[key]?.trim() || "",
        normalizedQuestionText: next[key] ? normalizeQuestion(next[key]!) : "",
        requiredForCompliance: key !== "homework",
        active: true,
        updatedByEmail: actor.email,
      })));
    }

    let effectiveAt = current.policyEffectiveAt;
    if (patch.effectiveAt !== undefined) {
      effectiveAt = patch.effectiveAt
        ? /^\d{4}-\d{2}-\d{2}$/.test(patch.effectiveAt)
          ? patch.effectiveAt === todayBangkok(now)
            ? now
            : bangkokDateStartUtc(patch.effectiveAt)
          : new Date(patch.effectiveAt)
        : null;
      if (effectiveAt && Number.isNaN(effectiveAt.getTime())) {
        throw new PostClassValidationError("Effective date is invalid.");
      }
      if (current.policyEffectiveAt && effectiveAt?.getTime() !== current.policyEffectiveAt.getTime()) {
        throw new PostClassValidationError("The live policy effective date is immutable.");
      }
    }

    const nextMode = patch.mode ?? current.enforcementMode;
    if (nextMode === "live" && current.enforcementMode !== "live") {
      if (!mappingValid) throw new PostClassValidationError("Map all three required Wise fields before activation.");
      const coverage = await roleCoverage(tx);
      if (!coverage.reviewer || !coverage.finance || !coverage.accessManager) {
        throw new PostClassValidationError("Assign reviewer, finance, and access-manager coverage before activation.");
      }
      if (patch.mapping || !current.shadowReviewedAt) {
        throw new PostClassValidationError("Review a completed shadow sync before activation.");
      }
      // Outbound tutor reminders and the admin digest are parked, so relay
      // configuration, test-email delivery, digest recipients, and tutor-email
      // coverage no longer gate activation. The notification subsystem remains
      // in the tree but nothing dispatches it.
      const [priorLiveWindow] = await tx.select({ id: schema.postClassEnforcementWindows.id })
        .from(schema.postClassEnforcementWindows)
        .where(eq(schema.postClassEnforcementWindows.mode, "live"))
        .limit(1);
      effectiveAt ??= now;
      if (postClassActivationIsBackdated(effectiveAt, now, Boolean(priorLiveWindow))) {
        throw new PostClassValidationError("Activation is prospective and cannot be backdated.");
      }
    }

    let currentWindowId = current.currentWindowId;
    if (nextMode !== current.enforcementMode) {
      if (current.currentWindowId) {
        await tx.update(schema.postClassEnforcementWindows)
          .set({ endsAt: now })
          .where(eq(schema.postClassEnforcementWindows.id, current.currentWindowId));
      }
      const [window] = await tx.insert(schema.postClassEnforcementWindows).values({
        mode: nextMode,
        startsAt: now,
        policyEffectiveAt: nextMode === "live" ? effectiveAt : null,
        actorEmail: actor.email,
        reason: nextMode === "paused" ? "Paused from website settings" : null,
      }).returning({ id: schema.postClassEnforcementWindows.id });
      currentWindowId = window.id;
    }

    if (patch.digestRecipientEmails) {
      const emails = [...new Set(patch.digestRecipientEmails.map(normalizeEmail))];
      if (emails.length === 0) {
        throw new PostClassValidationError("Select at least one admin digest recipient.");
      }
      const admins = await tx
        .select({ email: schema.adminUsers.email })
        .from(schema.adminUsers);
      const allowed = new Set(admins.map((row) => row.email.trim().toLowerCase()));
      if (emails.some((email) => !allowed.has(email))) {
        throw new PostClassValidationError("Digest recipients must already be allowlisted admins.");
      }
      await tx.delete(schema.postClassDigestRecipients);
      if (emails.length > 0) {
        await tx.insert(schema.postClassDigestRecipients).values(emails.map((email) => ({
          email,
          enabled: true,
          updatedByEmail: actor.email,
        })));
      }
      digestRecipientEmails = emails.toSorted();
    }

    const [updated] = await tx
      .update(schema.postClassSettings)
      .set({
        enforcementMode: nextMode,
        currentWindowId,
        policyEffectiveAt: effectiveAt,
        formMappingVersion: mappingVersion,
        formMappingValid: mappingValid,
        ...(patch.mapping ? { shadowReviewedAt: null } : {}),
        version: current.version + 1,
        updatedByEmail: actor.email,
        updatedAt: now,
      })
      .where(and(
        eq(schema.postClassSettings.id, current.id),
        eq(schema.postClassSettings.version, current.version),
      ))
      .returning();
    if (!updated) throw new PostClassConflictError();

    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "settings",
      entityKey: current.id,
      action: nextMode !== current.enforcementMode
        ? nextMode === "live" ? "activate" : nextMode === "paused" ? "pause" : "shadow"
        : patch.mapping ? "mapping_update"
          : patch.digestRecipientEmails ? "digest_recipients_update" : "update",
      actorEmail: actor.email,
      beforeValue: before,
      afterValue: {
        mode: updated.enforcementMode,
        effectiveAt: updated.policyEffectiveAt?.toISOString() ?? null,
        mappingVersion: updated.formMappingVersion,
        formMappingValid: updated.formMappingValid,
        digestRecipientEmails,
        version: updated.version,
      },
      note: null,
    });
    return updated;
  });
}

export async function updatePostClassTutorPrimaryEmail(
  actor: Actor,
  input: { tutorKey: string; primaryEmail: string | null; expectedVersion: number },
  db: Database = getDb(),
) {
  const primaryEmail = input.primaryEmail?.trim() ? normalizeEmail(input.primaryEmail) : null;
  return withPostClassTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${
      `post_class_tutor_email:${input.tutorKey}`
    }))`);
    await tx.execute(sql`
      select id
      from tutor_contacts
      where canonical_key = ${input.tutorKey}
      for update
    `);
    const [current] = await tx
      .select()
      .from(schema.tutorContacts)
      .where(eq(schema.tutorContacts.canonicalKey, input.tutorKey))
      .limit(1);
    if (!current) {
      if (input.expectedVersion !== 0) {
        throw new PostClassConflictError();
      }
      const [identity] = await tx.select({ displayName: schema.postClassSessions.canonicalTutorName })
        .from(schema.postClassSessions)
        .where(eq(schema.postClassSessions.canonicalTutorKey, input.tutorKey))
        .limit(1);
      if (!identity) throw new PostClassNotFoundError("Tutor identity was not found.");
      const [created] = await tx.insert(schema.tutorContacts).values({
        canonicalKey: input.tutorKey,
        displayName: identity.displayName ?? input.tutorKey,
        primaryEmail,
        sourceNames: identity.displayName ? [identity.displayName] : [],
      }).returning();
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "tutor_primary_email",
        entityKey: input.tutorKey,
        action: "set",
        actorEmail: actor.email,
        beforeValue: null,
        afterValue: { primaryEmail },
      });
      return created;
    }
    if (!current.active) throw new PostClassNotFoundError("Active tutor contact was not found.");
    if (Math.floor(current.updatedAt.getTime() / 1000) !== input.expectedVersion) {
      throw new PostClassConflictError();
    }

    // Dashboard versions are epoch seconds. Advance by at least one whole
    // second under the tutor-scoped lock so two rapid saves cannot share the
    // same optimistic-concurrency token.
    const updatedAt = new Date(Math.max(
      Date.now(),
      (Math.floor(current.updatedAt.getTime() / 1000) + 1) * 1000,
    ));
    const [updated] = await tx
      .update(schema.tutorContacts)
      .set({ primaryEmail, updatedAt })
      .where(eq(schema.tutorContacts.id, current.id))
      .returning();
    if (!updated) throw new PostClassConflictError();
    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "tutor_primary_email",
      entityKey: input.tutorKey,
      action: primaryEmail ? "set" : "clear",
      actorEmail: actor.email,
      beforeValue: { primaryEmail: current.primaryEmail },
      afterValue: { primaryEmail },
      note: null,
    });
    return updated;
  });
}

/**
 * `evidence` records what the confirming human was actually shown. When the
 * gate passed on an acknowledgement rather than cleanly, the audit row is the
 * only durable statement of which count they accepted and why — the settings
 * row keeps just a timestamp.
 */
export interface PostClassShadowReviewEvidence {
  acknowledgedSessionIssues: number | null;
  reason: string | null;
  conditions: Array<{ key: string; passed: boolean }>;
}

export async function markPostClassShadowReviewed(
  actorEmail: string,
  db: Database = getDb(),
  expectedVersion?: number,
  evidenceSyncRunId?: string,
  evidence?: PostClassShadowReviewEvidence,
) {
  return withPostClassTransaction(db, async (tx) => {
    const [settings] = await tx.select().from(schema.postClassSettings).limit(1);
    if (!settings || settings.enforcementMode !== "shadow") {
      throw new PostClassValidationError("Shadow results can only be confirmed in shadow mode.");
    }
    if (expectedVersion !== undefined && settings.version !== expectedVersion) {
      throw new PostClassConflictError();
    }
    const now = new Date();
    const [updated] = await tx.update(schema.postClassSettings).set({
      shadowReviewedAt: now,
      updatedByEmail: actorEmail,
      version: settings.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassSettings.id, settings.id),
      eq(schema.postClassSettings.version, settings.version),
    )).returning();
    if (!updated) throw new PostClassConflictError();
    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "settings",
      entityKey: settings.id,
      action: "shadow_review_confirmed",
      actorEmail,
      beforeValue: { shadowReviewedAt: settings.shadowReviewedAt?.toISOString() ?? null },
      afterValue: {
        shadowReviewedAt: now.toISOString(),
        evidenceSyncRunId: evidenceSyncRunId ?? null,
        acknowledgedSessionIssues: evidence?.acknowledgedSessionIssues ?? null,
        acknowledgementReason: evidence?.reason ?? null,
        conditions: evidence?.conditions ?? null,
      },
    });
    return updated;
  });
}
