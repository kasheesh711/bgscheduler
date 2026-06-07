import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listCurrentLineStudentsByKeys, type LineContactStudentLinkStatus } from "./student-links";
import { buildLineOperationalReviewPlan } from "@/lib/line/operational";
import { patchLineSchedulerOperationalPlan } from "@/lib/line/data";

type LinkRow = typeof schema.lineContactStudentLinks.$inferSelect;
type ContactRow = typeof schema.lineContacts.$inferSelect;
type AdminUserRow = typeof schema.adminUsers.$inferSelect;

export type LineLinkValidationScope = "my" | "all" | "unassigned" | "verified" | "rejected" | "phantom";

export interface LineLinkValidationActor {
  email?: string | null;
  name?: string | null;
}

export interface LineLinkValidationTaskDto {
  id: string;
  contactId: string;
  lineUserId: string;
  contactDisplayName: string | null;
  linkedStudentLabel: string | null;
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  status: LineContactStudentLinkStatus;
  confidence: number | null;
  lineChatUrl: string | null;
  lineOaAccountId: string | null;
  chatTitle: string | null;
  adminNoteRaw: string | null;
  relationshipRole: string | null;
  sourceRunId: string | null;
  sourceRowId: string | null;
  matchedCode: string | null;
  matchedField: string | null;
  validationAssignedToEmail: string | null;
  validationAssignedToName: string | null;
  validationAssignedRunId: string | null;
  validationAssignedAt: string | null;
  validationNote: string | null;
  reviewedByEmail: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  currentStudentActivated: boolean | null;
  currentStudentHasFutureSessions: boolean | null;
  currentStudentHasLivePackage: boolean | null;
}

export interface LineLinkValidationReviewerDto {
  email: string;
  name: string | null;
  openAssignments: number;
}

export interface LineLinkValidationReviewerSummaryDto {
  email: string;
  name: string | null;
  assigned: number;
  verified: number;
  rejected: number;
  remaining: number;
  completionRate: number;
}

export interface LineLinkValidationPaginationDto {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface LineLinkValidationSummaryDto {
  canViewTracker: boolean;
  runId: string | null;
  totals: {
    assigned: number;
    unassigned: number;
    verified: number;
    rejected: number;
    remaining: number;
    total: number;
    completionRate: number;
  };
  reviewers: LineLinkValidationReviewerSummaryDto[];
  recentActivity: LineLinkValidationTaskDto[];
}

export class LineLinkValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "LineLinkValidationError";
  }
}

export interface ValidationAssignmentCandidate {
  id: string;
  sortKey: string;
}

export interface ValidationAssignmentReviewer {
  email: string;
  name: string | null;
  openAssignments: number;
}

export interface PlannedValidationAssignment {
  linkId: string;
  reviewerEmail: string;
  reviewerName: string | null;
}

const DEFAULT_LINE_VALIDATION_LEAD_EMAILS = [
  "kevhsh7@gmail.com",
  "kevinhsieh711@gmail.com",
];

function now(): Date {
  return new Date();
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function actorFromInput(actor: LineLinkValidationActor): { email: string | null; name: string | null } {
  return {
    email: actor.email?.trim().toLowerCase() || null,
    name: actor.name?.trim() || null,
  };
}

function emptySummary(runId?: string | null, canViewTracker = false): LineLinkValidationSummaryDto {
  return {
    canViewTracker,
    runId: runId ?? null,
    totals: {
      assigned: 0,
      unassigned: 0,
      verified: 0,
      rejected: 0,
      remaining: 0,
      total: 0,
      completionRate: 0,
    },
    reviewers: [],
    recentActivity: [],
  };
}

function percent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
}

export function normalizeLineLinkValidationPagination(input: {
  page?: number;
  pageSize?: number;
}): { page: number; pageSize: number; offset: number } {
  const page = Number.isInteger(input.page) ? Math.max(1, input.page as number) : 1;
  const pageSize = Number.isInteger(input.pageSize)
    ? Math.min(100, Math.max(1, input.pageSize as number))
    : 100;
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function buildLineLinkValidationPagination(
  total: number,
  paging: { page: number; pageSize: number },
): LineLinkValidationPaginationDto {
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    total,
    pageCount: Math.ceil(total / paging.pageSize),
  };
}

