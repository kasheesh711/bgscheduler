import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { toFeedbackEventEvidence } from "@/lib/post-class-feedback/events";
import { AUTOWRITER_POST_TIMEOUT_MS } from "./config";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "./roster";

/**
 * Fixes measured from Wise's own activity feed (Phase 1 of the operating loop).
 *
 * Every `SessionFeedbackSubmittedEvent` on a class the autowriter posted is classified by who saved it. Our API
 * user's saves are matched to the posts we recorded (first shot or correction); a save by anyone else after our
 * first post is a measured fix. `post_class_feedback_versions` is not used for this: it collapses saves and
 * names the tutor as the actor.
 */

export const FIX_EVENT_CLASSIFIER_VERSION = 1;

/**
 * Kevin's Wise web-app ADMIN user. It is also his main roster account, so on his main-account classes an owner fix
 * and a tutor edit look the same; both count as a fix.
 */
export const OWNER_WEB_WISE_USER_ID = "695369c028118f629edcb986";

/** Slack around a POST's own window for Wise's event clock. */
const EVENT_SKEW_MS = 5_000;
/**
 * A backfilled correction knows only when it was verified (the one-time script stamped the time after its
 * read-back), so its window reaches this far back from that moment.
 */
const CORRECTION_LOOKBACK_MS = 120_000;
const FEEDBACK_EVENT = "SessionFeedbackSubmittedEvent";

export type FixActorKind = typeof schema.feedbackAutowriterFixEvents.$inferSelect["actorKind"];

export interface FixEventInput {
  wiseEventId: string;
  activityRowId: string | null;
  wiseSessionId: string;
  eventAt: Date;
  actorWiseUserId: string | null;
  actorRole: string | null;
  autoSubmitted: boolean | null;
}

export interface PostForMatching {
  id: string;
  kind: "first_shot" | "correction";
  postStartedAt: Date | null;
  postFinishedAt: Date | null;
  /** Our confirming submit event's time, when the POST's verification recorded it. */
  eventAt: Date | null;
}

export interface ClassifiedFixEvent extends FixEventInput {
  actorKind: FixActorKind;
  postId: string | null;
  countsAsFix: boolean;
}

/** When our API user's submit event for this post can have happened. */
export function postEventWindow(post: PostForMatching): { start: number; end: number } | null {
  const started = post.postStartedAt?.getTime() ?? null;
  const finished = post.postFinishedAt?.getTime() ?? null;
  if (started === null && finished === null) return null;
  const start = (started ?? (finished! - CORRECTION_LOOKBACK_MS)) - EVENT_SKEW_MS;
  const end = (finished ?? (started! + AUTOWRITER_POST_TIMEOUT_MS)) + EVENT_SKEW_MS;
  return { start, end };
}

/**
 * Classify one class's feedback events (any order). Each post is matched to at most one API event: first by the
 * exact event time its verification recorded, then by its POST window.
 * - auto-submissions and students are ignored (never a fix);
 * - our API user: the matching first shot or correction, or `api_actor_unmatched` when no post explains it
 *   (a script outside the lock, or the key owner's own web save — they look identical);
 * - Kevin's web user → `owner_web`; a roster account → `tutor`; anyone else → `other_staff`.
 * `countsAsFix`: every correction, and any other non-ignored save after our first post.
 */
