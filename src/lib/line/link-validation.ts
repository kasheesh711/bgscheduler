import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listCurrentLineStudents, type LineContactStudentLinkStatus } from "./student-links";

type LinkRow = typeof schema.lineContactStudentLinks.$inferSelect;
type ContactRow = typeof schema.lineContacts.$inferSelect;
type AdminUserRow = typeof schema.adminUsers.$inferSelect;

export type LineLinkValidationScope = "my" | "all" | "unassigned" | "verified" | "rejected";

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

function lineOaResolverSourceCondition() {
  return sql`${schema.lineContactStudentLinks.evidence}->>'source' = 'line_oa_resolver'`;
}

function lineOaResolverRunCondition(runId: string) {
  return sql`${schema.lineContactStudentLinks.evidence}->>'runId' = ${runId}`;
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
    sourceRunId: asString(evidence.runId),
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
      })
      .from(schema.lineContactStudentLinks)
      .where(and(
        lineOaResolverSourceCondition(),
        eq(schema.lineContactStudentLinks.status, "suggested"),
        ...(runId ? [lineOaResolverRunCondition(runId)] : []),
      )),
  ]);

  const counts = new Map<string, number>();
  for (const row of assignmentRows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
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
  },
): Promise<{
  tasks: LineLinkValidationTaskDto[];
  reviewers: LineLinkValidationReviewerDto[];
}> {
  const actor = actorFromInput(input.actor);
  const conditions = [lineOaResolverSourceCondition()];
  if (input.runId) conditions.push(lineOaResolverRunCondition(input.runId));

  if (input.scope === "my") {
    if (!actor.email) return { tasks: [], reviewers: await listLineLinkValidationReviewers(db, input.runId) };
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

  const rows = await db
    .select({
      link: schema.lineContactStudentLinks,
      contact: schema.lineContacts,
    })
    .from(schema.lineContactStudentLinks)
    .innerJoin(schema.lineContacts, eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id))
    .where(and(...conditions))
    .orderBy(
      asc(schema.lineContactStudentLinks.parentName),
      asc(schema.lineContactStudentLinks.studentName),
      asc(schema.lineContactStudentLinks.studentKey),
      asc(schema.lineContacts.displayName),
    );

  const studentsByKey = new Map((await listCurrentLineStudents(db)).map((student) => [student.studentKey, student]));
  const reviewers = await listLineLinkValidationReviewers(db, input.runId);
  return {
    tasks: rows.map((row) => linkTaskToDto(
      row.link,
      row.contact,
      studentsByKey.get(row.link.studentKey) ?? null,
    )),
    reviewers,
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

  const conditions = [lineOaResolverSourceCondition()];
  if (input.runId) conditions.push(lineOaResolverRunCondition(input.runId));

  const [rows, adminRows, currentStudents] = await Promise.all([
    db
      .select({
        link: schema.lineContactStudentLinks,
        contact: schema.lineContacts,
      })
      .from(schema.lineContactStudentLinks)
      .innerJoin(schema.lineContacts, eq(schema.lineContactStudentLinks.contactId, schema.lineContacts.id))
      .where(and(...conditions)),
    db
      .select()
      .from(schema.adminUsers)
      .orderBy(asc(schema.adminUsers.email)),
    listCurrentLineStudents(db),
  ]);

  const studentsByKey = new Map(currentStudents.map((student) => [student.studentKey, student]));
  const tasks = rows.map((row) => linkTaskToDto(
    row.link,
    row.contact,
    studentsByKey.get(row.link.studentKey) ?? null,
  ));

  const totals = {
    assigned: 0,
    unassigned: 0,
    verified: 0,
    rejected: 0,
    remaining: 0,
    total: 0,
    completionRate: 0,
  };

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

  for (const task of tasks) {
    if (task.status === "suggested") {
      if (task.validationAssignedToEmail) {
        totals.assigned += 1;
        const reviewer = ensureReviewer(task.validationAssignedToEmail, task.validationAssignedToName);
        reviewer.assigned += 1;
        reviewer.remaining += 1;
      } else {
        totals.unassigned += 1;
      }
      continue;
    }

    if (task.status === "verified") {
      totals.verified += 1;
      const email = task.reviewedByEmail || task.validationAssignedToEmail;
      if (email) {
        ensureReviewer(email, task.reviewedByName || task.validationAssignedToName).verified += 1;
      }
    } else if (task.status === "rejected") {
      totals.rejected += 1;
      const email = task.reviewedByEmail || task.validationAssignedToEmail;
      if (email) {
        ensureReviewer(email, task.reviewedByName || task.validationAssignedToName).rejected += 1;
      }
    }
  }

  totals.remaining = totals.assigned + totals.unassigned;
  totals.total = totals.remaining + totals.verified + totals.rejected;
  totals.completionRate = percent(totals.verified + totals.rejected, totals.total);

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

  const recentActivity = tasks
    .filter((task) => task.status === "verified" || task.status === "rejected")
    .sort((a, b) => (
      new Date(b.reviewedAt ?? b.updatedAt).getTime()
      - new Date(a.reviewedAt ?? a.updatedAt).getTime()
    ))
    .slice(0, 10);

  return {
    canViewTracker: true,
    runId: input.runId ?? null,
    totals,
    reviewers,
    recentActivity,
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
    lineOaResolverSourceCondition(),
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
      lineOaResolverSourceCondition(),
    ))
    .returning();
  if (!row) return null;

  const [contact] = await db
    .select()
    .from(schema.lineContacts)
    .where(eq(schema.lineContacts.id, row.contactId))
    .limit(1);
  if (!contact) return null;

  const studentsByKey = new Map((await listCurrentLineStudents(db)).map((student) => [student.studentKey, student]));
  return linkTaskToDto(row, contact, studentsByKey.get(row.studentKey) ?? null);
}
