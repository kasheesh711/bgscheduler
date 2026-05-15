import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  ACTIVE_PROPOSAL_STATUSES,
  findAutoResolvedProposalItemIds,
  findConflictingProposal,
  formatBangkokDate,
  formatMinute,
  isActiveProposalStatus,
  proposalSlotsOverlap,
} from "@/lib/proposals/overlap";
import type {
  ProposalActor,
  ProposalCreateInput,
  ProposalHoldSummary,
  ProposalPatchAction,
  ProposalStatus,
} from "@/lib/proposals/types";

const PENDING_HOLD_MS = 48 * 60 * 60 * 1000;

type JoinedProposalRow = {
  itemId: string;
  bundleId: string;
  studentLabel: string;
  notes: string | null;
  tutorGroupId: string | null;
  tutorCanonicalKey: string;
  tutorDisplayName: string;
  scope: "recurring" | "one_time";
  weekday: number;
  proposalDate: string | null;
  startMinute: number;
  endMinute: number;
  subject: string | null;
  curriculum: string | null;
  level: string | null;
  status: ProposalStatus;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  confirmedAt: Date | null;
};

export class ProposalConflictError extends Error {
  constructor(readonly conflict: ProposalHoldSummary) {
    super("Proposal conflicts with an active hold");
    this.name = "ProposalConflictError";
  }
}

