import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import type { RoomBotEvent } from "./model";
export const isRoomText = (text: string) =>
  /^\/room(?:\s|$)/i.test(text.trim());
export function splitRoomEvents(payload: unknown) {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const room: RoomBotEvent[] = [];
  const other: unknown[] = [];
  for (const raw of Array.isArray(root.events) ? root.events : []) {
    const e = raw as {
      type?: string;
      webhookEventId?: string;
      timestamp?: number;
      replyToken?: string;
      source?: {
        type?: string;
        userId?: string;
        groupId?: string;
        roomId?: string;
      };
      message?: { type?: string; text?: string; id?: string };
      postback?: { data?: string; params?: { time?: string } };
    };
    if (!e || typeof e !== "object") {
      other.push(raw);
      continue;
    }
    const text =
      e.type === "message" && e.message?.type === "text"
        ? e.message.text
        : null;
    const postback =
      e.type === "postback" &&
      typeof e.postback?.data === "string" &&
      e.postback.data.startsWith("room:")
        ? e.postback.data
        : null;
    if (!(typeof text === "string" && isRoomText(text)) && !postback) {
      other.push(raw);
      continue;
    }
    const scope =
      e.source?.type === "user"
        ? "dm"
        : (e.source?.groupId ?? e.source?.roomId);
    const userId = e.source?.userId;
    const eventId = e.webhookEventId ?? e.message?.id;
    if (!userId || !scope || !eventId) continue;
    room.push({
      eventId,
      userId,
      scope,
      replyToken: e.replyToken ?? null,
      text: (postback ?? text!).slice(0, 1000),
      params: postback ? e.postback?.params : undefined,
      receivedAt: new Date(e.timestamp ?? Date.now()).toISOString(),
    });
  }
  return { room, otherPayload: { ...root, events: other } };
}
export async function ingestRoomEvents(db: Database, events: RoomBotEvent[]) {
  for (const event of events)
    await db
      .insert(s.roomCommandEvents)
      .values({ eventId: event.eventId, payload: event })
      .onConflictDoNothing();
}
