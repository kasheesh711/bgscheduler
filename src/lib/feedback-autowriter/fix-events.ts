import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { toFeedbackEventEvidence } from "@/lib/post-class-feedback/events";
import { AUTOWRITER_POST_TIMEOUT_MS } from "./config";
import { readOneTimeCorrections } from "./first-shot";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "./roster";

/**
 * Fixes measured from Wise's own activity feed (Phase 1 of the operating loop).
 *
 * Every `SessionFeedbackSubmittedEvent` on a class the autowriter has a row for is classified by who saved it. Our
 * API user's saves are matched to the posts we made (first shot, correction, or a one-time script's re-post the row
 * records); an API save no post explains is `api_actor_unmatched`, on any class — held, skipped and expired ones
 * included, since those are the classes a script outside the lock would touch. A save by anyone else after our
 * first post is a measured fix. `post_class_feedback_versions` is not used for this: it collapses saves and names
 * the tutor as the actor.
 */

export const FIX_EVENT_CLASSIFIER_VERSION = 1;

/**
 * Kevin's Wise web-app ADMIN user. It is also his main roster account, so on his main-account classes an owner fix
 * and a tutor edit look the same; both count as a fix.
 */
export const OWNER_WEB_WISE_USER_ID = "695369c028118f629edcb986";

/**
 * The autowriter went live at this instant (29 Sep 2026, the control row switched to `live`). An API save no post
 * explains is critical (pushed) from then on; earlier ones — the prototype's saves that morning — are info.
 */
export const UNMATCHED_API_CRITICAL_FROM = new Date("2026-09-29T08:07:30Z");

/** Slack around a POST's own window for Wise's event clock. */
const EVENT_SKEW_MS = 5_000;
/**
 * A backfilled correction knows only when it was verified (the one-time script stamped the time after its
 * read-back), so its window reaches this far back from that moment.
 */
const CORRECTION_LOOKBACK_MS = 120_000;
const FEEDBACK_EVENT = "SessionFeedbackSubmittedEvent";
/** Our own POST may be between its claim and its settled outcome: its events are classified once it settles. */
const POST_IN_FLIGHT_STATES = new Set(["posting", "awaiting_event"]);
/** States a POST settles in; the row's own POST window explains our event until its first shot is recorded. */
const SETTLED_POST_STATES = new Set(["verified", "rejected", "unknown_outcome", "verify_failed"]);

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
  /** The posts row id; a matching key only when `synthetic`. */
  id: string;
  kind: "first_shot" | "correction";
  postStartedAt: Date | null;
  postFinishedAt: Date | null;
  /** Our confirming submit event's time, when the POST's verification recorded it. */
  eventAt: Date | null;
  /** A recorded post's `dedupe_key`, if any. */
  dedupeKey?: string | null;
  /** Not (yet) a posts row: the session row's own POST, or a one-time re-post it records. Matches store no post id. */
  synthetic?: boolean;
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
 * `countsAsFix`: every correction, and any other non-ignored save after our first post (never on a class we
 * did not post). Without the API user's id nothing can be told apart, so this refuses to classify.
 */