export function lineLinkValidationTotalsFromCounts(row: {
  assigned?: string | number | null;
  unassigned?: string | number | null;
  verified?: string | number | null;
  rejected?: string | number | null;
}): LineLinkValidationSummaryDto["totals"] {
  const assigned = Number(row.assigned ?? 0);
  const unassigned = Number(row.unassigned ?? 0);
  const verified = Number(row.verified ?? 0);
  const rejected = Number(row.rejected ?? 0);
  const remaining = assigned + unassigned;
  const total = remaining + verified + rejected;
  return {
    assigned,
    unassigned,
    verified,
    rejected,
    remaining,
    total,
    completionRate: percent(verified + rejected, total),
  };
}

export function uniqueLineLinkValidationStudentKeys(rows: Array<{ link: { studentKey: string } }>): string[] {
  return [...new Set(rows.map((row) => row.link.studentKey).filter(Boolean))];
}

export function lineValidationLeadEmails(): string[] {
  const configured = process.env.LINE_VALIDATION_LEAD_EMAILS
    ?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const source = configured && configured.length > 0
    ? configured
    : DEFAULT_LINE_VALIDATION_LEAD_EMAILS;
  return [...new Set(source)];
}

export function isLineValidationLeadEmail(email?: string | null): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && lineValidationLeadEmails().includes(normalized));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// D-04/IDENT-05: real contact condition — excludes phantom OA-resolver rows from active scopes
function realContactCondition() {
  return eq(schema.lineContactStudentLinks.isPhantom, false);
}

function lineOaResolverRunCondition(runId: string) {
  return eq(schema.lineContactStudentLinks.sourceRunId, runId);
}

function normalizeReviewerEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function taskSortKey(row: LinkRow, contact?: ContactRow | null): string {
  return [
    row.parentName,
    row.studentName,
    row.studentKey,
    contact?.displayName ?? "",
    row.contactId,
    row.id,
  ].map((part) => part.toLowerCase()).join("\u0000");
}

