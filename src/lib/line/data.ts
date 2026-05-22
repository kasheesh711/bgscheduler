import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { LineProfile } from "@/lib/line/client";
import type { LineSchedulerClassification } from "@/lib/line/classifier";

export type LineSchedulerReviewStatus =
  | "pending_review"
  | "approved_sent"
  | "accepted_no_send"
  | "rejected"
  | "dismissed";

export interface LineReviewActor {
  email?: string | null;
  name?: string | null;
}

export interface LineWebhookIngestResult {
  createdMessageIds: string[];
  duplicateEvents: number;
  ignoredEvents: number;
  retractedMessages: number;
}

export interface LineMessageForProcessing {
  id: string;
  threadId: string;
  contactId: string;
  lineUserId: string;
  contactDisplayName: string | null;
  text: string;
  createdAt: string;
  aiSchedulerConversationId: string | null;
}

export interface LineSchedulerReviewDto {
  id: string;
  threadId: string;
  contactId: string;
  lineUserId: string;
  contactDisplayName: string | null;
  inboundMessageId: string;
  conversationId: string | null;
  schedulerMessageId: string | null;
  schedulerRunId: string | null;
  classifierCategory: string;
  classifierConfidence: number | null;
  classifierSummary: string | null;
  status: LineSchedulerReviewStatus;
  proposedDraft: string;
  selectedSuggestion: Record<string, unknown> | null;
  finalText: string | null;
  rejectionReason: string | null;
  staffCorrection: string | null;
  sendLineMessageId: string | null;
  sendResponse: Record<string, unknown> | null;
  sendError: string | null;
  reviewedByEmail: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LineSchedulerAnalytics {
  classifiedMessages: number;
  schedulingMessages: number;
  nonSchedulingMessages: number;
  unclearMessages: number;
  pendingReviews: number;
  approvedSent: number;
  acceptedNoSend: number;
  rejected: number;
  dismissed: number;
  rejectionRate: number;
  averageEditDistance: number | null;
  averageModelLatencyMs: number | null;
  commonRejectionReasons: Array<{ reason: string; count: number }>;
  commonRejectionCategories: Array<{ category: string; count: number }>;
  feedbackLabels: Array<{ label: "accepted" | "edited" | "rejected" | "dismissed"; count: number }>;
}

type ContactRow = typeof schema.lineContacts.$inferSelect;
type ThreadRow = typeof schema.lineThreads.$inferSelect;
type MessageRow = typeof schema.lineMessages.$inferSelect;
type ReviewRow = typeof schema.lineSchedulerReviews.$inferSelect;

function now(): Date {
  return new Date();
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : null;
}

function normalizeActor(actor: LineReviewActor): { email: string | null; name: string | null } {
  return {
    email: actor.email?.trim().toLowerCase() || null,
    name: actor.name?.trim() || null,
  };
}

function reviewToDto(row: ReviewRow & {
  lineUserId: string;
  contactDisplayName: string | null;
}): LineSchedulerReviewDto {
  return {
    id: row.id,
    threadId: row.threadId,
    contactId: row.contactId,
    lineUserId: row.lineUserId,
    contactDisplayName: row.contactDisplayName,
    inboundMessageId: row.inboundMessageId,
    conversationId: row.conversationId,
    schedulerMessageId: row.schedulerMessageId,
    schedulerRunId: row.schedulerRunId,
    classifierCategory: row.classifierCategory,
    classifierConfidence: row.classifierConfidence,
    classifierSummary: row.classifierSummary,
    status: row.status,
    proposedDraft: row.proposedDraft,
    selectedSuggestion: row.selectedSuggestion ?? null,
    finalText: row.finalText,
    rejectionReason: row.rejectionReason,
    staffCorrection: row.staffCorrection,
    sendLineMessageId: row.sendLineMessageId,
    sendResponse: row.sendResponse ?? null,
    sendError: row.sendError,
    reviewedByEmail: row.reviewedByEmail,
    reviewedByName: row.reviewedByName,
    reviewedAt: iso(row.reviewedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export async function upsertLineContact(
  db: Database,
  input: {
    lineUserId: string;
    profile?: LineProfile | null;
    seenAt?: Date | null;
  },
): Promise<ContactRow> {
  const seenAt = input.seenAt ?? now();
  const [row] = await db
    .insert(schema.lineContacts)
    .values({
      lineUserId: input.lineUserId,
      displayName: input.profile?.displayName ?? null,
      pictureUrl: input.profile?.pictureUrl ?? null,
      statusMessage: input.profile?.statusMessage ?? null,
      profileRaw: input.profile?.raw ?? {},
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    .onConflictDoUpdate({
      target: schema.lineContacts.lineUserId,
      set: {
        displayName: input.profile?.displayName ?? undefined,
        pictureUrl: input.profile?.pictureUrl ?? undefined,
        statusMessage: input.profile?.statusMessage ?? undefined,
        profileRaw: input.profile?.raw ?? undefined,
        lastSeenAt: seenAt,
        updatedAt: now(),
      },
    })
    .returning();
  return row;
}

export async function updateLineContactProfile(
  db: Database,
  lineUserId: string,
  profile: LineProfile | null,
): Promise<void> {
  if (!profile) return;
  await db
    .update(schema.lineContacts)
    .set({
      displayName: profile.displayName ?? null,
      pictureUrl: profile.pictureUrl ?? null,
      statusMessage: profile.statusMessage ?? null,
      profileRaw: profile.raw,
      updatedAt: now(),
    })
    .where(eq(schema.lineContacts.lineUserId, lineUserId));
}

export async function getOrCreateLineThread(
  db: Database,
  contact: Pick<ContactRow, "id" | "lineUserId">,
  seenAt = now(),
): Promise<ThreadRow> {
  const [row] = await db
    .insert(schema.lineThreads)
    .values({
      contactId: contact.id,
      lineUserId: contact.lineUserId,
      lastMessageAt: seenAt,
    })
    .onConflictDoUpdate({
      target: schema.lineThreads.lineUserId,
      set: {
        contactId: contact.id,
        lastMessageAt: seenAt,
        updatedAt: now(),
      },
    })
    .returning();
  return row;
}

export async function linkLineThreadConversation(
  db: Database,
  threadId: string,
  conversationId: string,
): Promise<void> {
  await db
    .update(schema.lineThreads)
    .set({
      aiSchedulerConversationId: conversationId,
      updatedAt: now(),
    })
    .where(eq(schema.lineThreads.id, threadId));
}

export async function recordLineWebhookPayload(
  db: Database,
  payload: unknown,
): Promise<LineWebhookIngestResult> {
  const events = Array.isArray(asRecord(payload).events) ? asRecord(payload).events as unknown[] : [];
  const result: LineWebhookIngestResult = {
    createdMessageIds: [],
    duplicateEvents: 0,
    ignoredEvents: 0,
    retractedMessages: 0,
  };

  for (const eventRaw of events) {
    const event = asRecord(eventRaw);
    const source = asRecord(event.source);
    const sourceType = asString(source.type);
    const lineUserId = asString(source.userId);
    if (sourceType !== "user" || !lineUserId) {
      result.ignoredEvents += 1;
      continue;
    }

    if (event.type === "unsend") {
      const unsend = asRecord(event.unsend);
      const messageId = asString(unsend.messageId);
      if (!messageId) {
        result.ignoredEvents += 1;
        continue;
      }
      const updated = await db
        .update(schema.lineMessages)
        .set({ isRetracted: true, retractedAt: now() })
        .where(eq(schema.lineMessages.lineMessageId, messageId))
        .returning({ id: schema.lineMessages.id });
      result.retractedMessages += updated.length;
      continue;
    }

    if (event.type !== "message") {
      result.ignoredEvents += 1;
      continue;
    }

    const message = asRecord(event.message);
    const messageType = asString(message.type) ?? "unknown";
    const text = messageType === "text" ? asString(message.text) : undefined;
    if (!text) {
      result.ignoredEvents += 1;
      continue;
    }

    const seenAt = eventDate(event.timestamp) ?? now();
    const contact = await upsertLineContact(db, { lineUserId, seenAt });
    const thread = await getOrCreateLineThread(db, contact, seenAt);
    const [created] = await db
      .insert(schema.lineMessages)
      .values({
        threadId: thread.id,
        contactId: contact.id,
        direction: "inbound",
        lineMessageId: asString(message.id) ?? null,
        webhookEventId: asString(event.webhookEventId) ?? null,
        sourceType,
        messageType,
        text,
        replyToken: asString(event.replyToken) ?? null,
        eventTimestamp: seenAt,
        isRedelivery: Boolean(event.deliveryContext && asRecord(event.deliveryContext).isRedelivery),
        raw: event,
      })
      .onConflictDoNothing({ target: schema.lineMessages.webhookEventId })
      .returning({ id: schema.lineMessages.id });

    if (created?.id) result.createdMessageIds.push(created.id);
    else result.duplicateEvents += 1;
  }

  return result;
}

export async function getLineMessageForProcessing(
  db: Database,
  messageId: string,
): Promise<LineMessageForProcessing | null> {
  const [row] = await db
    .select({
      id: schema.lineMessages.id,
      threadId: schema.lineMessages.threadId,
      contactId: schema.lineMessages.contactId,
      text: schema.lineMessages.text,
      createdAt: schema.lineMessages.createdAt,
      lineUserId: schema.lineContacts.lineUserId,
      contactDisplayName: schema.lineContacts.displayName,
      aiSchedulerConversationId: schema.lineThreads.aiSchedulerConversationId,
    })
    .from(schema.lineMessages)
    .innerJoin(schema.lineThreads, eq(schema.lineMessages.threadId, schema.lineThreads.id))
    .innerJoin(schema.lineContacts, eq(schema.lineMessages.contactId, schema.lineContacts.id))
    .where(eq(schema.lineMessages.id, messageId))
    .limit(1);

  if (!row?.text) return null;
  return {
    id: row.id,
    threadId: row.threadId,
    contactId: row.contactId,
    text: row.text,
    createdAt: iso(row.createdAt)!,
    lineUserId: row.lineUserId,
    contactDisplayName: row.contactDisplayName,
    aiSchedulerConversationId: row.aiSchedulerConversationId,
  };
}

export async function loadRecentLineMessages(
  db: Database,
  threadId: string,
  limit = 8,
): Promise<Array<{ direction: "inbound" | "outbound"; text: string; createdAt: string }>> {
  const rows = await db
    .select({
      direction: schema.lineMessages.direction,
      text: schema.lineMessages.text,
      createdAt: schema.lineMessages.createdAt,
    })
    .from(schema.lineMessages)
    .where(eq(schema.lineMessages.threadId, threadId))
    .orderBy(desc(schema.lineMessages.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .filter((row): row is typeof row & { text: string } => Boolean(row.text))
    .map((row) => ({
      direction: row.direction,
      text: row.text,
      createdAt: iso(row.createdAt)!,
    }));
}

export async function updateLineMessageClassification(
  db: Database,
  messageId: string,
  classification: LineSchedulerClassification,
): Promise<void> {
  await db
    .update(schema.lineMessages)
    .set({
      classifierCategory: classification.category,
      classifierConfidence: classification.confidence,
      classifierSummary: classification.summary,
      classifierPayload: {
        ...classification,
      },
      classifiedAt: now(),
    })
    .where(eq(schema.lineMessages.id, messageId));
}

export async function createLineSchedulerReview(
  db: Database,
  input: {
    threadId: string;
    contactId: string;
    inboundMessageId: string;
    conversationId?: string | null;
    schedulerMessageId?: string | null;
    schedulerRunId?: string | null;
    classification: LineSchedulerClassification;
    proposedDraft: string;
    selectedSuggestion?: Record<string, unknown> | null;
  },
): Promise<LineSchedulerReviewDto | null> {
  await db
    .insert(schema.lineSchedulerReviews)
    .values({
      threadId: input.threadId,
      contactId: input.contactId,
      inboundMessageId: input.inboundMessageId,
      conversationId: input.conversationId ?? null,
      schedulerMessageId: input.schedulerMessageId ?? null,
      schedulerRunId: input.schedulerRunId ?? null,
      classifierCategory: input.classification.category,
      classifierConfidence: input.classification.confidence,
      classifierSummary: input.classification.summary,
      classifierPayload: { ...input.classification },
      proposedDraft: input.proposedDraft,
      selectedSuggestion: input.selectedSuggestion ?? null,
    })
    .onConflictDoNothing({ target: schema.lineSchedulerReviews.inboundMessageId });

  return getLineSchedulerReviewByInboundMessage(db, input.inboundMessageId);
}

export async function getLineSchedulerReviewByInboundMessage(
  db: Database,
  inboundMessageId: string,
): Promise<LineSchedulerReviewDto | null> {
  const rows = await listLineSchedulerReviews(db, { inboundMessageId });
  return rows[0] ?? null;
}

export async function getLineSchedulerReview(
  db: Database,
  reviewId: string,
): Promise<LineSchedulerReviewDto | null> {
  const rows = await listLineSchedulerReviews(db, { reviewId });
  return rows[0] ?? null;
}

export async function listLineSchedulerReviews(
  db: Database,
  filters: {
    status?: LineSchedulerReviewStatus;
    conversationId?: string;
    inboundMessageId?: string;
    reviewId?: string;
  } = {},
): Promise<LineSchedulerReviewDto[]> {
  const conditions = [
    filters.status ? eq(schema.lineSchedulerReviews.status, filters.status) : undefined,
    filters.conversationId ? eq(schema.lineSchedulerReviews.conversationId, filters.conversationId) : undefined,
    filters.inboundMessageId ? eq(schema.lineSchedulerReviews.inboundMessageId, filters.inboundMessageId) : undefined,
    filters.reviewId ? eq(schema.lineSchedulerReviews.id, filters.reviewId) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));

  const rows = await db
    .select({
      id: schema.lineSchedulerReviews.id,
      threadId: schema.lineSchedulerReviews.threadId,
      contactId: schema.lineSchedulerReviews.contactId,
      inboundMessageId: schema.lineSchedulerReviews.inboundMessageId,
      conversationId: schema.lineSchedulerReviews.conversationId,
      schedulerMessageId: schema.lineSchedulerReviews.schedulerMessageId,
      schedulerRunId: schema.lineSchedulerReviews.schedulerRunId,
      classifierCategory: schema.lineSchedulerReviews.classifierCategory,
      classifierConfidence: schema.lineSchedulerReviews.classifierConfidence,
      classifierSummary: schema.lineSchedulerReviews.classifierSummary,
      classifierPayload: schema.lineSchedulerReviews.classifierPayload,
      status: schema.lineSchedulerReviews.status,
      proposedDraft: schema.lineSchedulerReviews.proposedDraft,
      selectedSuggestion: schema.lineSchedulerReviews.selectedSuggestion,
      finalText: schema.lineSchedulerReviews.finalText,
      rejectionReason: schema.lineSchedulerReviews.rejectionReason,
      staffCorrection: schema.lineSchedulerReviews.staffCorrection,
      sendLineMessageId: schema.lineSchedulerReviews.sendLineMessageId,
      sendResponse: schema.lineSchedulerReviews.sendResponse,
      sendError: schema.lineSchedulerReviews.sendError,
      reviewedByEmail: schema.lineSchedulerReviews.reviewedByEmail,
      reviewedByName: schema.lineSchedulerReviews.reviewedByName,
      reviewedAt: schema.lineSchedulerReviews.reviewedAt,
      createdAt: schema.lineSchedulerReviews.createdAt,
      updatedAt: schema.lineSchedulerReviews.updatedAt,
      lineUserId: schema.lineContacts.lineUserId,
      contactDisplayName: schema.lineContacts.displayName,
    })
    .from(schema.lineSchedulerReviews)
    .innerJoin(schema.lineContacts, eq(schema.lineSchedulerReviews.contactId, schema.lineContacts.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.lineSchedulerReviews.createdAt))
    .limit(200);

  return rows.map(reviewToDto);
}

export async function patchLineSchedulerReview(
  db: Database,
  reviewId: string,
  input: {
    status: LineSchedulerReviewStatus;
    finalText?: string | null;
    rejectionReason?: string | null;
    staffCorrection?: string | null;
    sendLineMessageId?: string | null;
    sendResponse?: Record<string, unknown> | null;
    sendError?: string | null;
    actor: LineReviewActor;
  },
): Promise<LineSchedulerReviewDto | null> {
  const actor = normalizeActor(input.actor);
  await db
    .update(schema.lineSchedulerReviews)
    .set({
      status: input.status,
      finalText: input.finalText ?? null,
      rejectionReason: input.rejectionReason ?? null,
      staffCorrection: input.staffCorrection ?? null,
      sendLineMessageId: input.sendLineMessageId ?? null,
      sendResponse: input.sendResponse ?? null,
      sendError: input.sendError ?? null,
      reviewedByEmail: actor.email,
      reviewedByName: actor.name,
      reviewedAt: now(),
      updatedAt: now(),
    })
    .where(eq(schema.lineSchedulerReviews.id, reviewId));

  return getLineSchedulerReview(db, reviewId);
}

export async function insertOutboundLineMessage(
  db: Database,
  input: {
    threadId: string;
    contactId: string;
    lineMessageId?: string | null;
    text: string;
    raw: Record<string, unknown>;
  },
): Promise<MessageRow> {
  const [row] = await db
    .insert(schema.lineMessages)
    .values({
      threadId: input.threadId,
      contactId: input.contactId,
      direction: "outbound",
      lineMessageId: input.lineMessageId ?? null,
      messageType: "text",
      text: input.text,
      eventTimestamp: now(),
      raw: input.raw,
    })
    .returning();
  return row;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function categorizeRejectionReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (/time|date|day|slot|เวลา|วัน/.test(normalized)) return "wrong_date_time";
  if (/subject|level|course|วิชา|ระดับ|y\d|grade/.test(normalized)) return "wrong_subject_level";
  if (/tutor|teacher|ครู/.test(normalized)) return "unsafe_or_wrong_tutor";
  if (/draft|word|message|unclear|tone|ข้อความ|ไม่ชัด/.test(normalized)) return "unclear_draft";
  if (/option|available|no useful|ไม่มี|ไม่เริ่ด/.test(normalized)) return "no_useful_options";
  return "other";
}

function feedbackLabelForReview(review: LineSchedulerReviewDto): "accepted" | "edited" | "rejected" | "dismissed" | null {
  if (review.status === "dismissed") return "dismissed";
  if (review.status === "rejected") return "rejected";
  if (review.status !== "approved_sent" && review.status !== "accepted_no_send") return null;
  const final = review.finalText?.trim();
  if (!final || final === review.proposedDraft.trim()) return "accepted";
  return "edited";
}

export async function getLineSchedulerAnalytics(db: Database): Promise<LineSchedulerAnalytics> {
  const [messages, reviews] = await Promise.all([
    db
      .select({
        classifierCategory: schema.lineMessages.classifierCategory,
      })
      .from(schema.lineMessages)
      .where(eq(schema.lineMessages.direction, "inbound")),
    listLineSchedulerReviews(db),
  ]);

  const runIds = reviews
    .map((review) => review.schedulerRunId)
    .filter((id): id is string => Boolean(id));
  const runs = runIds.length > 0
    ? await db
      .select({ latencyMs: schema.aiSchedulerRuns.latencyMs })
      .from(schema.aiSchedulerRuns)
      .where(inArray(schema.aiSchedulerRuns.id, runIds))
    : [];

  const classifiedMessages = messages.filter((message) => Boolean(message.classifierCategory)).length;
  const schedulingMessages = messages.filter((message) =>
    message.classifierCategory === "scheduling_request" || message.classifierCategory === "scheduling_change",
  ).length;
  const nonSchedulingMessages = messages.filter((message) => message.classifierCategory === "non_scheduling").length;
  const unclearMessages = messages.filter((message) => message.classifierCategory === "unclear").length;
  const pendingReviews = reviews.filter((review) => review.status === "pending_review").length;
  const approvedSent = reviews.filter((review) => review.status === "approved_sent").length;
  const acceptedNoSend = reviews.filter((review) => review.status === "accepted_no_send").length;
  const rejected = reviews.filter((review) => review.status === "rejected").length;
  const dismissed = reviews.filter((review) => review.status === "dismissed").length;
  const completed = approvedSent + acceptedNoSend + rejected + dismissed;

  const distances = reviews
    .map((review) => {
      const comparison = review.status === "rejected"
        ? review.staffCorrection
        : review.finalText;
      return comparison ? levenshtein(review.proposedDraft, comparison) : null;
    })
    .filter((value): value is number => value !== null);
  const latencies = runs
    .map((run) => run.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const rejectionCounts = new Map<string, number>();
  const rejectionCategoryCounts = new Map<string, number>();
  const feedbackLabelCounts = new Map<"accepted" | "edited" | "rejected" | "dismissed", number>();
  for (const review of reviews) {
    const label = feedbackLabelForReview(review);
    if (label) feedbackLabelCounts.set(label, (feedbackLabelCounts.get(label) ?? 0) + 1);
    if (review.status !== "rejected" || !review.rejectionReason) continue;
    const reason = review.rejectionReason.trim();
    if (!reason) continue;
    rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
    const category = categorizeRejectionReason(reason);
    rejectionCategoryCounts.set(category, (rejectionCategoryCounts.get(category) ?? 0) + 1);
  }

  return {
    classifiedMessages,
    schedulingMessages,
    nonSchedulingMessages,
    unclearMessages,
    pendingReviews,
    approvedSent,
    acceptedNoSend,
    rejected,
    dismissed,
    rejectionRate: completed > 0 ? rejected / completed : 0,
    averageEditDistance: distances.length > 0
      ? distances.reduce((sum, value) => sum + value, 0) / distances.length
      : null,
    averageModelLatencyMs: latencies.length > 0
      ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
      : null,
    commonRejectionReasons: [...rejectionCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    commonRejectionCategories: [...rejectionCategoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    feedbackLabels: [...feedbackLabelCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