export class ProposalNotFoundError extends Error {
  constructor() {
    super("Proposal item not found");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

function addPendingHoldWindow(now: Date): Date {
  return new Date(now.getTime() + PENDING_HOLD_MS);
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function toIsoMaybe(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return toIso(value);
}

function toSummary(row: JoinedProposalRow): ProposalHoldSummary {
  if (!isActiveProposalStatus(row.status)) {
    throw new Error(`Inactive proposal row cannot be summarized as active: ${row.status}`);
  }

  return {
    itemId: row.itemId,
    bundleId: row.bundleId,
    studentLabel: row.studentLabel,
    notes: row.notes ?? undefined,
    tutorGroupId: row.tutorGroupId ?? undefined,
    tutorCanonicalKey: row.tutorCanonicalKey,
    tutorDisplayName: row.tutorDisplayName,
    scope: row.scope,
    weekday: row.weekday,
    date: row.proposalDate ?? undefined,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    startTime: formatMinute(row.startMinute),
    endTime: formatMinute(row.endMinute),
    subject: row.subject ?? undefined,
    curriculum: row.curriculum ?? undefined,
    level: row.level ?? undefined,
    status: row.status,
    createdByEmail: row.createdByEmail ?? undefined,
    createdByName: row.createdByName ?? undefined,
    createdAt: toIso(row.createdAt),
    expiresAt: toIsoMaybe(row.expiresAt),
    confirmedAt: toIsoMaybe(row.confirmedAt),
  };
}

async function selectJoinedProposalItems(
  db: Database,
  statuses?: ProposalStatus[],
): Promise<JoinedProposalRow[]> {
  const base = db
    .select({
      itemId: schema.proposalItems.id,
      bundleId: schema.proposalItems.bundleId,
      studentLabel: schema.proposalBundles.studentLabel,
      notes: schema.proposalBundles.notes,
      tutorGroupId: schema.proposalItems.tutorGroupId,
      tutorCanonicalKey: schema.proposalItems.tutorCanonicalKey,
      tutorDisplayName: schema.proposalItems.tutorDisplayName,
      scope: schema.proposalItems.scope,
      weekday: schema.proposalItems.weekday,
      proposalDate: schema.proposalItems.proposalDate,
      startMinute: schema.proposalItems.startMinute,
      endMinute: schema.proposalItems.endMinute,
      subject: schema.proposalItems.subject,
      curriculum: schema.proposalItems.curriculum,
      level: schema.proposalItems.level,
      status: schema.proposalItems.status,
      createdByEmail: schema.proposalBundles.createdByEmail,
      createdByName: schema.proposalBundles.createdByName,
      createdAt: schema.proposalItems.createdAt,
      expiresAt: schema.proposalItems.expiresAt,
      confirmedAt: schema.proposalItems.confirmedAt,
    })
    .from(schema.proposalItems)
    .innerJoin(
      schema.proposalBundles,
      eq(schema.proposalItems.bundleId, schema.proposalBundles.id),
    );

  const query = statuses && statuses.length > 0
    ? base.where(inArray(schema.proposalItems.status, statuses))
    : base;

  return query.orderBy(desc(schema.proposalItems.createdAt));
}

export async function expireStaleProposalItems(db: Database, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(schema.proposalItems)
    .set({
      status: "expired",
      updatedAt: now,
      lastActionAt: now,
    })
    .where(
      and(
        eq(schema.proposalItems.status, "pending"),
        lte(schema.proposalItems.expiresAt, now),
      ),
    )
    .returning({ id: schema.proposalItems.id });

  return rows.length;
}

export async function autoResolveConfirmedProposalItems(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const confirmedRows = await selectJoinedProposalItems(db, ["confirmed"]);
  const confirmedHolds = confirmedRows.map(toSummary);
  if (confirmedHolds.length === 0) return 0;

  const [activeSnapshot] = await db
    .select({ id: schema.snapshots.id })
    .from(schema.snapshots)
    .where(eq(schema.snapshots.active, true))
    .limit(1);

  if (!activeSnapshot) return 0;

  const sessions = await db
    .select({
      tutorCanonicalKey: schema.tutorIdentityGroups.canonicalKey,
      startTime: schema.futureSessionBlocks.startTime,
      weekday: schema.futureSessionBlocks.weekday,
      startMinute: schema.futureSessionBlocks.startMinute,
      endMinute: schema.futureSessionBlocks.endMinute,
    })
    .from(schema.futureSessionBlocks)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.futureSessionBlocks.groupId, schema.tutorIdentityGroups.id),
    )
    .where(
      and(
        eq(schema.futureSessionBlocks.snapshotId, activeSnapshot.id),
        eq(schema.futureSessionBlocks.isBlocking, true),
      ),
    );

  const resolvedIds = findAutoResolvedProposalItemIds(
    confirmedHolds,
    sessions.map((session) => ({
      tutorCanonicalKey: session.tutorCanonicalKey,
      weekday: session.weekday,
      startMinute: session.startMinute,
      endMinute: session.endMinute,
      date: formatBangkokDate(new Date(session.startTime)),
    })),
  );

  if (resolvedIds.length === 0) return 0;

  const updated = await db
    .update(schema.proposalItems)
    .set({
      status: "auto_resolved",
      autoResolvedAt: now,
      updatedAt: now,
      lastActionAt: now,
    })
    .where(inArray(schema.proposalItems.id, resolvedIds))
    .returning({ id: schema.proposalItems.id });

  return updated.length;
}

export async function reconcileProposalState(db: Database, now: Date = new Date()): Promise<void> {
  await expireStaleProposalItems(db, now);
  await autoResolveConfirmedProposalItems(db, now);
}

export async function listActiveProposalHolds(
  db: Database,
  opts: { reconcile?: boolean; now?: Date } = {},
): Promise<ProposalHoldSummary[]> {
  const now = opts.now ?? new Date();
  if (opts.reconcile !== false) {
    await reconcileProposalState(db, now);
  }

  const rows = await selectJoinedProposalItems(db, [...ACTIVE_PROPOSAL_STATUSES]);
  return rows.map(toSummary);
}

function validateCreateInput(input: ProposalCreateInput): void {
  if (input.studentLabel.trim().length === 0) {
    throw new ProposalValidationError("studentLabel is required");
  }
  if (input.items.length === 0) {
    throw new ProposalValidationError("At least one proposal item is required");
  }

  for (const item of input.items) {
    if (item.startMinute < 0 || item.endMinute > 24 * 60 || item.endMinute <= item.startMinute) {
      throw new ProposalValidationError("Each proposal item needs a valid time range");
    }
    if (item.weekday < 0 || item.weekday > 6) {
      throw new ProposalValidationError("Each proposal item needs a valid weekday");
    }
    if (item.scope === "one_time" && !item.date) {
      throw new ProposalValidationError("One-time proposal items need a date");
    }
  }

  for (let i = 0; i < input.items.length; i++) {
    for (let j = i + 1; j < input.items.length; j++) {
      if (proposalSlotsOverlap(input.items[i], input.items[j])) {
        throw new ProposalValidationError("Requested proposal items overlap each other");
      }
    }
  }
}

export async function createProposalBundle(
  db: Database,
  input: ProposalCreateInput,
  actor: ProposalActor,
  now: Date = new Date(),
): Promise<{ bundleId: string; items: ProposalHoldSummary[] }> {
  validateCreateInput(input);
  await reconcileProposalState(db, now);

  const activeHolds = await listActiveProposalHolds(db, { reconcile: false, now });
  for (const item of input.items) {
    const conflict = findConflictingProposal(item, activeHolds);
    if (conflict) {
      throw new ProposalConflictError(conflict);
    }
  }

  const expiresAt = addPendingHoldWindow(now);
  const inserted = await db.transaction(async (tx) => {
    const [bundle] = await tx
      .insert(schema.proposalBundles)
      .values({
        studentLabel: input.studentLabel.trim(),
        notes: input.notes?.trim() || null,
        createdByEmail: actor.email ?? null,
        createdByName: actor.name ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.proposalBundles.id });

    const items = await tx
      .insert(schema.proposalItems)
      .values(
        input.items.map((item) => ({
          bundleId: bundle.id,
          tutorGroupId: item.tutorGroupId,
          tutorCanonicalKey: item.tutorCanonicalKey,
          tutorDisplayName: item.tutorDisplayName,
          scope: item.scope,
          weekday: item.weekday,
          proposalDate: item.scope === "one_time" ? item.date! : null,
          startMinute: item.startMinute,
          endMinute: item.endMinute,
          subject: item.subject ?? null,
          curriculum: item.curriculum ?? null,
          level: item.level ?? null,
          status: "pending" as const,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          lastActionByEmail: actor.email ?? null,
          lastActionByName: actor.name ?? null,
          lastActionAt: now,
        })),
      )
      .returning({ id: schema.proposalItems.id });

    return { bundleId: bundle.id, itemIds: items.map((item) => item.id) };
  });

  const active = await listActiveProposalHolds(db, { reconcile: false, now });
  return {
    bundleId: inserted.bundleId,
    items: active.filter((item) => inserted.itemIds.includes(item.itemId)),
  };
}

export async function patchProposalItem(
  db: Database,
  itemId: string,
  action: ProposalPatchAction,
  actor: ProposalActor,
  now: Date = new Date(),
): Promise<ProposalHoldSummary[]> {
  await reconcileProposalState(db, now);

  const [current] = await db
    .select({
      id: schema.proposalItems.id,
      bundleId: schema.proposalItems.bundleId,
      status: schema.proposalItems.status,
    })
    .from(schema.proposalItems)
    .where(eq(schema.proposalItems.id, itemId))
    .limit(1);

  if (!current) throw new ProposalNotFoundError();

  const actorPatch = {
    lastActionByEmail: actor.email ?? null,
    lastActionByName: actor.name ?? null,
    lastActionAt: now,
    updatedAt: now,
  };

  if (action === "confirm") {
    if (current.status !== "pending" && current.status !== "confirmed") {
      throw new ProposalValidationError("Only active proposal holds can be confirmed");
    }

    await db.transaction(async (tx) => {
      await tx
        .update(schema.proposalItems)
        .set({
          status: "confirmed",
          expiresAt: null,
          confirmedAt: now,
          ...actorPatch,
        })
        .where(eq(schema.proposalItems.id, itemId));

      await tx
        .update(schema.proposalItems)
        .set({
          status: "released",
          releasedAt: now,
          ...actorPatch,
        })
        .where(
          and(
            eq(schema.proposalItems.bundleId, current.bundleId),
            ne(schema.proposalItems.id, itemId),
            eq(schema.proposalItems.status, "pending"),
          ),
        );
    });
  } else if (action === "release") {
    if (current.status !== "pending" && current.status !== "confirmed") {
      throw new ProposalValidationError("Only active proposal holds can be released");
    }
    await db
      .update(schema.proposalItems)
      .set({
        status: "released",
        releasedAt: now,
        ...actorPatch,
      })
      .where(eq(schema.proposalItems.id, itemId));
  } else if (action === "extend") {
    if (current.status !== "pending") {
      throw new ProposalValidationError("Only pending proposal holds can be extended");
    }
    await db
      .update(schema.proposalItems)
      .set({
        expiresAt: addPendingHoldWindow(now),
        ...actorPatch,
      })
      .where(eq(schema.proposalItems.id, itemId));
  }

  await db
    .update(schema.proposalBundles)
    .set({ updatedAt: now })
    .where(eq(schema.proposalBundles.id, current.bundleId));

  return listActiveProposalHolds(db, { reconcile: false, now });
}
