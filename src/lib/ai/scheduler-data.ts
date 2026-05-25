import { desc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { SchedulerExtractedState } from "@/lib/ai/scheduler-conversation";

export interface SchedulerActor {
  email?: string | null;
  name?: string | null;
}

export type SchedulerConversationStatus = "active" | "archived";
export type SchedulerMessageRole = "admin" | "parent" | "assistant" | "system";

export interface SchedulerConversationDto {
  id: string;
  title: string;
  status: SchedulerConversationStatus;
  customerParentName: string | null;
  customerStudentName: string | null;
  customerContact: string | null;
  notes: string;
  extractedState: SchedulerExtractedState;
  createdByEmail: string | null;
  createdByName: string | null;
  archivedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerMessageDto {
  id: string;
  conversationId: string;
  role: SchedulerMessageRole;
  content: string;
  structuredPayload: Record<string, unknown> | null;
  model: string | null;
  latencyMs: number | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface SchedulerLatencyBreakdown {
  totalMs: number;
  dbMs: number;
  modelMs: number;
  searchMs: number;
}

export type SchedulerFeedbackAction = "accept" | "edit" | "reject";

export interface SchedulerFeedbackDto {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  schedulerRunId: string | null;
  action: SchedulerFeedbackAction;
  selectedTutorIds: string[];
  rejectedTutorIds: string[];
  editedParentDraft: string | null;
  rejectionReason: string | null;
  staffCorrection: string | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
}

type ConversationRow = typeof schema.aiSchedulerConversations.$inferSelect;
type MessageRow = typeof schema.aiSchedulerMessages.$inferSelect;
type FeedbackRow = typeof schema.aiSchedulerFeedback.$inferSelect;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function conversationToDto(row: ConversationRow): SchedulerConversationDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    customerParentName: row.customerParentName,
    customerStudentName: row.customerStudentName,
    customerContact: row.customerContact,
    notes: row.notes,
    extractedState: (row.extractedState ?? {}) as SchedulerExtractedState,
    createdByEmail: row.createdByEmail,
    createdByName: row.createdByName,
    archivedAt: iso(row.archivedAt),
    lastMessageAt: iso(row.lastMessageAt)!,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function messageToDto(row: MessageRow): SchedulerMessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    structuredPayload: row.structuredPayload ?? null,
    model: row.model,
    latencyMs: row.latencyMs,
    createdByEmail: row.createdByEmail,
    createdByName: row.createdByName,
    createdAt: iso(row.createdAt)!,
  };
}

function feedbackToDto(row: FeedbackRow): SchedulerFeedbackDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    schedulerRunId: row.schedulerRunId,
    action: row.action as SchedulerFeedbackAction,
    selectedTutorIds: row.selectedTutorIds,
    rejectedTutorIds: row.rejectedTutorIds,
    editedParentDraft: row.editedParentDraft,
    rejectionReason: row.rejectionReason,
    staffCorrection: row.staffCorrection,
    createdByEmail: row.createdByEmail,
    createdByName: row.createdByName,
    createdAt: iso(row.createdAt)!,
  };
}

function now(): Date {
  return new Date();
}

function normalizeActor(actor: SchedulerActor): { email: string | null; name: string | null } {
  return {
    email: actor.email?.trim().toLowerCase() || null,
    name: actor.name?.trim() || null,
  };
}

export async function listSchedulerConversations(
  db: Database,
  input: {
    includeArchived?: boolean;
    mineOnly?: boolean;
    query?: string;
    actor?: SchedulerActor;
  } = {},
): Promise<SchedulerConversationDto[]> {
  const rows = input.includeArchived
    ? await db
      .select()
      .from(schema.aiSchedulerConversations)
      .orderBy(desc(schema.aiSchedulerConversations.lastMessageAt))
      .limit(200)
    : await db
      .select()
      .from(schema.aiSchedulerConversations)
      .where(eq(schema.aiSchedulerConversations.status, "active"))
      .orderBy(desc(schema.aiSchedulerConversations.lastMessageAt))
      .limit(200);

  const actorEmail = normalizeActor(input.actor ?? {}).email;
  const query = input.query?.trim().toLowerCase();

  return rows
    .filter((row) => !input.mineOnly || !actorEmail || row.createdByEmail === actorEmail)
    .filter((row) => {
      if (!query) return true;
      return [
        row.title,
        row.customerParentName,
        row.customerStudentName,
        row.customerContact,
        row.notes,
      ].some((value) => value?.toLowerCase().includes(query));
    })
    .map(conversationToDto);
}

