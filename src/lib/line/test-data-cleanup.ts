import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export const LINE_TEST_DATA_DELETE_CONFIRMATION = "delete-line-test-data";

export interface LineCleanupSourceRows {
  contacts: Array<{ id: string }>;
  threads: Array<{ id: string; contactId: string; aiSchedulerConversationId: string | null }>;
  messages: Array<{ id: string; threadId: string; contactId: string }>;
  reviews: Array<{
    id: string;
    threadId: string;
    contactId: string;
    inboundMessageId: string;
    conversationId: string | null;
    schedulerMessageId: string | null;
    schedulerRunId: string | null;
  }>;
  schedulerMessages: Array<{ id: string }>;
  schedulerRuns: Array<{ id: string; messageId: string | null }>;
}

export interface LineTestDataCleanupTargets {
  contactIds: string[];
  threadIds: string[];
  lineMessageIds: string[];
  reviewIds: string[];
  conversationIds: string[];
  schedulerMessageIds: string[];
  schedulerRunIds: string[];
}

export interface LineTestDataCleanupCounts {
  lineContacts: number;
  lineThreads: number;
  lineMessages: number;
  lineSchedulerReviews: number;
  lineContactStudentLinks: number;
  lineLinkedActiveConversations: number;
}

export interface LineTestDataCleanupPlan {
  targets: LineTestDataCleanupTargets;
  before: LineTestDataCleanupCounts;
}