function linkTaskToDto(
  row: LinkRow,
  contact: ContactRow,
  currentStudent: {
    activated: boolean;
    hasFutureSessions: boolean;
    hasLivePackage: boolean;
  } | null,
): LineLinkValidationTaskDto {
  const evidence = asRecord(row.evidence);
  return {
    id: row.id,
    contactId: row.contactId,
    lineUserId: contact.lineUserId,
    contactDisplayName: contact.displayName,
    linkedStudentLabel: contact.linkedStudentLabel,
    wiseStudentId: row.wiseStudentId,
    studentKey: row.studentKey,
    studentName: row.studentName,
    parentName: row.parentName,
    status: row.status,
    confidence: row.confidence,
    lineChatUrl: asString(evidence.originalUrl),
    lineOaAccountId: asString(evidence.lineOaAccountId),
    chatTitle: asString(evidence.chatTitle),
    adminNoteRaw: asString(evidence.adminNoteRaw),
    relationshipRole: asString(evidence.relationshipRole),
    sourceRunId: row.sourceRunId ?? asString(evidence.runId),
    sourceRowId: asString(evidence.rowId),
    matchedCode: asString(evidence.matchedCode),
    matchedField: asString(evidence.matchedField),
    validationAssignedToEmail: row.validationAssignedToEmail,
    validationAssignedToName: row.validationAssignedToName,
    validationAssignedRunId: row.validationAssignedRunId,
    validationAssignedAt: iso(row.validationAssignedAt),
    validationNote: row.validationNote,
    reviewedByEmail: row.reviewedByEmail,
    reviewedByName: row.reviewedByName,
    reviewedAt: iso(row.reviewedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    currentStudentActivated: currentStudent?.activated ?? null,
    currentStudentHasFutureSessions: currentStudent?.hasFutureSessions ?? null,
    currentStudentHasLivePackage: currentStudent?.hasLivePackage ?? null,
  };
}

async function linkRowsToDtos(
  db: Database,
  rows: Array<{ link: LinkRow; contact: ContactRow }>,
): Promise<LineLinkValidationTaskDto[]> {
  const studentsByKey = new Map(
    (await listCurrentLineStudentsByKeys(db, uniqueLineLinkValidationStudentKeys(rows)))
      .map((student) => [student.studentKey, student]),
  );
  return rows.map((row) => linkTaskToDto(
    row.link,
    row.contact,
    studentsByKey.get(row.link.studentKey) ?? null,
  ));
}

export function planRoundRobinValidationAssignments(
  tasks: ValidationAssignmentCandidate[],
  reviewers: ValidationAssignmentReviewer[],
): PlannedValidationAssignment[] {
  if (reviewers.length === 0 || tasks.length === 0) return [];
  const counts = new Map<string, number>();
  reviewers.forEach((reviewer) => counts.set(reviewer.email, reviewer.openAssignments));

  return [...tasks]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((task) => {
      const reviewer = reviewers.reduce((best, candidate) => {
        const bestCount = counts.get(best.email) ?? 0;
        const candidateCount = counts.get(candidate.email) ?? 0;
        return candidateCount < bestCount ? candidate : best;
      }, reviewers[0]);
      counts.set(reviewer.email, (counts.get(reviewer.email) ?? 0) + 1);
      return {
        linkId: task.id,
        reviewerEmail: reviewer.email,
        reviewerName: reviewer.name,
      };
    });
}

export async function listLineLinkValidationReviewers(
  db: Database,
  runId?: string | null,
): Promise<LineLinkValidationReviewerDto[]> {
  const [adminRows, assignmentRows] = await Promise.all([
    db
      .select()
      .from(schema.adminUsers)
      .orderBy(asc(schema.adminUsers.email)),
    db
      .select({
        email: schema.lineContactStudentLinks.validationAssignedToEmail,
        count: sql<string>`count(*)::text`,
      })
      .from(schema.lineContactStudentLinks)
      .where(and(
        realContactCondition(),
        eq(schema.lineContactStudentLinks.status, "suggested"),
        sql`${schema.lineContactStudentLinks.validationAssignedToEmail} IS NOT NULL`,
        ...(runId ? [lineOaResolverRunCondition(runId)] : []),
      ))
      .groupBy(schema.lineContactStudentLinks.validationAssignedToEmail),
  ]);

  const counts = new Map<string, number>();
  for (const row of assignmentRows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) continue;
    counts.set(email, Number(row.count));
  }

  return adminRows.map((row) => ({
    email: row.email,
    name: row.name,
    openAssignments: counts.get(row.email.toLowerCase()) ?? 0,
  }));
}

export async function listLineLinkValidationTasks(
  db: Database,
  input: {
    scope: LineLinkValidationScope;
    runId?: string | null;
    actor: LineLinkValidationActor;
    page?: number;
    pageSize?: number;
  },
): Promise<{
  tasks: LineLinkValidationTaskDto[];
  reviewers: LineLinkValidationReviewerDto[];
  pagination: LineLinkValidationPaginationDto;
}> {
  const actor = actorFromInput(input.actor);
  const paging = normalizeLineLinkValidationPagination(input);

  // D-03: "phantom" scope is the archive filter — shows only quarantined rows.
  // All other (active) scopes use realContactCondition() to exclude phantoms.
  const isPhantomScope = input.scope === "phantom";
  const conditions: SQL[] = [
    isPhantomScope
      ? eq(schema.lineContactStudentLinks.isPhantom, true)
      : realContactCondition(),
  ];
  if (input.runId) conditions.push(lineOaResolverRunCondition(input.runId));

  if (isPhantomScope) {
    // D-03 archive filter: no additional status constraints — return all phantom rows regardless of status
  } else if (input.scope === "my") {
    if (!actor.email) {
      return {
        tasks: [],
        reviewers: await listLineLinkValidationReviewers(db, input.runId),
        pagination: buildLineLinkValidationPagination(0, paging),
      };
    }
    conditions.push(eq(schema.lineContactStudentLinks.status, "suggested"));
    conditions.push(eq(schema.lineContactStudentLinks.validationAssignedToEmail, actor.email));
  } else if (input.scope === "unassigned") {
    conditions.push(eq(schema.lineContactStudentLinks.status, "suggested"));
    conditions.push(isNull(schema.lineContactStudentLinks.validationAssignedToEmail));
  } else if (input.scope === "verified") {
    conditions.push(eq(schema.lineContactStudentLinks.status, "verified"));
  } else if (input.scope === "rejected") {
    conditions.push(eq(schema.lineContactStudentLinks.status, "rejected"));
  } else {
    conditions.push(eq(schema.lineContactStudentLinks.status, "suggested"));
  }

  const where = and(...conditions);
  const [countRows, rows, reviewers] = await Promise.all([
    db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.lineContactStudentLinks)
      .where(where),
    db
      .select({
        link: schema.lineContactStudentLinks,
        contact: schema.lineContacts,
      })
      .from(schema.lineContactStudentLinks)
      .innerJoin(schema.lineContacts, eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id))
      .where(where)
      .orderBy(
        asc(schema.lineContactStudentLinks.parentName),
        asc(schema.lineContactStudentLinks.studentName),
        asc(schema.lineContactStudentLinks.studentKey),
        asc(schema.lineContacts.displayName),
      )
      .limit(paging.pageSize)
      .offset(paging.offset),
    listLineLinkValidationReviewers(db, input.runId),
  ]);
  const total = Number(countRows[0]?.count ?? "0");

  return {
    tasks: await linkRowsToDtos(db, rows),
    reviewers,
    pagination: buildLineLinkValidationPagination(total, paging),
  };
}