export async function createSchedulerConversation(
  db: Database,
  actor: SchedulerActor,
  input: Partial<Pick<
    SchedulerConversationDto,
    "title" | "customerParentName" | "customerStudentName" | "customerContact" | "notes"
  >> = {},
): Promise<SchedulerConversationDto> {
  const normalizedActor = normalizeActor(actor);
  const [row] = await db
    .insert(schema.aiSchedulerConversations)
    .values({
      title: input.title?.trim() || "Untitled scheduler chat",
      customerParentName: input.customerParentName?.trim() || null,
      customerStudentName: input.customerStudentName?.trim() || null,
      customerContact: input.customerContact?.trim() || null,
      notes: input.notes ?? "",
      createdByEmail: normalizedActor.email,
      createdByName: normalizedActor.name,
    })
    .returning();

  return conversationToDto(row);
}

export async function getSchedulerConversation(
  db: Database,
  conversationId: string,
): Promise<SchedulerConversationDto | null> {
  const [row] = await db
    .select()
    .from(schema.aiSchedulerConversations)
    .where(eq(schema.aiSchedulerConversations.id, conversationId))
    .limit(1);
  return row ? conversationToDto(row) : null;
}

export async function getSchedulerConversationWithMessages(
  db: Database,
  conversationId: string,
): Promise<{ conversation: SchedulerConversationDto; messages: SchedulerMessageDto[] } | null> {
  const conversation = await getSchedulerConversation(db, conversationId);
  if (!conversation) return null;

  const messages = await db
    .select()
    .from(schema.aiSchedulerMessages)
    .where(eq(schema.aiSchedulerMessages.conversationId, conversationId))
    .orderBy(schema.aiSchedulerMessages.createdAt);

  return {
    conversation,
    messages: messages.map(messageToDto),
  };
}

export async function patchSchedulerConversation(
  db: Database,
  conversationId: string,
  input: Partial<{
    title: string;
    customerParentName: string | null;
    customerStudentName: string | null;
    customerContact: string | null;
    notes: string;
    extractedState: SchedulerExtractedState;
    status: SchedulerConversationStatus;
  }>,
): Promise<SchedulerConversationDto | null> {
  const values: Partial<typeof schema.aiSchedulerConversations.$inferInsert> = {
    updatedAt: now(),
  };

  if (input.title !== undefined) values.title = input.title.trim() || "Untitled scheduler chat";
  if (input.customerParentName !== undefined) values.customerParentName = input.customerParentName?.trim() || null;
  if (input.customerStudentName !== undefined) values.customerStudentName = input.customerStudentName?.trim() || null;
  if (input.customerContact !== undefined) values.customerContact = input.customerContact?.trim() || null;
  if (input.notes !== undefined) values.notes = input.notes;
  if (input.extractedState !== undefined) values.extractedState = input.extractedState as Record<string, unknown>;
  if (input.status !== undefined) {
    values.status = input.status;
    values.archivedAt = input.status === "archived" ? now() : null;
  }

  const [row] = await db
    .update(schema.aiSchedulerConversations)
    .set(values)
    .where(eq(schema.aiSchedulerConversations.id, conversationId))
    .returning();
  return row ? conversationToDto(row) : null;
}