export function classifySessionFixEvents(events: readonly FixEventInput[], input: {
  posts: readonly PostForMatching[];
  apiActorId: string;
  rosterIds?: ReadonlySet<string>;
}): ClassifiedFixEvent[] {
  if (!input.apiActorId) throw new Error("The Wise API user id (WISE_USER_ID) is required to tell our saves apart.");
  const rosterIds = input.rosterIds ?? AUTOWRITER_TEACHER_ALLOWLIST;
  const firstShot = input.posts.find((post) => post.kind === "first_shot") ?? null;
  const firstPostAt = firstShot ? (firstShot.eventAt ?? firstShot.postStartedAt ?? firstShot.postFinishedAt) : null;
  const used = new Set<string>();
  const ordered = [...events].toSorted((a, b) => a.eventAt.getTime() - b.eventAt.getTime() || a.wiseEventId.localeCompare(b.wiseEventId));
  const postIdOf = (post: PostForMatching) => post.synthetic ? null : post.id;

  // Exact matches first, so a window match never takes a post another event proves. The recorded event time is
  // trusted only inside the post's own window: a later save the POST path's read-back mistook for ours stays a
  // stranger's, and our real save is matched by the window instead.
  const exact = new Map<string, PostForMatching>();
  for (const event of ordered) {
    if (event.autoSubmitted === true || event.actorWiseUserId !== input.apiActorId) continue;
    const post = input.posts.find((candidate) => !used.has(candidate.id) && candidate.eventAt?.getTime() === event.eventAt.getTime()
      && withinWindow(event, candidate));
    if (post) {
      used.add(post.id);
      exact.set(event.wiseEventId, post);
    }
  }

  const afterFirstPost = (event: FixEventInput) => firstPostAt !== null && event.eventAt.getTime() > firstPostAt.getTime();
  return ordered.map((event): ClassifiedFixEvent => {
    const role = (event.actorRole ?? "").toUpperCase();
    if (event.autoSubmitted === true) return { ...event, actorKind: "auto", postId: null, countsAsFix: false };
    if (role === "STUDENT") return { ...event, actorKind: "student", postId: null, countsAsFix: false };
    if (event.actorWiseUserId === input.apiActorId) {
      const post = exact.get(event.wiseEventId) ?? matchByWindow(event, input.posts, used);
      if (post) {
        used.add(post.id);
        return post.kind === "first_shot"
          ? { ...event, actorKind: "autowriter_first", postId: postIdOf(post), countsAsFix: false }
          : { ...event, actorKind: "autowriter_correction", postId: postIdOf(post), countsAsFix: true };
      }
      return { ...event, actorKind: "api_actor_unmatched", postId: null, countsAsFix: afterFirstPost(event) };
    }
    const actorKind: FixActorKind = event.actorWiseUserId === OWNER_WEB_WISE_USER_ID
      ? "owner_web"
      : event.actorWiseUserId && rosterIds.has(event.actorWiseUserId) ? "tutor" : "other_staff";
    return { ...event, actorKind, postId: null, countsAsFix: afterFirstPost(event) };
  });
}

