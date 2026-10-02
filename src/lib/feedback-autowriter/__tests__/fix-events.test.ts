import { describe, expect, it } from "vitest";
import {
  OWNER_WEB_WISE_USER_ID,
  UNMATCHED_API_CRITICAL_FROM,
  classifySessionFixEvents,
  matchingPostsForSession,
  postEventWindow,
  type FixEventInput,
  type PostForMatching,
  type SessionForMatching,
} from "../fix-events";

const API = "69366668c05630afe5d8a2a4";
const TUTOR = "696e2c4343579bbada2340f8";
const SESSION = "6a0000000000000000000a01";

let counter = 0;
function event(at: string, overrides: Partial<FixEventInput> = {}): FixEventInput {
  counter += 1;
  return {
    wiseEventId: `evt-${String(counter).padStart(3, "0")}`,
    activityRowId: null,
    wiseSessionId: SESSION,
    eventAt: new Date(at),
    actorWiseUserId: API,
    actorRole: "OWNER",
    autoSubmitted: null,
    ...overrides,
  };
}

const firstShot: PostForMatching = {
  id: "post-first",
  kind: "first_shot",
  postStartedAt: new Date("2026-09-29T08:39:45.402Z"),
  postFinishedAt: new Date("2026-09-29T08:39:46.100Z"),
  eventAt: new Date("2026-09-29T08:39:45.495Z"),
};
// A backfilled one-time re-post knows only when it was verified (a few seconds after its POST). The nickname fix
// applied a naming rule made after the post: a policy re-post (owner decision D-01, 30 Sep).
const nicknameFix: PostForMatching = {
  id: "post-fix",
  kind: "policy",
  postStartedAt: null,
  postFinishedAt: new Date("2026-09-29T13:26:11.505Z"),
  eventAt: null,
};

