import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { loadReplaySample } from "../replay";
import { fieldsHash } from "../submit";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const NOW = new Date("2026-09-30T02:00:00.000Z");
const KEVIN = "696e2c4343579bbada2340ed";
const KEVIN_MAIN = "695369c028118f629edcb986";
const GIFT_MAIN = "695369c028118f629edcb9cb";
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const DRAFT = { topics: "Fractions", performance: "Did well", improvement: "Simplify", homework: "" };

async function row(id: string, patch: Partial<typeof S.$inferInsert>) {
  await db.insert(S).values({
    wiseSessionId: id, wiseClassId: "6a0000000000000000000001", wiseTeacherUserId: KEVIN,
    scheduledEndAt: hoursAgo(5), deadlineAt: hoursAgo(-30), state: "verified", ...patch,
  });
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions, post_class_sessions, post_class_feedback_versions,
    wise_activity_events, wise_webhook_events CASCADE`);
});

describe("loadReplaySample (Postgres, reads only)", () => {
  it("takes each tutor's most recent in-scope classes (both accounts) that ended at least 3 h ago, plus the sessions named", async () => {
    await row("6a0000000000000000000a01", { state: "verified", fields: DRAFT, scheduledEndAt: hoursAgo(4) });
    await row("6a0000000000000000000a02", { state: "skipped_human", wiseTeacherUserId: KEVIN_MAIN, scheduledEndAt: hoursAgo(6) });
    await row("6a0000000000000000000a03", { state: "held", scheduledEndAt: hoursAgo(8) });
    // Too recent (the recording may not be in yet), out of scope, still in flight, or older than the window.
    await row("6a0000000000000000000a04", { state: "verified", fields: DRAFT, scheduledEndAt: hoursAgo(1) });
    await row("6a0000000000000000000a05", { state: "skipped_scope", scheduledEndAt: hoursAgo(5) });
    await row("6a0000000000000000000a06", { state: "awaiting_recording", scheduledEndAt: hoursAgo(5) });
    await row("6a0000000000000000000a07", { state: "verified", fields: DRAFT, scheduledEndAt: hoursAgo(9 * 24) });
    await row("6a0000000000000000000a08", { state: "would_submit", fields: DRAFT, wiseTeacherUserId: GIFT_MAIN, scheduledEndAt: hoursAgo(7) });

    const samples = await loadReplaySample(db, { sessionIds: ["6a0000000000000000000a07", "6a0000000000000000000fff"], perTutor: 2, days: 7, now: NOW });
    expect(samples.map((sample) => sample.wiseSessionId)).toEqual([
      "6a0000000000000000000a07", "6a0000000000000000000fff", // named first, with or without a row
      "6a0000000000000000000a01", "6a0000000000000000000a02", // Kevin's two most recent, both accounts
      "6a0000000000000000000a08", // Gift
    ]);
    const byId = new Map(samples.map((sample) => [sample.wiseSessionId, sample]));
    expect(byId.get("6a0000000000000000000fff")).toEqual({
      wiseSessionId: "6a0000000000000000000fff", rowState: null, postedFields: null, postedSource: null, recordingPublishedAt: null,
    });
    expect(byId.get("6a0000000000000000000a01")).toMatchObject({ rowState: "verified", postedFields: DRAFT, postedSource: "row" });
    // A class the tutor wrote has no draft of ours to judge; a shadow draft does.
    expect(byId.get("6a0000000000000000000a02")).toMatchObject({ rowState: "skipped_human", postedFields: null });
    expect(byId.get("6a0000000000000000000a08")).toMatchObject({ rowState: "would_submit", postedFields: DRAFT });
  });

  it("recovers the text first posted when a one-time correction replaced it, by its hash in Class Feedback's versions", async () => {
    const original = { ...DRAFT, homework: "Finish the last two pages." };
    const corrected = { ...DRAFT, homework: "" };
    await row("6a0000000000000000000b01", {
      state: "verified", fields: corrected,
      metadata: { corrections: [{ fields: ["homework"], fromSha256: fieldsHash(original), toSha256: fieldsHash(corrected), at: "2026-09-29T18:07:04.491Z" }] },
    });
    const [session] = await db.insert(schema.postClassSessions).values({
      wiseSessionId: "6a0000000000000000000b01", wiseClassId: "6a0000000000000000000001",
      scheduledStartAt: hoursAgo(6), scheduledEndAt: hoursAgo(5), deadlineAt: hoursAgo(-30), finalStatus: "ENDED",
    }).returning({ id: schema.postClassSessions.id });
    for (const [key, fields] of [["auto", { topics: "", performance: "", improvement: "", homework: "" }], ["posted", original], ["fixed", corrected]] as const) {
      await db.insert(schema.postClassFeedbackVersions).values({
        sessionId: session.id, versionKey: key, contentHash: key, observedAt: NOW, ...fields,
      });
    }
    // A correction whose original is nowhere to be found: the corrected text, said so.
    await row("6a0000000000000000000b02", {
      state: "verified", fields: corrected, scheduledEndAt: hoursAgo(6),
      metadata: { corrections: [{ fields: ["homework"], fromSha256: "0".repeat(64) }] },
    });

    const samples = await loadReplaySample(db, { sessionIds: ["6a0000000000000000000b01", "6a0000000000000000000b02"], perTutor: 0, days: 7, now: NOW });
    expect(samples).toEqual([
      expect.objectContaining({ wiseSessionId: "6a0000000000000000000b01", postedFields: original, postedSource: "pre_correction_version" }),
      expect.objectContaining({ wiseSessionId: "6a0000000000000000000b02", postedFields: corrected, postedSource: "corrected_row" }),
    ]);
  });

  it("notes when Wise published each class's recording, from the activity feed or a webhook delivery, whichever came first", async () => {
    await row("6a0000000000000000000c01", { state: "verified" });
    await row("6a0000000000000000000c02", { state: "verified" });
    await row("6a0000000000000000000c03", { state: "verified" });
    await db.insert(schema.wiseActivityEvents).values([
      { eventId: "e1", eventName: "RecordingCompletedEvent", eventTimestamp: new Date("2026-09-29T21:40:00.000Z"), sessionId: "6a0000000000000000000c01" },
      { eventId: "e2", eventName: "RecordingCompletedEvent", eventTimestamp: new Date("2026-09-29T21:50:00.000Z"), sessionId: "6a0000000000000000000c01" },
      { eventId: "e3", eventName: "AttendanceCalculatedEvent", eventTimestamp: new Date("2026-09-29T21:05:00.000Z"), sessionId: "6a0000000000000000000c03" },
    ]);
    await db.insert(schema.wiseWebhookEvents).values([
      { dedupeKey: "d1", eventName: "RecordingCompletedEvent", wiseSessionId: "6a0000000000000000000c01", payload: {}, receivedAt: new Date("2026-09-29T21:38:00.000Z") },
      { dedupeKey: "d2", eventName: "RecordingCompletedEvent", wiseSessionId: "6a0000000000000000000c02", payload: {}, receivedAt: new Date("2026-09-29T21:45:00.000Z") },
    ]);
    const samples = await loadReplaySample(db, {
      sessionIds: ["6a0000000000000000000c01", "6a0000000000000000000c02", "6a0000000000000000000c03"], perTutor: 0, days: 7, now: NOW,
    });
    expect(samples.map((sample) => sample.recordingPublishedAt)).toEqual([
      "2026-09-29T21:38:00.000Z", "2026-09-29T21:45:00.000Z", null,
    ]);
  });
});