export function classifySessionFixEvents(events: readonly FixEventInput[], input: {
  posts: readonly PostForMatching[];
  apiActorId: string | null;
  rosterIds?: ReadonlySet<string>;
}): ClassifiedFixEvent[] {
  const rosterIds = input.rosterIds ?? AUTOWRITER_TEACHER_ALLOWLIST;
  const firstShot = input.posts.find((post) => post.kind === "first_shot") ?? null;
  const firstPostAt = firstShot ? (firstShot.eventAt ?? firstShot.postStartedAt ?? firstShot.postFinishedAt) : null;
  const used = new Set<string>();
  const ordered = [...events].toSorted((a, b) => a.eventAt.getTime() - b.eventAt.getTime() || a.wiseEventId.localeCompare(b.wiseEventId));

  // Exact matches first, so a window match never takes a post another event proves.
  const exact = new Map<string, PostForMatching>();
  if (input.apiActorId) {
    for (const event of ordered) {
      if (event.autoSubmitted === true || event.actorWiseUserId !== input.apiActorId) continue;
      const post = input.posts.find((candidate) => !used.has(candidate.id) && candidate.eventAt?.getTime() === event.eventAt.getTime());
      if (post) {
        used.add(post.id);
        exact.set(event.wiseEventId, post);
      }
    }
  }

  const afterFirstPost = (event: FixEventInput) => firstPostAt !== null && event.eventAt.getTime() > firstPostAt.getTime();
  return ordered.map((event): ClassifiedFixEvent => {
    const role = (event.actorRole ?? "").toUpperCase();
    if (event.autoSubmitted === true) return { ...event, actorKind: "auto", postId: null, countsAsFix: false };
    if (role === "STUDENT") return { ...event, actorKind: "student", postId: null, countsAsFix: false };
    if (input.apiActorId && event.actorWiseUserId === input.apiActorId) {
      const post = exact.get(event.wiseEventId) ?? matchByWindow(event, input.posts, used);
      if (post) {
        used.add(post.id);
        return post.kind === "first_shot"
          ? { ...event, actorKind: "autowriter_first", postId: post.id, countsAsFix: false }
          : { ...event, actorKind: "autowriter_correction", postId: post.id, countsAsFix: true };
      }
      return { ...event, actorKind: "api_actor_unmatched", postId: null, countsAsFix: afterFirstPost(event) };
    }
    const actorKind: FixActorKind = event.actorWiseUserId === OWNER_WEB_WISE_USER_ID
      ? "owner_web"
      : event.actorWiseUserId && rosterIds.has(event.actorWiseUserId) ? "tutor" : "other_staff";
    return { ...event, actorKind, postId: null, countsAsFix: afterFirstPost(event) };
  });
}