describe("classifySessionFixEvents", () => {
  it("reproduces day one: auto-submission, our first post, the nickname re-post (a policy change, never a fix)", () => {
    const events = [
      event("2026-09-29T08:04:05.113Z", { actorWiseUserId: null, actorRole: null, autoSubmitted: true }),
      event("2026-09-29T08:39:45.495Z"),
      event("2026-09-29T13:26:07.299Z"),
    ];
    const classified = classifySessionFixEvents(events, { posts: [firstShot, nicknameFix], apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.postId, row.countsAsFix])).toEqual([
      ["auto", null, false],
      ["autowriter_first", "post-first", false],
      ["autowriter_policy", "post-fix", false],
    ]);
    // The same save matched to an owner-approved correction of a wrong post is a fix.
    const corrected = classifySessionFixEvents(events, { posts: [firstShot, { ...nicknameFix, kind: "correction" }], apiActorId: API });
    expect(corrected[2]).toMatchObject({ actorKind: "autowriter_correction", countsAsFix: true });
  });

  it("ignores students; counts a person's save after our first post as a fix, never one before it", () => {
    const classified = classifySessionFixEvents([
      event("2026-09-29T08:30:00Z", { actorWiseUserId: "someone-else", actorRole: "ADMIN" }),
      event("2026-09-29T08:39:45.495Z"),
      event("2026-09-29T09:05:29.355Z", { actorWiseUserId: "student-1", actorRole: "STUDENT" }),
      event("2026-09-29T10:00:00Z", { actorWiseUserId: TUTOR, actorRole: "TEACHER" }),
      event("2026-09-29T11:00:00Z", { actorWiseUserId: "other-admin", actorRole: "ADMIN" }),
    ], { posts: [firstShot], apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.countsAsFix])).toEqual([
      ["other_staff", false],
      ["autowriter_first", false],
      ["student", false],
      ["tutor", true],
      ["other_staff", true],
    ]);
  });

  it("names Kevin's web user owner_web even though it is also his main roster account", () => {
    const [save] = classifySessionFixEvents([event("2026-09-29T12:00:00Z", { actorWiseUserId: OWNER_WEB_WISE_USER_ID, actorRole: "ADMIN" })],
      { posts: [firstShot], apiActorId: API });
    expect(save).toMatchObject({ actorKind: "owner_web", countsAsFix: true });
  });

  it("reports an API save no recorded post explains, and matches each post at most once", () => {
    const classified = classifySessionFixEvents([
      event("2026-09-29T08:39:45.495Z"),
      event("2026-09-29T08:39:46.000Z"),
      event("2026-09-29T15:00:00Z"),
    ], { posts: [firstShot], apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.countsAsFix])).toEqual([
      ["autowriter_first", false],
      ["api_actor_unmatched", true],
      ["api_actor_unmatched", true],
    ]);
  });

  it("matches the first shot by its POST window when the verification recorded no event time", () => {
    const [ours] = classifySessionFixEvents([event("2026-09-29T08:39:47Z")], {
      posts: [{ ...firstShot, eventAt: null }], apiActorId: API,
    });
    expect(ours).toMatchObject({ actorKind: "autowriter_first", postId: "post-first" });
  });

  it("trusts a recorded event time only inside the post's own window", () => {
    // The POST path's read-back took a later API save for ours: that save stays a stranger's, ours matches by window.
    const [ours, later] = classifySessionFixEvents([event("2026-09-29T08:39:45.495Z"), event("2026-09-29T09:30:00Z")], {
      posts: [{ ...firstShot, eventAt: new Date("2026-09-29T09:30:00Z") }], apiActorId: API,
    });
    expect([ours.actorKind, later.actorKind]).toEqual(["autowriter_first", "api_actor_unmatched"]);
  });

  it("refuses to classify without the API user's id (it would read our own saves as staff fixes)", () => {
    expect(() => classifySessionFixEvents([event("2026-09-29T08:39:45.495Z")], { posts: [firstShot], apiActorId: "" })).toThrow(/WISE_USER_ID/u);
  });

  it("reports an API save on a class we never posted, without counting it as a fix", () => {
    const classified = classifySessionFixEvents([
      event("2026-09-29T09:00:00Z", { actorWiseUserId: TUTOR, actorRole: "TEACHER" }),
      event("2026-09-29T09:10:00Z"),
    ], { posts: [], apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.countsAsFix])).toEqual([["tutor", false], ["api_actor_unmatched", false]]);
  });
});