export async function getLineLinkValidationSummary(
  db: Database,
  input: {
    runId?: string | null;
    actor: LineLinkValidationActor;
  },
): Promise<LineLinkValidationSummaryDto> {
  const actor = actorFromInput(input.actor);
  if (!isLineValidationLeadEmail(actor.email)) {
    return emptySummary(input.runId, false);
  }

  // IDENT-05: all count aggregates exclude phantom rows via realContactCondition()
  const conditions: SQL[] = [realContactCondition()];
  if (input.runId) conditions.push(lineOaResolverRunCondition(input.runId));
  const where = and(...conditions);
  const reviewerEmail = sql<string>`coalesce(${schema.lineContactStudentLinks.reviewedByEmail}, ${schema.lineContactStudentLinks.validationAssignedToEmail})`;
  const reviewerName = sql<string>`coalesce(${schema.lineContactStudentLinks.reviewedByName}, ${schema.lineContactStudentLinks.validationAssignedToName})`;

  const [totalRows, reviewerRows, adminRows, recentRows] = await Promise.all([
    db
      .select({
        assigned: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'suggested'
            and ${schema.lineContactStudentLinks.validationAssignedToEmail} is not null
        )::text`,
        unassigned: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'suggested'
            and ${schema.lineContactStudentLinks.validationAssignedToEmail} is null
        )::text`,
        verified: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'verified'
        )::text`,
        rejected: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'rejected'
        )::text`,
      })
      .from(schema.lineContactStudentLinks)
      .where(where),
    db
      .select({
        email: reviewerEmail,
        name: reviewerName,
        assigned: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'suggested'
            and ${schema.lineContactStudentLinks.validationAssignedToEmail} is not null
        )::text`,
        verified: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'verified'
        )::text`,
        rejected: sql<string>`count(*) filter (
          where ${schema.lineContactStudentLinks.status} = 'rejected'
        )::text`,
      })
      .from(schema.lineContactStudentLinks)
      .where(and(
        ...conditions,
        sql`${reviewerEmail} IS NOT NULL`,
      ))
      .groupBy(reviewerEmail, reviewerName),
    db
      .select()
      .from(schema.adminUsers)
      .orderBy(asc(schema.adminUsers.email)),
    db
      .select({
        link: schema.lineContactStudentLinks,
        contact: schema.lineContacts,
      })
      .from(schema.lineContactStudentLinks)
      .innerJoin(schema.lineContacts, eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id))
      .where(and(
        ...conditions,
        inArray(schema.lineContactStudentLinks.status, ["verified", "rejected"]),
      ))
      .orderBy(
        desc(sql`coalesce(${schema.lineContactStudentLinks.reviewedAt}, ${schema.lineContactStudentLinks.updatedAt})`),
      )
      .limit(10),
  ]);

  const totals = lineLinkValidationTotalsFromCounts(totalRows[0] ?? {});

  const reviewerMap = new Map<string, LineLinkValidationReviewerSummaryDto>();
  function ensureReviewer(email: string, name?: string | null): LineLinkValidationReviewerSummaryDto {
    const normalized = email.trim().toLowerCase();
    const existing = reviewerMap.get(normalized);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return existing;
    }
    const reviewer = {
      email: normalized,
      name: name ?? null,
      assigned: 0,
      verified: 0,
      rejected: 0,
      remaining: 0,
      completionRate: 0,
    };
    reviewerMap.set(normalized, reviewer);
    return reviewer;
  }

  for (const admin of adminRows) {
    ensureReviewer(admin.email, admin.name);
  }

  for (const row of reviewerRows) {
    if (!row.email) continue;
    const reviewer = ensureReviewer(row.email, row.name);
    reviewer.assigned += Number(row.assigned);
    reviewer.remaining += Number(row.assigned);
    reviewer.verified += Number(row.verified);
    reviewer.rejected += Number(row.rejected);
  }

  const reviewers = [...reviewerMap.values()]
    .map((reviewer) => {
      const completed = reviewer.verified + reviewer.rejected;
      return {
        ...reviewer,
        completionRate: percent(completed, completed + reviewer.remaining),
      };
    })
    .sort((a, b) => (
      (b.remaining + b.verified + b.rejected) - (a.remaining + a.verified + a.rejected)
      || a.email.localeCompare(b.email)
    ));

  return {
    canViewTracker: true,
    runId: input.runId ?? null,
    totals,
    reviewers,
    recentActivity: await linkRowsToDtos(db, recentRows),
  };
}