function matchByWindow(event: FixEventInput, posts: readonly PostForMatching[], used: ReadonlySet<string>): PostForMatching | null {
  const at = event.eventAt.getTime();
  let best: { post: PostForMatching; distance: number } | null = null;
  for (const post of posts) {
    if (used.has(post.id)) continue;
    const window = postEventWindow(post);
    if (!window || at < window.start || at > window.end) continue;
    const anchor = post.postStartedAt?.getTime() ?? post.postFinishedAt!.getTime();
    const distance = Math.abs(at - anchor);
    if (!best || distance < best.distance) best = { post, distance };
  }
  return best?.post ?? null;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const P = schema.feedbackAutowriterPosts;
const F = schema.feedbackAutowriterFixEvents;
const E = schema.wiseActivityEvents;

function verifiedEventAt(verification: Record<string, unknown>): Date | null {
  const event = verification.event as { at?: unknown } | undefined;
  if (typeof event?.at !== "string") return null;
  const at = new Date(event.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface FixEventIngestResult {
  sessions: number;
  inserted: number;
  updated: number;
  /** Events newly stored or re-classified in this run (callers raise flags and incidents from these). */
  changed: ClassifiedFixEvent[];
}

/**
 * Derive fix events for every class with a first-shot post recorded since `since`. Idempotent by Wise event id: a
 * re-run stores nothing new, and a re-classification (e.g. a correction recorded later explains an API event)
 * updates the row in place.
 */
export async function ingestFixEvents(db: Database, input: { apiActorId: string | null; since: Date }): Promise<FixEventIngestResult> {
  const firstShots = await db.select({ wiseSessionId: P.wiseSessionId }).from(P).where(and(
    eq(P.kind, "first_shot"),
    sql`coalesce(${P.postStartedAt}, ${P.recordedAt}) >= ${input.since}`,
  ));
  const sessionIds = [...new Set(firstShots.map((row) => row.wiseSessionId))];
  const result: FixEventIngestResult = { sessions: sessionIds.length, inserted: 0, updated: 0, changed: [] };
  if (sessionIds.length === 0) return result;

  const [posts, events, existing] = await Promise.all([
    db.select({
      id: P.id, wiseSessionId: P.wiseSessionId, kind: P.kind, postStartedAt: P.postStartedAt,
      postFinishedAt: P.postFinishedAt, verification: P.verification,
    }).from(P).where(inArray(P.wiseSessionId, sessionIds)),
    db.select({
      id: E.id, eventId: E.eventId, sessionId: E.sessionId, eventTimestamp: E.eventTimestamp,
      actorWiseUserId: E.actorWiseUserId, actorName: E.actorName, actorRole: E.actorRole, payload: E.payload,
    }).from(E).where(and(eq(E.eventName, FEEDBACK_EVENT), inArray(E.sessionId, sessionIds))),
    db.select({
      wiseEventId: F.wiseEventId, actorKind: F.actorKind, postId: F.postId, countsAsFix: F.countsAsFix,
      classifierVersion: F.classifierVersion,
    }).from(F).where(inArray(F.wiseSessionId, sessionIds)),
  ]);
  const stored = new Map(existing.map((row) => [row.wiseEventId, row]));

  for (const wiseSessionId of sessionIds) {
    const sessionPosts: PostForMatching[] = posts.filter((post) => post.wiseSessionId === wiseSessionId).map((post) => ({
      id: post.id,
      kind: post.kind,
      postStartedAt: post.postStartedAt,
      postFinishedAt: post.postFinishedAt,
      eventAt: verifiedEventAt(post.verification),
    }));
    const sessionEvents: FixEventInput[] = events.filter((event) => event.sessionId === wiseSessionId).map((event) => {
      const evidence = toFeedbackEventEvidence(wiseSessionId, {
        rowId: event.id, eventId: event.eventId, eventTimestamp: event.eventTimestamp,
        actorWiseUserId: event.actorWiseUserId, actorName: event.actorName, actorRole: event.actorRole,
        payload: event.payload,
      });
      return {
        wiseEventId: event.eventId,
        activityRowId: event.id,
        wiseSessionId,
        eventAt: event.eventTimestamp,
        actorWiseUserId: event.actorWiseUserId,
        actorRole: event.actorRole,
        autoSubmitted: evidence.autoSubmitted ?? null,
      };
    });
    for (const event of classifySessionFixEvents(sessionEvents, { posts: sessionPosts, apiActorId: input.apiActorId })) {
      const before = stored.get(event.wiseEventId);
      if (before && before.actorKind === event.actorKind && before.postId === event.postId &&
        before.countsAsFix === event.countsAsFix && before.classifierVersion === FIX_EVENT_CLASSIFIER_VERSION) continue;
      await db.insert(F).values({
        wiseEventId: event.wiseEventId,
        wiseActivityEventId: event.activityRowId,
        wiseSessionId,
        eventAt: event.eventAt,
        actorWiseUserId: event.actorWiseUserId,
        actorRole: event.actorRole,
        autoSubmitted: event.autoSubmitted,
        actorKind: event.actorKind,
        postId: event.postId,
        countsAsFix: event.countsAsFix,
        classifierVersion: FIX_EVENT_CLASSIFIER_VERSION,
      }).onConflictDoUpdate({
        target: F.wiseEventId,
        set: {
          actorKind: sql`excluded.actor_kind`,
          postId: sql`excluded.post_id`,
          countsAsFix: sql`excluded.counts_as_fix`,
          classifierVersion: sql`excluded.classifier_version`,
          updatedAt: sql`now()`,
        },
      });
      if (before) result.updated += 1; else result.inserted += 1;
      result.changed.push(event);
    }
  }
  return result;
}
