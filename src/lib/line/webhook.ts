import { splitRoomEvents, ingestRoomEvents } from "@/lib/room-booking/ingress";
import type { Database } from "@/lib/db";
import { recordLineWebhookPayload, type LineGroupCommand } from "@/lib/line/data";
import { replyLineMessage } from "@/lib/line/client";
import { verifyLineSignature } from "@/lib/line/signature";

const FORM_REPLIES = new Map([
  ["/leave", "Leave form\n- for taking leave (please inform 7 days in advance)\nhttps://docs.google.com/forms/d/e/1FAIpQLSd-tzTC1XrOq4MtvVjlueOrbZ-6vLJgKambL812dfItiGTJPw/formResponse"],
  ["/request", "- Request form (Changing availability and other issues)\nhttps://docs.google.com/forms/d/e/1FAIpQLSe8GzpXwjc-PPldy_nIat2kTQA8XQw6cGnKGALxn_vWEV_NAA/viewform"],
]);

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
  progressOnly?: boolean;
  handleWeekendCommand?: (event: unknown) => Promise<boolean>;
  scheduleProcessing: (lineMessageId: string) => void;
  /** Optional so existing callers and tests keep working unchanged. */
  scheduleGroupCommand?: (command: LineGroupCommand) => void;
  scheduleRoomCommand?: (eventId: string) => void;
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

  // Public form links need no staff lookup and must not enter AI processing.
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const otherEvents: unknown[] = [];
  for (const raw of Array.isArray(root.events) ? root.events : []) {
    if (input.progressOnly && await input.handleWeekendCommand?.(raw)) continue;
    const event = raw as { type?: string; replyToken?: string; message?: { type?: string; text?: string } } | null;
    const text = event?.type === "message" && event.message?.type === "text" && typeof event.message.text === "string"
      ? FORM_REPLIES.get(event.message.text.trim().toLowerCase())
      : undefined;
    if (text && typeof event?.replyToken === "string" && event.replyToken) {
      await replyLineMessage({ replyToken: event.replyToken, text, tutorBot: input.progressOnly });
    } else {
      otherEvents.push(raw);
    }
  }
  payload = { ...root, events: otherEvents };

  const roomEvents = input.progressOnly ? { room: [], otherPayload: payload } : splitRoomEvents(payload);
  if (roomEvents.room.length) {
    await ingestRoomEvents(input.db, roomEvents.room);
    for (const event of roomEvents.room) input.scheduleRoomCommand?.(event.eventId);
  }
  const ingest = input.progressOnly
    ? await recordLineWebhookPayload(input.db, roomEvents.otherPayload, true)
    : await recordLineWebhookPayload(input.db, roomEvents.otherPayload);
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
