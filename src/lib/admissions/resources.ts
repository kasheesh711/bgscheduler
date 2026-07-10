// Admissions Case Management — curated resource library (PRD CM-92).
//
// Design: docs/casemanagementsystem_design.md §3 (admissions_resources —
// global library, no case scope) and §4 (/resources routes: counselor/admin
// writes, student reads). Resources are grouped by topic: the 10 canonical
// checklist phase keys (config.ts) plus a trailing "general" bucket. Rows
// whose topic is no longer a known key are NEVER dropped or re-bucketed —
// they surface after "general" so bad data stays visible (fail-closed,
// never guess). Staff-only write enforcement lives at the route layer
// (requireCounselorOrAdmin); this module validates shape, not rights.

import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsResources } from "@/lib/db/schema";
import { computeFieldDiff, withAuditedTransaction, writeAuditLog } from "./audit";
import {
  ADMISSIONS_RESOURCE_TOPICS,
  admissionsResourceUrlSchema,
  isAdmissionsResourceTopic,
} from "./shared/resources";
import type { CaseRole } from "./types";

const RESOURCE_DIFF_FIELDS = ["topic", "title", "url", "sortOrder"] as const;

type ResourceRow = typeof admissionsResources.$inferSelect;

// The topic list, topic guards, and https-only URL schema live in the
// client-safe shared module (shared/resources.ts); this module re-exports
// them so existing consumers keep importing from "./resources".
export {
  ADMISSIONS_RESOURCE_TOPICS,
  admissionsResourceUrlSchema,
  getResourceTopicLabel,
  isAdmissionsResourceTopic,
} from "./shared/resources";
export type { AdmissionsResourceTopic } from "./shared/resources";

/** One resource row serialized for API/UI consumers. */
export interface AdmissionsResourceDto {
  id: string;
  topic: string;
  title: string;
  url: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** One topic group in canonical order, with its resources sorted for display. */
export interface AdmissionsResourceTopicGroup {
  topic: string;
  label: string;
  resources: AdmissionsResourceDto[];
}

/** Input for createResource; actor fields feed the paired audit row. */
export interface CreateResourceInput {
  topic: string;
  title: string;
  url: string;
  sortOrder?: number;
  actorEmail: string;
  /** Defaults to "counselor" — resource writes are staff-level (design §4). */
  actorRole?: CaseRole;
}

/** Partial-update input for updateResource; undefined fields are untouched. */
export interface UpdateResourceInput {
  resourceId: string;
  actorEmail: string;
  actorRole: CaseRole;
  topic?: string;
  title?: string;
  url?: string;
  sortOrder?: number;
}

/** Input for softDeleteResource; actor fields feed the paired audit row. */
export interface SoftDeleteResourceInput {
  resourceId: string;
  actorEmail: string;
  actorRole: CaseRole;
}

function toResourceDto(row: ResourceRow): AdmissionsResourceDto {
  return {
    id: row.id,
    topic: row.topic,
    title: row.title,
    url: row.url,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Stable within-topic ordering: sortOrder asc, createdAt asc, id asc tiebreak. */
function compareResources(a: ResourceRow, b: ResourceRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Throws unless `url` passes the shared https-only URL schema. */
function assertResourceUrl(url: string): string {
  const parsed = admissionsResourceUrlSchema.safeParse(url);
  if (!parsed.success) throw new Error("Resource URLs must use https");
  return parsed.data;
}

/**
 * Lists the non-deleted resource library grouped by topic (CM-92).
 *
 * 1. Fetch every non-deleted row in one query.
 * 2. Sort in process (sortOrder asc, createdAt asc, id asc tiebreak) so the
 *    within-topic ordering never depends on the driver.
 * 3. Emit groups in canonical topic order — the 10 checklist phase keys then
 *    "general" — skipping topics with no rows; any rows whose topic is no
 *    longer a known key are appended AFTER "general" (alphabetical by topic,
 *    raw key as label) so nothing silently disappears.
 *
 * @returns the non-empty topic groups in display order.
 */
export async function listResources(
  db: Database = getDb(),
): Promise<AdmissionsResourceTopicGroup[]> {
  const rows = await db
    .select()
    .from(admissionsResources)
    .where(isNull(admissionsResources.deletedAt))
    .orderBy(
      asc(admissionsResources.topic),
      asc(admissionsResources.sortOrder),
      asc(admissionsResources.createdAt),
    );

  const sorted = [...rows].sort(compareResources);
  const byTopic = new Map<string, AdmissionsResourceDto[]>();
  for (const row of sorted) {
    const bucket = byTopic.get(row.topic);
    if (bucket) bucket.push(toResourceDto(row));
    else byTopic.set(row.topic, [toResourceDto(row)]);
  }

  const groups: AdmissionsResourceTopicGroup[] = [];
  for (const entry of ADMISSIONS_RESOURCE_TOPICS) {
    const resources = byTopic.get(entry.key);
    if (!resources) continue;
    groups.push({ topic: entry.key, label: entry.label, resources });
    byTopic.delete(entry.key);
  }
  const unknownTopics = [...byTopic.keys()].sort();
  for (const topic of unknownTopics) {
    groups.push({ topic, label: topic, resources: byTopic.get(topic)! });
  }
  return groups;
}

/**
 * Creates one resource-library entry (CM-92).
 *
 * 1. Validate before touching the database: the topic must be a known key
 *    (phase key or "general"), the title non-empty, and the URL https-only
 *    via the shared Zod schema. sortOrder defaults to 0 (within-topic display
 *    order then falls back to creation time).
 * 2. Inside one audited transaction, insert the admissions_resources row
 *    (title/url trimmed).
 * 3. Write one append-only audit row (entityType "resource", action "create",
 *    caseId null — the library is global, not case-scoped).
 *
 * @returns the created resource DTO.
 */
export async function createResource(
  input: CreateResourceInput,
  db: Database = getDb(),
): Promise<AdmissionsResourceDto> {
  if (!isAdmissionsResourceTopic(input.topic)) {
    throw new Error(`Unknown resource topic: ${input.topic}`);
  }
  const title = input.title.trim();
  if (!title) throw new Error("Resource title must not be empty");
  const url = assertResourceUrl(input.url);
  const sortOrder = input.sortOrder ?? 0;
  const actorRole: CaseRole = input.actorRole ?? "counselor";

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .insert(admissionsResources)
      .values({ topic: input.topic, title, url, sortOrder })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert resource");

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: input.actorEmail,
      actorRole,
      entityType: "resource",
      entityId: row.id,
      action: "create",
      diff: {
        topic: { old: null, new: input.topic },
        title: { old: null, new: title },
        url: { old: null, new: url },
      },
    });

    return toResourceDto(row);
  }, db);
}

