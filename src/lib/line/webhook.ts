import type { Database } from "@/lib/db";
import { recordLineWebhookPayload, type LineGroupCommand } from "@/lib/line/data";
import { verifyLineSignature } from "@/lib/line/signature";

export interface LineWebhookHandlerResult {
  status: number;
  body: {
    ok: boolean;
    error?: string;
    createdMessageIds?: string[];
    duplicateEvents?: number;
    ignoredEvents?: number;
    retractedMessages?: number;
    groupCommands?: number;
  };
}

export async function handleLineWebhookPost(input: {
  db: Database;
  rawBody: string;
  signature: string | null;
  channelSecret: string | undefined;
  scheduleProcessing: (lineMessageId: string) => void;
  /** Optional so existing callers and tests keep working unchanged. */
  scheduleGroupCommand?: (command: LineGroupCommand) => void;
}): Promise<LineWebhookHandlerResult> {
  if (!verifyLineSignature({
    rawBody: input.rawBody,
    channelSecret: input.channelSecret,
    signature: input.signature,
  })) {
    return {
      status: 401,
      body: { ok: false, error: "Invalid LINE signature" },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return {
      status: 400,
      body: { ok: false, error: "Invalid JSON" },
    };
  }

  const ingest = await recordLineWebhookPayload(input.db, payload);
  for (const messageId of ingest.createdMessageIds) {
    input.scheduleProcessing(messageId);
  }
  for (const command of ingest.groupCommands) {
    input.scheduleGroupCommand?.(command);
  }

  return {
    status: 200,
    body: {
      ok: true,
      createdMessageIds: ingest.createdMessageIds,
      duplicateEvents: ingest.duplicateEvents,
      ignoredEvents: ingest.ignoredEvents,
      retractedMessages: ingest.retractedMessages,
      groupCommands: ingest.groupCommands.length,
    },
  };
}