export interface LineTestDataCleanupResult extends LineTestDataCleanupPlan {
  dryRun: boolean;
  deleted: Record<string, number>;
  after: LineTestDataCleanupCounts;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

export function buildLineTestDataCleanupTargets(rows: LineCleanupSourceRows): LineTestDataCleanupTargets {
  const schedulerMessageIds = unique([
    ...rows.reviews.map((review) => review.schedulerMessageId),
    ...rows.schedulerMessages.map((message) => message.id),
    ...rows.schedulerRuns.map((run) => run.messageId),
  ]);

  return {
    contactIds: unique([
      ...rows.contacts.map((contact) => contact.id),
      ...rows.threads.map((thread) => thread.contactId),
      ...rows.messages.map((message) => message.contactId),
      ...rows.reviews.map((review) => review.contactId),
    ]),
    threadIds: unique([
      ...rows.threads.map((thread) => thread.id),
      ...rows.messages.map((message) => message.threadId),
      ...rows.reviews.map((review) => review.threadId),
    ]),
    lineMessageIds: unique([
      ...rows.messages.map((message) => message.id),
      ...rows.reviews.map((review) => review.inboundMessageId),
    ]),
    reviewIds: unique(rows.reviews.map((review) => review.id)),
    conversationIds: unique([
      ...rows.threads.map((thread) => thread.aiSchedulerConversationId),
      ...rows.reviews.map((review) => review.conversationId),
    ]),
    schedulerMessageIds,
    schedulerRunIds: unique([
      ...rows.reviews.map((review) => review.schedulerRunId),
      ...rows.schedulerRuns.map((run) => run.id),
    ]),
  };
}

async function loadCounts(db: Database, conversationIds: string[] = []): Promise<LineTestDataCleanupCounts> {
  const [
    contacts,
    threads,
    messages,
    reviews,
    links,
    lineLinkedActiveConversations,
  ] = await Promise.all([
    db.select({ id: schema.lineContacts.id }).from(schema.lineContacts),
    db.select({ id: schema.lineThreads.id }).from(schema.lineThreads),
    db.select({ id: schema.lineMessages.id }).from(schema.lineMessages),
    db.select({ id: schema.lineSchedulerReviews.id }).from(schema.lineSchedulerReviews),
    db.select({ id: schema.lineContactStudentLinks.id }).from(schema.lineContactStudentLinks),
    conversationIds.length > 0
      ? db
        .select({ id: schema.aiSchedulerConversations.id })
        .from(schema.aiSchedulerConversations)
        .where(and(
          inArray(schema.aiSchedulerConversations.id, conversationIds),
          eq(schema.aiSchedulerConversations.status, "active"),
        ))
      : Promise.resolve([]),
  ]);

  return {
    lineContacts: contacts.length,
    lineThreads: threads.length,
    lineMessages: messages.length,
    lineSchedulerReviews: reviews.length,
    lineContactStudentLinks: links.length,
    lineLinkedActiveConversations: lineLinkedActiveConversations.length,
  };
}

export async function buildLineTestDataCleanupPlan(db: Database): Promise<LineTestDataCleanupPlan> {
  const [contacts, threads, messages, reviews] = await Promise.all([
    db.select({ id: schema.lineContacts.id }).from(schema.lineContacts),
    db
      .select({
        id: schema.lineThreads.id,
        contactId: schema.lineThreads.contactId,
        aiSchedulerConversationId: schema.lineThreads.aiSchedulerConversationId,
      })
      .from(schema.lineThreads),
    db
      .select({
        id: schema.lineMessages.id,
        threadId: schema.lineMessages.threadId,
        contactId: schema.lineMessages.contactId,
      })
      .from(schema.lineMessages),
    db
      .select({
        id: schema.lineSchedulerReviews.id,
        threadId: schema.lineSchedulerReviews.threadId,
        contactId: schema.lineSchedulerReviews.contactId,
        inboundMessageId: schema.lineSchedulerReviews.inboundMessageId,
        conversationId: schema.lineSchedulerReviews.conversationId,
        schedulerMessageId: schema.lineSchedulerReviews.schedulerMessageId,
        schedulerRunId: schema.lineSchedulerReviews.schedulerRunId,
      })
      .from(schema.lineSchedulerReviews),
  ]);

  const initialTargets = buildLineTestDataCleanupTargets({
    contacts,
    threads,
    messages,
    reviews,
    schedulerMessages: [],
    schedulerRuns: [],
  });

  const [schedulerMessages, schedulerRuns] = await Promise.all([
    initialTargets.conversationIds.length > 0
      ? db
        .select({ id: schema.aiSchedulerMessages.id })
        .from(schema.aiSchedulerMessages)
        .where(inArray(schema.aiSchedulerMessages.conversationId, initialTargets.conversationIds))
      : Promise.resolve([]),
    initialTargets.conversationIds.length > 0
      ? db
        .select({ id: schema.aiSchedulerRuns.id, messageId: schema.aiSchedulerRuns.messageId })
        .from(schema.aiSchedulerRuns)
        .where(inArray(schema.aiSchedulerRuns.conversationId, initialTargets.conversationIds))
      : Promise.resolve([]),
  ]);

  const targets = buildLineTestDataCleanupTargets({
    contacts,
    threads,
    messages,
    reviews,
    schedulerMessages,
    schedulerRuns,
  });

  return {
    targets,
    before: await loadCounts(db, targets.conversationIds),
  };
}

async function deleteWhereIn(
  label: string,
  ids: string[],
  execute: (ids: string[]) => Promise<Array<{ id: string }>>,
  deleted: Record<string, number>,
) {
  if (ids.length === 0) {
    deleted[label] = 0;
    return;
  }
  deleted[label] = (await execute(ids)).length;
}

export async function deleteLineTestData(
  db: Database,
  options: { confirm?: string; dryRun?: boolean } = {},
): Promise<LineTestDataCleanupResult> {
  const plan = await buildLineTestDataCleanupPlan(db);
  if (options.dryRun) {
    return {
      ...plan,
      dryRun: true,
      deleted: {},
      after: plan.before,
    };
  }

  if (options.confirm !== LINE_TEST_DATA_DELETE_CONFIRMATION) {
    throw new Error(`Refusing to delete LINE test data without CONFIRM_DELETE_LINE_TEST_DATA=${LINE_TEST_DATA_DELETE_CONFIRMATION}`);
  }

  const deleted: Record<string, number> = {};
  const { targets } = plan;

  await deleteWhereIn("aiSchedulerFeedbackBySchedulerRun", targets.schedulerRunIds, (ids) => db
    .delete(schema.aiSchedulerFeedback)
    .where(inArray(schema.aiSchedulerFeedback.schedulerRunId, ids))
    .returning({ id: schema.aiSchedulerFeedback.id }), deleted);
  await deleteWhereIn("aiSchedulerFeedbackByMessage", targets.schedulerMessageIds, (ids) => db
    .delete(schema.aiSchedulerFeedback)
    .where(inArray(schema.aiSchedulerFeedback.messageId, ids))
    .returning({ id: schema.aiSchedulerFeedback.id }), deleted);
  await deleteWhereIn("aiSchedulerFeedbackByConversation", targets.conversationIds, (ids) => db
    .delete(schema.aiSchedulerFeedback)
    .where(inArray(schema.aiSchedulerFeedback.conversationId, ids))
    .returning({ id: schema.aiSchedulerFeedback.id }), deleted);
  await deleteWhereIn("aiSchedulerRunsById", targets.schedulerRunIds, (ids) => db
    .delete(schema.aiSchedulerRuns)
    .where(inArray(schema.aiSchedulerRuns.id, ids))
    .returning({ id: schema.aiSchedulerRuns.id }), deleted);
  await deleteWhereIn("aiSchedulerRunsByConversation", targets.conversationIds, (ids) => db
    .delete(schema.aiSchedulerRuns)
    .where(inArray(schema.aiSchedulerRuns.conversationId, ids))
    .returning({ id: schema.aiSchedulerRuns.id }), deleted);
  await deleteWhereIn("lineContacts", targets.contactIds, (ids) => db
    .delete(schema.lineContacts)
    .where(inArray(schema.lineContacts.id, ids))
    .returning({ id: schema.lineContacts.id }), deleted);
  await deleteWhereIn("aiSchedulerConversations", targets.conversationIds, (ids) => db
    .delete(schema.aiSchedulerConversations)
    .where(inArray(schema.aiSchedulerConversations.id, ids))
    .returning({ id: schema.aiSchedulerConversations.id }), deleted);

  return {
    ...plan,
    dryRun: false,
    deleted,
    after: await loadCounts(db, targets.conversationIds),
  };
}