/**
 * Partially updates a resource; the mutation and its audit row commit
 * atomically.
 *
 * 1. Validate any provided topic (must be a known key), title (non-empty),
 *    and URL (https-only) before touching the database.
 * 2. Load the resource (not soft-deleted); a miss throws "NotFound".
 * 3. Diff only the provided fields; when nothing actually changed, return the
 *    current DTO without writing (no empty audit rows).
 * 4. Apply the changed fields plus a fresh updatedAt, then write one audit
 *    row (entityType "resource", action "update") carrying the field diff.
 *
 * @returns the updated resource DTO.
 */
export async function updateResource(
  input: UpdateResourceInput,
  db: Database = getDb(),
): Promise<AdmissionsResourceDto> {
  if (input.topic !== undefined && !isAdmissionsResourceTopic(input.topic)) {
    throw new Error(`Unknown resource topic: ${input.topic}`);
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error("Resource title must not be empty");
  }
  const nextUrl = input.url !== undefined ? assertResourceUrl(input.url) : undefined;

  return withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsResources)
      .where(and(
        eq(admissionsResources.id, input.resourceId),
        isNull(admissionsResources.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");

    const diff = computeFieldDiff(
      existing as unknown as Record<string, unknown>,
      {
        topic: input.topic,
        title: input.title?.trim(),
        url: nextUrl,
        sortOrder: input.sortOrder,
      },
      RESOURCE_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toResourceDto(existing);

    const setValues: Partial<typeof admissionsResources.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("topic" in diff) setValues.topic = input.topic;
    if ("title" in diff) setValues.title = input.title?.trim();
    if ("url" in diff) setValues.url = nextUrl;
    if ("sortOrder" in diff) setValues.sortOrder = input.sortOrder;

    const updatedRows = await tx
      .update(admissionsResources)
      .set(setValues)
      .where(eq(admissionsResources.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "resource",
      entityId: existing.id,
      action: "update",
      diff,
    });

    return toResourceDto(updated);
  }, db);
}

/**
 * Soft-deletes a resource (sets deletedAt; the row is retained for the audit
 * trail); the mutation and its audit row commit atomically.
 *
 * 1. Load the resource scoped to not-yet-deleted; a miss — including an
 *    already-deleted row — throws "NotFound" (the second delete 404s rather
 *    than double-auditing).
 * 2. Stamp deletedAt + updatedAt, then write one audit row (entityType
 *    "resource", action "delete") recording the deletion instant.
 */
export async function softDeleteResource(
  input: SoftDeleteResourceInput,
  db: Database = getDb(),
): Promise<void> {
  await withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsResources)
      .where(and(
        eq(admissionsResources.id, input.resourceId),
        isNull(admissionsResources.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");

    const deletedAt = new Date();
    const updatedRows = await tx
      .update(admissionsResources)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(admissionsResources.id, existing.id))
      .returning();
    if (!updatedRows[0]) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "resource",
      entityId: existing.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: deletedAt.toISOString() } },
    });
  }, db);
}