function withinWindow(event: FixEventInput, post: PostForMatching): boolean {
  const window = postEventWindow(post);
  const at = event.eventAt.getTime();
  return !window || (at >= window.start && at <= window.end);
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

/** The session row as the classifier needs it. */
export interface SessionForMatching {
  wiseSessionId: string;
  state: string;
  postStartedAt: Date | null;
  /** `verified_event.at`, when the POST path recorded our event. */
  verifiedEventAt: Date | null;
  metadata: unknown;
}

function postFinishedAtOf(metadata: unknown): Date | null {
  const post = (metadata as { post?: { postFinishedAt?: unknown } } | null)?.post;
  if (typeof post?.postFinishedAt !== "string") return null;
  const at = new Date(post.postFinishedAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The posts a class's API saves are matched against: the recorded posts, the row's own settled POST while its first
 * shot is not recorded yet (e.g. edited before the backfill proves it), and every one-time re-post the row records
 * that is not a posts row yet (same dedupe key as the backfill writes). Null while our POST is in flight: its events
 * are classified once it settles, never reported as someone else's.
 */
export function matchingPostsForSession(session: SessionForMatching, recorded: readonly PostForMatching[]): PostForMatching[] | null {
  if (POST_IN_FLIGHT_STATES.has(session.state)) return null;
  const posts = [...recorded];
  if (!posts.some((post) => post.kind === "first_shot") && SETTLED_POST_STATES.has(session.state) && session.postStartedAt) {
    posts.push({
      id: `synthetic:first_shot:${session.wiseSessionId}`,
      kind: "first_shot",
      postStartedAt: session.postStartedAt,
      postFinishedAt: postFinishedAtOf(session.metadata),
      eventAt: session.verifiedEventAt,
      synthetic: true,
    });
  }
  const recordedKeys = new Set(recorded.flatMap((post) => post.dedupeKey ? [post.dedupeKey] : []));
  for (const correction of readOneTimeCorrections(session.wiseSessionId, session.metadata)) {
    if (recordedKeys.has(correction.dedupeKey)) continue;
    posts.push({
      id: `synthetic:${correction.dedupeKey}`,
      kind: "correction",
      postStartedAt: null,
      postFinishedAt: correction.at,
      eventAt: null,
      dedupeKey: correction.dedupeKey,
      synthetic: true,
    });
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const P = schema.feedbackAutowriterPosts;
const F = schema.feedbackAutowriterFixEvents;
const E = schema.wiseActivityEvents;
const S = schema.feedbackAutowriterSessions;

function eventTime(value: unknown): Date | null {
  const at = (value as { at?: unknown } | null | undefined)?.at;
  if (typeof at !== "string") return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface FixEventIngestResult {
  sessions: number;
  inserted: number;
  updated: number;
  /** Classes left for the next run because our own POST on them is still settling. */
  skippedInFlight: number;
  /** Events newly stored or re-classified in this run. */
  changed: ClassifiedFixEvent[];
}

type ActivityRow = typeof E.$inferSelect;

/** Everything the classification of a set of classes reads, loaded in one place for the job and the backfill. */
export interface FixEventSources {
  sessionIds: string[];
  events: ActivityRow[];
  sessions: SessionForMatching[];
  posts: Array<PostForMatching & { wiseSessionId: string }>;
}

/**
 * The classes in scope — every class the autowriter has a row for (class ended, or row made, since `since`) plus
 * every first shot recorded since then — with their feedback events, rows and recorded posts. The events are read
 * before the session states, so a POST that lands meanwhile is seen in flight, not as a stranger's save.
 * `postsTable: false` plans as if no posts were recorded yet (a dry run before migration 0100).
 */
export async function loadFixEventSources(db: Database, input: { since: Date; postsTable?: boolean }): Promise<FixEventSources> {
  const postsTable = input.postsTable ?? true;
  const [rows, firstShots] = await Promise.all([
    db.select({ wiseSessionId: S.wiseSessionId }).from(S).where(sql`coalesce(${S.scheduledEndAt}, ${S.createdAt}) >= ${input.since}`),
    postsTable
      ? db.select({ wiseSessionId: P.wiseSessionId }).from(P).where(and(
        eq(P.kind, "first_shot"),
        sql`coalesce(${P.postStartedAt}, ${P.recordedAt}) >= ${input.since}`,
      ))
      : Promise.resolve([] as Array<{ wiseSessionId: string }>),
  ]);
  const sessionIds = [...new Set([...rows, ...firstShots].map((row) => row.wiseSessionId))];
  if (sessionIds.length === 0) return { sessionIds, events: [], sessions: [], posts: [] };
  const events = await db.select().from(E).where(and(eq(E.eventName, FEEDBACK_EVENT), inArray(E.sessionId, sessionIds)));
  const [sessions, posts] = await Promise.all([
    db.select({
      wiseSessionId: S.wiseSessionId, state: S.state, postStartedAt: S.postStartedAt, verifiedEvent: S.verifiedEvent, metadata: S.metadata,
    }).from(S).where(inArray(S.wiseSessionId, sessionIds)),
    postsTable
      ? db.select({
        id: P.id, wiseSessionId: P.wiseSessionId, kind: P.kind, postStartedAt: P.postStartedAt, postFinishedAt: P.postFinishedAt,
        verification: P.verification, dedupeKey: P.dedupeKey,
      }).from(P).where(inArray(P.wiseSessionId, sessionIds))
      : Promise.resolve([]),
  ]);
  return {
    sessionIds,
    events,
    sessions: sessions.map((row) => ({
      wiseSessionId: row.wiseSessionId, state: row.state, postStartedAt: row.postStartedAt,
      verifiedEventAt: eventTime(row.verifiedEvent), metadata: row.metadata,
    })),
    posts: posts.map((post) => ({ ...toPostsForMatching([post])[0], wiseSessionId: post.wiseSessionId })),
  };
}

/** Wise activity rows (feedback saves) as classifier input. */
export function toFixEventInputs(wiseSessionId: string, rows: readonly ActivityRow[]): FixEventInput[] {
  return rows.map((event) => ({
    wiseEventId: event.eventId,
    activityRowId: event.id,
    wiseSessionId,
    eventAt: event.eventTimestamp,
    actorWiseUserId: event.actorWiseUserId,
    actorRole: event.actorRole,
    autoSubmitted: toFeedbackEventEvidence(wiseSessionId, {
      rowId: event.id, eventId: event.eventId, eventTimestamp: event.eventTimestamp, actorWiseUserId: event.actorWiseUserId,
      actorName: event.actorName, actorRole: event.actorRole, payload: event.payload,
    }).autoSubmitted ?? null,
  }));
}

/** Recorded posts as matching input. */
export function toPostsForMatching(rows: ReadonlyArray<Pick<typeof P.$inferSelect,
  "id" | "kind" | "postStartedAt" | "postFinishedAt" | "verification" | "dedupeKey">>): PostForMatching[] {
  return rows.map((post) => ({
    id: post.id,
    kind: post.kind,
    postStartedAt: post.postStartedAt,
    postFinishedAt: post.postFinishedAt,
    eventAt: eventTime((post.verification as { event?: unknown }).event),
    dedupeKey: post.dedupeKey,
  }));
}

/** Classify every class in scope (pure): what the job stores, and what the backfill's dry run previews. */
export function planFixEvents(sources: FixEventSources, apiActorId: string): { classified: ClassifiedFixEvent[]; skippedInFlight: string[] } {
  const sessionById = new Map(sources.sessions.map((row) => [row.wiseSessionId, row]));
  const group = <T>(rows: readonly T[], key: (row: T) => string | null) => {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const id = key(row);
      if (id === null) continue;
      const list = groups.get(id);
      if (list) list.push(row); else groups.set(id, [row]);
    }
    return groups;
  };
  const eventsBySession = group(sources.events, (event) => event.sessionId);
  const postsBySession = group(sources.posts, (post) => post.wiseSessionId);
  const classified: ClassifiedFixEvent[] = [];
  const skippedInFlight: string[] = [];
  for (const wiseSessionId of sources.sessionIds) {
    const sessionEvents = eventsBySession.get(wiseSessionId) ?? [];
    if (sessionEvents.length === 0) continue;
    const session = sessionById.get(wiseSessionId);
    const recorded = postsBySession.get(wiseSessionId) ?? [];
    const matching = session ? matchingPostsForSession(session, recorded) : recorded;
    if (matching === null) {
      skippedInFlight.push(wiseSessionId);
      continue;
    }
    classified.push(...classifySessionFixEvents(toFixEventInputs(wiseSessionId, sessionEvents), { posts: matching, apiActorId }));
  }
  return { classified, skippedInFlight };
}

/**
 * Derive fix events (see `loadFixEventSources` for the scope). Idempotent by Wise event id: a re-run stores nothing
 * new, and a re-classification (e.g. a correction recorded later explains an API event) updates the row in place.
 */
export async function ingestFixEvents(db: Database, input: { apiActorId: string; since: Date }): Promise<FixEventIngestResult> {
  if (!input.apiActorId) throw new Error("The Wise API user id (WISE_USER_ID) is required to tell our saves apart.");
  const sources = await loadFixEventSources(db, { since: input.since });
  const result: FixEventIngestResult = { sessions: sources.sessionIds.length, inserted: 0, updated: 0, skippedInFlight: 0, changed: [] };
  if (sources.sessionIds.length === 0) return result;
  const plan = planFixEvents(sources, input.apiActorId);
  result.skippedInFlight = plan.skippedInFlight.length;
  const existing = await db.select({
    wiseEventId: F.wiseEventId, actorKind: F.actorKind, postId: F.postId, countsAsFix: F.countsAsFix,
    classifierVersion: F.classifierVersion,
  }).from(F).where(inArray(F.wiseSessionId, sources.sessionIds));
  const stored = new Map(existing.map((row) => [row.wiseEventId, row]));
  const changed = plan.classified.filter((event) => {
    const before = stored.get(event.wiseEventId);
    return !(before && before.actorKind === event.actorKind && before.postId === event.postId &&
      before.countsAsFix === event.countsAsFix && before.classifierVersion === FIX_EVENT_CLASSIFIER_VERSION);
  });

  // One statement per chunk: the first run after a deploy may classify weeks of classes at once.
  for (let index = 0; index < changed.length; index += 500) {
    await db.insert(F).values(changed.slice(index, index + 500).map((event) => ({
      wiseEventId: event.wiseEventId,
      wiseActivityEventId: event.activityRowId,
      wiseSessionId: event.wiseSessionId,
      eventAt: event.eventAt,
      actorWiseUserId: event.actorWiseUserId,
      actorRole: event.actorRole,
      autoSubmitted: event.autoSubmitted,
      actorKind: event.actorKind,
      postId: event.postId,
      countsAsFix: event.countsAsFix,
      classifierVersion: FIX_EVENT_CLASSIFIER_VERSION,
    }))).onConflictDoUpdate({
      target: F.wiseEventId,
      set: {
        actorKind: sql`excluded.actor_kind`,
        postId: sql`excluded.post_id`,
        countsAsFix: sql`excluded.counts_as_fix`,
        classifierVersion: sql`excluded.classifier_version`,
        updatedAt: sql`now()`,
      },
    });
  }
  for (const event of changed) {
    if (stored.has(event.wiseEventId)) result.updated += 1; else result.inserted += 1;
  }
  result.changed = changed;
  return result;
}
