import { describe, expect, it } from "vitest";
import { OWNER_WEB_WISE_USER_ID, classifySessionFixEvents, postEventWindow, type FixEventInput, type PostForMatching } from "../fix-events";

const API = "69366668c05630afe5d8a2a4";
const TUTOR = "696e2c4343579bbada2340f8";
const SESSION = "6aba47d069f1f327513ac027";

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
// A backfilled one-time correction knows only when it was verified (a few seconds after its POST).
const nicknameFix: PostForMatching = {
  id: "post-fix",
  kind: "correction",
  postStartedAt: null,
  postFinishedAt: new Date("2026-09-29T13:26:11.505Z"),
  eventAt: null,
};

describe("classifySessionFixEvents", () => {
  it("reproduces day one: auto-submission, our first post, the nickname re-post", () => {
    const events = [
      event("2026-09-29T08:04:05.113Z", { actorWiseUserId: null, actorRole: null, autoSubmitted: true }),
      event("2026-09-29T08:39:45.495Z"),
      event("2026-09-29T13:26:07.299Z"),
    ];
    const classified = classifySessionFixEvents(events, { posts: [firstShot, nicknameFix], apiActorId: API });
    expect(classified.map((row) => [row.actorKind, row.postId, row.countsAsFix])).toEqual([
      ["auto", null, false],
      ["autowriter_first", "post-first", false],
      ["autowriter_correction", "post-fix", true],
    ]);
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

  it("without a known API user, nothing is ours", () => {
    const [save] = classifySessionFixEvents([event("2026-09-29T08:39:45.495Z")], { posts: [firstShot], apiActorId: null });
    expect(save.actorKind).toBe("other_staff");
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