export async function assignLineLinkValidationTasks(
  db: Database,
  input: {
    runId: string;
    reviewerEmails: string[];
    linkIds?: string[];
  },
): Promise<{
  assigned: number;
  reviewers: LineLinkValidationReviewerDto[];
  tasks: LineLinkValidationTaskDto[];
  pagination: LineLinkValidationPaginationDto;
}> {
  const reviewerEmails = normalizeReviewerEmails(input.reviewerEmails);
  if (reviewerEmails.length === 0) {
    throw new LineLinkValidationError("Select at least one reviewer.");
  }

  const admins = await db
    .select()
    .from(schema.adminUsers)
    .where(inArray(schema.adminUsers.email, reviewerEmails));
  const adminsByEmail = new Map(admins.map((admin) => [admin.email.toLowerCase(), admin]));
  const missing = reviewerEmails.filter((email) => !adminsByEmail.has(email));
  if (missing.length > 0) {
    throw new LineLinkValidationError(`Unknown reviewer email: ${missing.join(", ")}`);
  }

  const reviewersBefore = await listLineLinkValidationReviewers(db, input.runId);
  const openCountsByEmail = new Map(reviewersBefore.map((reviewer) => [
    reviewer.email.toLowerCase(),
    reviewer.openAssignments,
  ]));
  const reviewers = reviewerEmails.map((email) => {
    const admin = adminsByEmail.get(email) as AdminUserRow;
    return {
      email: admin.email.toLowerCase(),
      name: admin.name,
      openAssignments: openCountsByEmail.get(admin.email.toLowerCase()) ?? 0,
    };
  });

  const conditions = [
    realContactCondition(),
    lineOaResolverRunCondition(input.runId),
    eq(schema.lineContactStudentLinks.status, "suggested"),
  ];
  if (input.linkIds && input.linkIds.length > 0) {
    conditions.push(inArray(schema.lineContactStudentLinks.id, [...new Set(input.linkIds)]));
  } else {
    conditions.push(isNull(schema.lineContactStudentLinks.validationAssignedToEmail));
  }

  const candidateRows = await db
    .select({
      link: schema.lineContactStudentLinks,
      contact: schema.lineContacts,
    })
    .from(schema.lineContactStudentLinks)
    .innerJoin(schema.lineContacts, eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id))
    .where(and(...conditions));
  const assignments = planRoundRobinValidationAssignments(
    candidateRows.map((row) => ({ id: row.link.id, sortKey: taskSortKey(row.link, row.contact) })),
    reviewers,
  );

  const assignedAt = now();
  for (const assignment of assignments) {
    await db
      .update(schema.lineContactStudentLinks)
      .set({
        validationAssignedToEmail: assignment.reviewerEmail,
        validationAssignedToName: assignment.reviewerName,
        validationAssignedRunId: input.runId,
        validationAssignedAt: assignedAt,
        updatedAt: now(),
      })
      .where(eq(schema.lineContactStudentLinks.id, assignment.linkId));
  }

  return {
    assigned: assignments.length,
    ...(await listLineLinkValidationTasks(db, {
      scope: "all",
      runId: input.runId,
      actor: {},
    })),
  };
}