describe("matchingPostsForSession", () => {
  const session = (overrides: Partial<SessionForMatching> = {}): SessionForMatching => ({
    wiseSessionId: SESSION,
    state: "verified",
    postStartedAt: new Date("2026-09-29T14:09:17.797Z"),
    verifiedEventAt: new Date("2026-09-29T14:09:17.871Z"),
    metadata: { post: { postFinishedAt: "2026-09-29T14:09:17.911Z" } },
    ...overrides,
  });
  // As `.feedback-autowriter/correct-posts.ts` records an owner-approved correction.
  const corrected = {
    post: { postFinishedAt: "2026-09-29T14:09:17.911Z" },
    corrections: [{
      fields: ["improvement", "homework"], reason: "synthetic reason", fromSha256: "a".repeat(64), toSha256: "b".repeat(64),
      at: "2026-09-29T18:07:12.757Z", by: "owner@example.com (one-time correction, owner-approved)",
    }],
  };

  it("leaves a class whose POST is in flight for the next run", () => {
    expect(matchingPostsForSession(session({ state: "posting" }), [])).toBeNull();
    expect(matchingPostsForSession(session({ state: "awaiting_event" }), [])).toBeNull();
  });

  it("explains our settled POST from the row until its first shot is recorded", () => {
    const posts = matchingPostsForSession(session(), [])!;
    expect(posts).toMatchObject([{ kind: "first_shot", synthetic: true, eventAt: new Date("2026-09-29T14:09:17.871Z") }]);
    const [ours] = classifySessionFixEvents([event("2026-09-29T14:09:17.871Z")], { posts, apiActorId: API });
    expect(ours).toMatchObject({ actorKind: "autowriter_first", postId: null });
    // Never for a class that was not posted.
    expect(matchingPostsForSession(session({ state: "held", postStartedAt: null }), [])).toEqual([]);
  });

  it("explains every metadata.corrections entry from the row: the correction's API save is ours (a fix), not unmatched", () => {
    const posts = matchingPostsForSession(session({ metadata: corrected }), [])!;
    expect(posts.map((post) => [post.kind, post.dedupeKey ?? null])).toEqual([
      ["first_shot", null],
      ["correction", `correction:${SESSION}:2026-09-29T18:07:12.757Z`],
    ]);
    const classified = classifySessionFixEvents([
      event("2026-09-29T14:09:17.871Z"),
      // The re-post, 4 s before the script stamped its read-back.
      event("2026-09-29T18:07:08.506Z"),
    ], { posts, apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.countsAsFix])).toEqual([["autowriter_first", false], ["autowriter_correction", true]]);
    // Without the entry the same save is an unmatched API write (after go-live: a critical page).
    const bare = classifySessionFixEvents([event("2026-09-29T14:09:17.871Z"), event("2026-09-29T18:07:08.506Z")], {
      posts: matchingPostsForSession(session(), [])!, apiActorId: API,
    });
    expect(bare[1]).toMatchObject({ actorKind: "api_actor_unmatched", countsAsFix: true });
    expect(bare[1].eventAt.getTime()).toBeGreaterThan(UNMATCHED_API_CRITICAL_FROM.getTime());
  });

  it("tells the nickname fix (policy, not counted) from an owner-approved correction (a fix) on the same class", () => {
    const both = {
      ...corrected,
      nicknameFix: { from: "Alexander", to: "Alex", at: "2026-09-29T15:00:03.000Z", by: "owner@example.com (one-time fix)" },
    };
    const posts = matchingPostsForSession(session({ metadata: both }), [])!;
    expect(posts.map((post) => [post.kind, post.dedupeKey ?? null])).toEqual([
      ["first_shot", null],
      ["policy", `nickname-fix:${SESSION}`],
      ["correction", `correction:${SESSION}:2026-09-29T18:07:12.757Z`],
    ]);
    const classified = classifySessionFixEvents([
      event("2026-09-29T14:09:17.871Z"),
      event("2026-09-29T15:00:01.000Z"),
      event("2026-09-29T18:07:08.506Z"),
    ], { posts, apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.countsAsFix])).toEqual([
      ["autowriter_first", false],
      ["autowriter_policy", false],
      ["autowriter_correction", true],
    ]);
  });

  it("does not add a one-time re-post twice once the backfill recorded it", () => {
    const recorded: PostForMatching[] = [
      { id: "first", kind: "first_shot", postStartedAt: new Date("2026-09-29T14:09:17.797Z"), postFinishedAt: null, eventAt: null },
      { id: "fix", kind: "correction", postStartedAt: null, postFinishedAt: new Date("2026-09-29T18:07:12.757Z"), eventAt: null,
        dedupeKey: `correction:${SESSION}:2026-09-29T18:07:12.757Z` },
    ];
    expect(matchingPostsForSession(session({ metadata: corrected }), recorded)!.map((post) => post.id)).toEqual(["first", "fix"]);
  });
});

describe("postEventWindow", () => {
  it("spans the POST (±5 s), or reaches back two minutes from a verified-only correction", () => {
    expect(postEventWindow(firstShot)).toEqual({
      start: firstShot.postStartedAt!.getTime() - 5_000,
      end: firstShot.postFinishedAt!.getTime() + 5_000,
    });
    expect(postEventWindow(nicknameFix)).toEqual({
      start: nicknameFix.postFinishedAt!.getTime() - 125_000,
      end: nicknameFix.postFinishedAt!.getTime() + 5_000,
    });
    expect(postEventWindow({ ...firstShot, postStartedAt: null, postFinishedAt: null })).toBeNull();
  });
});
