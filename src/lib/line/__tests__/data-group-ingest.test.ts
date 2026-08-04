// ----------------------------------------------------------------------------
// Group ingestion in recordLineWebhookPayload.
//
// The central guarantee is that group events are a COMMAND CHANNEL, not a
// conversation: they must never write to line_contacts / line_threads /
// line_messages. Every test here passes a database that throws if touched, so
// any accidental persistence fails loudly rather than silently polluting the
// parent review queue.
// ----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { recordLineWebhookPayload } from "@/lib/line/data";
import type { Database } from "@/lib/db";

/** Any use of this database is a test failure. */
const untouchableDb = new Proxy({}, {
  get(_target, property) {
    throw new Error(`database was touched for a group event: .${String(property)}()`);
  },
}) as unknown as Database;

const GROUP = "Cgroup000000000000000000000000001";
const SENDER = "Uadmin000000000000000000000000001";

function groupTextEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    webhookEventId: "evt-1",
    replyToken: "tok-1",
    source: { type: "group", groupId: GROUP, userId: SENDER },
    message: {
      id: "msg-1",
      type: "text",
      text: "@BeGifted Aadhu.Sr",
      mention: { mentionees: [{ index: 0, length: 9, type: "user", isSelf: true }] },
    },
    ...overrides,
  };
}

async function ingest(events: unknown[]) {
  return recordLineWebhookPayload(untouchableDb, { events });
}

describe("group command ingestion", () => {
  it("collects a group text message without persisting anything", async () => {
    const result = await ingest([groupTextEvent()]);

    expect(result.groupCommands).toHaveLength(1);
    expect(result.groupCommands[0]).toMatchObject({
      groupId: GROUP,
      lineUserId: SENDER,
      text: "@BeGifted Aadhu.Sr",
      replyToken: "tok-1",
    });
    // No line_messages row was created for it.
    expect(result.createdMessageIds).toEqual([]);
    expect(result.ignoredEvents).toBe(0);
  });

  it("carries the message through so mention data survives", async () => {
    const result = await ingest([groupTextEvent()]);
    const mention = result.groupCommands[0].message.mention as Record<string, unknown>;
    expect(Array.isArray(mention.mentionees)).toBe(true);
  });

  it("treats a multi-person room the same as a group", async () => {
    const result = await ingest([groupTextEvent({
      source: { type: "room", roomId: "Rroom0001", userId: SENDER },
    })]);

    expect(result.groupCommands).toHaveLength(1);
    expect(result.groupCommands[0].groupId).toBe("Rroom0001");
  });

  it("keeps ignoring non-text group messages", async () => {
    const result = await ingest([groupTextEvent({
      message: { id: "m", type: "image" },
    })]);

    expect(result.groupCommands).toEqual([]);
    expect(result.ignoredEvents).toBe(1);
  });

  it("keeps ignoring non-message group events such as join and leave", async () => {
    const result = await ingest([
      groupTextEvent({ type: "join", message: undefined }),
      groupTextEvent({ type: "memberJoined", message: undefined }),
    ]);

    expect(result.groupCommands).toEqual([]);
    expect(result.ignoredEvents).toBe(2);
  });

  it("ignores a group event with no sender", async () => {
    // Without source.userId the admin allowlist cannot be applied, so the event
    // must be dropped rather than processed anonymously.
    const result = await ingest([groupTextEvent({
      source: { type: "group", groupId: GROUP },
    })]);

    expect(result.groupCommands).toEqual([]);
    expect(result.ignoredEvents).toBe(1);
  });

  it("ignores a group event with no group id", async () => {
    const result = await ingest([groupTextEvent({
      source: { type: "group", userId: SENDER },
    })]);

    expect(result.groupCommands).toEqual([]);
    expect(result.ignoredEvents).toBe(1);
  });

  it("collects several group commands in one payload", async () => {
    const result = await ingest([
      groupTextEvent({ webhookEventId: "a" }),
      groupTextEvent({ webhookEventId: "b", source: { type: "group", groupId: "Cother", userId: SENDER } }),
    ]);

    expect(result.groupCommands.map((c) => c.groupId)).toEqual([GROUP, "Cother"]);
  });

  it("still ignores unknown source types", async () => {
    const result = await ingest([groupTextEvent({
      source: { type: "something-new", userId: SENDER },
    })]);

    expect(result.groupCommands).toEqual([]);
    expect(result.ignoredEvents).toBe(1);
  });

  it("returns an empty groupCommands array for a payload with no events", async () => {
    const result = await ingest([]);
    expect(result.groupCommands).toEqual([]);
  });
});