export async function patchLineLinkValidationTaskStatus(
  db: Database,
  input: {
    linkId: string;
    status: Extract<LineContactStudentLinkStatus, "verified" | "rejected">;
    note?: string | null;
    actor: LineLinkValidationActor;
  },
): Promise<LineLinkValidationTaskDto | null> {
  const actor = actorFromInput(input.actor);
  const [row] = await db
    .update(schema.lineContactStudentLinks)
    .set({
      status: input.status,
      reviewedByEmail: actor.email,
      reviewedByName: actor.name,
      reviewedAt: now(),
      validationNote: input.note?.trim() || null,
      updatedAt: now(),
    })
    .where(and(
      eq(schema.lineContactStudentLinks.id, input.linkId),
      eq(schema.lineContactStudentLinks.isPhantom, false),
    ))
    .returning();
  if (!row) return null;

  const [contact] = await db
    .select()
    .from(schema.lineContacts)
    .where(eq(schema.lineContacts.id, row.contactId))
    .limit(1);
  if (!contact) return null;

  // IDENT-06: inline re-link recompute — when a link is verified, immediately
  // recompute pending_review scheduler rows for this contact so matchedStudentKeys
  // and writebackStatus reflect the newly-verified identity without a manual recompute.
  // Per-row errors are caught and do not abort the status patch (fail-isolated).
  if (input.status === "verified") {
    const pendingReviews = await db
      .select({
        id: schema.lineSchedulerReviews.id,
        inboundMessageId: schema.lineSchedulerReviews.inboundMessageId,
        classifierCategory: schema.lineSchedulerReviews.classifierCategory,
      })
      .from(schema.lineSchedulerReviews)
      .where(and(
        eq(schema.lineSchedulerReviews.contactId, row.contactId),
        eq(schema.lineSchedulerReviews.status, "pending_review"),
      ));

    for (const review of pendingReviews) {
      const messageRow = await db
        .select({ text: schema.lineMessages.text })
        .from(schema.lineMessages)
        .where(eq(schema.lineMessages.id, review.inboundMessageId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!messageRow?.text) continue;

      const plan = await buildLineOperationalReviewPlan({
        db,
        contactId: row.contactId,
        messageText: messageRow.text,
        classifierCategory: review.classifierCategory ?? "scheduling_change",
      }).catch(() => null);

      if (!plan) continue;

      await patchLineSchedulerOperationalPlan(db, review.id, {
        intentType: plan.intentType,
        intentPayload: plan.intentPayload as unknown as Record<string, unknown>,
        proposedDraft: plan.proposedDraft,
        matchedStudentKeys: plan.matchedStudentKeys,
        candidateSessions: plan.candidateSessions as unknown as Record<string, unknown>[],
        proposedWiseActions: plan.proposedWiseActions as unknown as Record<string, unknown>[],
        adminSelectedSessionIds: [],
        writebackStatus: plan.writebackStatus,
      }).catch(() => undefined);
    }
  }

  const studentsByKey = new Map(
    (await listCurrentLineStudentsByKeys(db, [row.studentKey])).map((student) => [student.studentKey, student]),
  );
  return linkTaskToDto(row, contact, studentsByKey.get(row.studentKey) ?? null);
}