export async function touchSchedulerConversationAfterMessage(
  db: Database,
  conversationId: string,
  input: {
    extractedState?: SchedulerExtractedState;
    title?: string;
    customerParentName?: string;
    customerStudentName?: string;
    customerContact?: string;
  } = {},
): Promise<SchedulerConversationDto | null> {
  const values: Partial<typeof schema.aiSchedulerConversations.$inferInsert> = {
    lastMessageAt: now(),
    updatedAt: now(),
  };
  if (input.extractedState) values.extractedState = input.extractedState as Record<string, unknown>;
  if (input.title) values.title = input.title;
  if (input.customerParentName) values.customerParentName = input.customerParentName;
  if (input.customerStudentName) values.customerStudentName = input.customerStudentName;
  if (input.customerContact) values.customerContact = input.customerContact;

  const [row] = await db
    .update(schema.aiSchedulerConversations)
    .set(values)
    .where(eq(schema.aiSchedulerConversations.id, conversationId))
    .returning();
  return row ? conversationToDto(row) : null;
}

export async function createSchedulerMessage(
  db: Database,
  input: {
    conversationId: string;
    role: SchedulerMessageRole;
    content: string;
    structuredPayload?: Record<string, unknown> | null;
    model?: string | null;
    latencyMs?: number | null;
    actor?: SchedulerActor;
  },
): Promise<SchedulerMessageDto> {
  const actor = normalizeActor(input.actor ?? {});
  const [row] = await db
    .insert(schema.aiSchedulerMessages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      structuredPayload: input.structuredPayload ?? null,
      model: input.model ?? null,
      latencyMs: input.latencyMs ?? null,
      createdByEmail: actor.email,
      createdByName: actor.name,
    })
    .returning();
  return messageToDto(row);
}

export async function logSchedulerRun(
  db: Database,
  input: {
    conversationId?: string | null;
    messageId?: string | null;
    createdByEmail?: string | null;
    status: "solved" | "needs_clarification" | "failed";
    inputPreviewRedacted: string;
    model?: string | null;
    latencyMs?: number | null;
    schedulerVersion?: string | null;
    promptVersion?: string | null;
    latencyBreakdownMs?: SchedulerLatencyBreakdown | null;
    parsedPayload?: Record<string, unknown> | null;
    solverPayload?: Record<string, unknown> | null;
    warnings?: string[];
    errorMessage?: string | null;
  },
): Promise<string> {
  try {
    const [row] = await db
      .insert(schema.aiSchedulerRuns)
      .values({
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        createdByEmail: input.createdByEmail ?? null,
        status: input.status,
        inputPreviewRedacted: input.inputPreviewRedacted,
        model: input.model ?? null,
        latencyMs: input.latencyMs ?? null,
        schedulerVersion: input.schedulerVersion ?? null,
        promptVersion: input.promptVersion ?? null,
        latencyBreakdown: input.latencyBreakdownMs ? { ...input.latencyBreakdownMs } : null,
        parsedPayload: input.parsedPayload ?? null,
        solverPayload: input.solverPayload ?? null,
        warnings: input.warnings ?? [],
        errorMessage: input.errorMessage ?? null,
      })
      .returning({ id: schema.aiSchedulerRuns.id });
    return row?.id ?? "unlogged";
  } catch (error) {
    console.error("Failed to write AI scheduler run", error);
    return "unlogged";
  }
}

export async function createSchedulerFeedback(
  db: Database,
  input: {
    conversationId?: string | null;
    messageId?: string | null;
    schedulerRunId?: string | null;
    action: SchedulerFeedbackAction;
    selectedTutorIds?: string[];
    rejectedTutorIds?: string[];
    editedParentDraft?: string | null;
    rejectionReason?: string | null;
    staffCorrection?: string | null;
    actor?: SchedulerActor;
  },
): Promise<SchedulerFeedbackDto> {
  const actor = normalizeActor(input.actor ?? {});
  const [row] = await db
    .insert(schema.aiSchedulerFeedback)
    .values({
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      schedulerRunId: input.schedulerRunId ?? null,
      action: input.action,
      selectedTutorIds: input.selectedTutorIds ?? [],
      rejectedTutorIds: input.rejectedTutorIds ?? [],
      editedParentDraft: input.editedParentDraft?.trim() || null,
      rejectionReason: input.rejectionReason?.trim() || null,
      staffCorrection: input.staffCorrection?.trim() || null,
      createdByEmail: actor.email,
      createdByName: actor.name,
    })
    .returning();
  return feedbackToDto(row);
}
