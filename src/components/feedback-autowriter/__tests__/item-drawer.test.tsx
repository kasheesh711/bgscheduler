import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClassBody,
  FailedPostBody,
  HoldBody,
  IncidentBody,
  ReviewBody,
  drawerTargetFor,
  resolveDrawer,
  targetForClass,
} from "../item-drawer";
import { FIXTURE_NOW, INCIDENT, SESSION, correctedQueueItem, dashboardFixture, reviewFixture } from "./fixtures";

const NOW = new Date(FIXTURE_NOW);
const dashboard = dashboardFixture();
const review = reviewFixture();
const hold = (id: string) => dashboard.holds.find((row) => row.wiseSessionId === id)!;
const row = (id: string) => dashboard.recent.find((entry) => entry.wiseSessionId === id) ?? null;
const incident = (id: string) => review.incidents.find((entry) => entry.id === id)!;

describe("where things open", () => {
  it("opens a to-do item as what it is", () => {
    expect(drawerTargetFor({ id: `incident:${INCIDENT.critical}`, kind: "incident", wiseSessionId: SESSION.benCritical }))
      .toEqual({ kind: "incident", incidentId: INCIDENT.critical });
    expect(drawerTargetFor({ id: "hold:x", kind: "hold", wiseSessionId: "x" })).toEqual({ kind: "hold", wiseSessionId: "x" });
    expect(drawerTargetFor({ id: "review:x", kind: "review", wiseSessionId: "x" })).toEqual({ kind: "review", wiseSessionId: "x" });
    expect(drawerTargetFor({ id: "failed_post:x", kind: "failed_post", wiseSessionId: "x" })).toEqual({ kind: "failed_post", wiseSessionId: "x" });
    // The items of later PRs have no drawer yet.
    expect(drawerTargetFor({ id: "decision:x", kind: "decision", wiseSessionId: null })).toBeNull();
    expect(drawerTargetFor({ id: "expansion:next", kind: "expansion_ready", wiseSessionId: null })).toBeNull();
  });

  it("opens a class of the log by where it stands: a hold, a review, a failed post, or on its own", () => {
    expect(targetForClass(SESSION.chaiHeldJudge, dashboard, review)).toEqual({ kind: "hold", wiseSessionId: SESSION.chaiHeldJudge });
    expect(targetForClass(SESSION.annaToReview, dashboard, review)).toEqual({ kind: "review", wiseSessionId: SESSION.annaToReview });
    // Older than the log's own rows, and still reachable: the review data has it.
    expect(targetForClass(SESSION.benCritical, dashboard, review)).toEqual({ kind: "review", wiseSessionId: SESSION.benCritical });
    expect(targetForClass(SESSION.benFailed, dashboard, review)).toEqual({ kind: "failed_post", wiseSessionId: SESSION.benFailed });
    expect(targetForClass(SESSION.annaShadow, dashboard, review)).toEqual({ kind: "class", wiseSessionId: SESSION.annaShadow });
    // Without the review data a posted class opens on its own.
    expect(targetForClass(SESSION.annaToReview, dashboard, null)).toEqual({ kind: "class", wiseSessionId: SESSION.annaToReview });
    expect(targetForClass("unknown", dashboard, review)).toBeNull();
  });

  it("reads the item from the page's payloads, and says so when a reload no longer has it", () => {
    expect(resolveDrawer({ kind: "review", wiseSessionId: SESSION.annaToReview }, dashboard, review)).toMatchObject({ kind: "review", item: { tutorKey: "Anna" } });
    expect(resolveDrawer({ kind: "review", wiseSessionId: SESSION.annaToReview }, dashboard, null)).toEqual({ kind: "missing" });
    expect(resolveDrawer({ kind: "hold", wiseSessionId: SESSION.chaiHeldJudge }, dashboard, review)).toMatchObject({
      kind: "hold", hold: { tutorKey: "Chai", hasDraft: true }, row: { judgeUnsupported: ["finished the whole past paper"] },
    });
    expect(resolveDrawer({ kind: "hold", wiseSessionId: "gone" }, dashboard, review)).toEqual({ kind: "missing" });
    expect(resolveDrawer({ kind: "failed_post", wiseSessionId: SESSION.benFailed }, dashboard, review)).toMatchObject({ kind: "failed_post", reviewable: false });
    expect(resolveDrawer({ kind: "class", wiseSessionId: SESSION.annaShadow }, dashboard, review)).toMatchObject({ kind: "class", row: { state: "would_submit" } });
    // The class an incident is about opens from it, when the page holds that class.
    expect(resolveDrawer({ kind: "incident", incidentId: INCIDENT.critical }, dashboard, review)).toMatchObject({
      kind: "incident", about: { target: { kind: "review", wiseSessionId: SESSION.benCritical }, label: "Ben · Year 8 English · 29 Sep, 16:00" },
    });
    expect(resolveDrawer({ kind: "incident", incidentId: INCIDENT.acknowledged }, dashboard, review)).toMatchObject({ kind: "incident", about: null });
    expect(resolveDrawer({ kind: "incident", incidentId: INCIDENT.critical }, dashboard, null)).toEqual({ kind: "missing" });
  });
});

describe("ReviewBody", () => {
  it("gives Approve and Needs fix to the owner only; everyone else reads", () => {
    const item = correctedQueueItem();
    const viewer = renderToStaticMarkup(<ReviewBody item={item} canControl={false} onRecorded={() => undefined} />);
    const owner = renderToStaticMarkup(<ReviewBody item={item} canControl onRecorded={() => undefined} />);
    expect(viewer).not.toContain("verdict-controls");
    expect(viewer).not.toContain(">Approve<");
    expect(viewer).toContain("Only the owner records verdicts.");
    expect(owner).toContain("verdict-controls");
    expect(owner).toContain(">Approve<");
    expect(owner).toContain("Needs fix");
    expect(owner).not.toContain("Only the owner records verdicts.");
    // Both read the same detail, and can open the class in Wise.
    for (const html of [viewer, owner]) {
      expect(html).toContain("First shot");
      expect(html).toContain("first-shot-diff");
      expect(html).toContain("Open in Wise");
    }
  });
});

describe("HoldBody", () => {
  it("says why the class is held in plain words, how long is left, and what is stored", () => {
    const html = renderToStaticMarkup(<HoldBody hold={hold(SESSION.chaiHeldJudge)} row={row(SESSION.chaiHeldJudge)} now={NOW} />);
    expect(html).toContain("The judge found a claim the record does not support");
    expect(html).toContain(">Judge<");
    // Class of 5 Oct: due at the end of 7 Oct, 32 hours from 15:35 on the 6th.
    expect(html).toContain("Deadline in 32 h");
    expect(html).toContain("The class needs a person to write it before the deadline.");
    expect(html).toContain("7 Oct, 23:59");
    expect(html).toContain("5 Oct, 15:18");
    expect(html).toContain("Stored draft (not posted)");
    expect(html).toContain("Finished the whole past paper under timed conditions.");
    expect(html).toContain("The judge&#x27;s problems");
    expect(html).toContain("finished the whole past paper");
    expect(html).toContain("Open in Wise");
    // Nothing the owner can do here yet: the Retry button is the hold tracker's (PR 2).
    expect(html).not.toContain("<button");
  });

  it("colours the countdown by urgency, and says when nothing was emailed", () => {
    const tonight = renderToStaticMarkup(<HoldBody hold={hold(SESSION.benHeldRecording)} row={row(SESSION.benHeldRecording)} now={NOW} />);
    expect(tonight).toContain("Recording too short");
    expect(tonight).toContain("Data quality");
    expect(tonight).toMatch(/border-amber-200[^>]*>Deadline in 8 h</u);
    const passed = renderToStaticMarkup(<HoldBody hold={hold(SESSION.annaHeldAbsent)} row={row(SESSION.annaHeldAbsent)} now={NOW} />);
    expect(passed).toContain("The student&#x27;s attendance shows 0%");
    expect(passed).toMatch(/text-conflict[^>]*>Deadline passed 15 h ago</u);
    expect(passed).toContain("the feedback deadline has passed. The class still needs a person to write it.");
    expect(passed).not.toContain("before the deadline");
    const stale = renderToStaticMarkup(<HoldBody hold={hold(SESSION.emmaHeldStale)} row={null} now={NOW} />);
    expect(stale).toContain("Not emailed");
  });

  it("says a person wrote the class since, and that a stored draft is out of the page's reach", () => {
    const written = renderToStaticMarkup(<HoldBody hold={hold(SESSION.daoHeldWritten)} row={row(SESSION.daoHeldWritten)} now={NOW} />);
    expect(written).toContain("Written by a person since");
    expect(written).toContain("The class has feedback in Wise now, written by a person, so it no longer waits for anyone.");
    expect(written).not.toContain("Deadline in");
    const old = renderToStaticMarkup(<HoldBody hold={{ ...hold(SESSION.chaiHeldJudge), hasDraft: true }} row={null} now={NOW} />);
    expect(old).toContain("this page loads the text of recent classes only");
  });
});

describe("FailedPostBody and ClassBody", () => {
  it("says what happened to a failed post and shows what was sent", () => {
    const post = dashboard.failedPosts[0];
    const html = renderToStaticMarkup(<FailedPostBody post={post} row={row(post.wiseSessionId)} reviewable={false} />);
    expect(html).toContain("A post did not verify in Wise");
    expect(html).toContain("did not match what was sent");
    expect(html).toContain("Verify failed");
    expect(html).toContain("Text that was sent");
    expect(html).toContain("Rotations and reflections on the coordinate grid");
    expect(html).not.toContain("Open its review");
    const reviewable = renderToStaticMarkup(<FailedPostBody post={post} row={null} reviewable onOpen={() => undefined} />);
    expect(reviewable).toContain("Open its review");
  });

  it("shows any other class of the log with what is stored for it", () => {
    const shadow = renderToStaticMarkup(<ClassBody row={row(SESSION.annaShadow)!} />);
    expect(shadow).toContain("Shadow draft");
    expect(shadow).toContain("Stored draft (not posted)");
    expect(shadow).toContain("GPT-6.1 Sol · transcript");
    const waiting = renderToStaticMarkup(<ClassBody row={row(SESSION.daoWaiting)!} />);
    expect(waiting).toContain("Waiting for the recording");
    expect(waiting).toContain("No draft stored.");
    expect(waiting).toContain("transcript_first");
    // A post the review job has not recorded yet still shows its text.
    const posted = renderToStaticMarkup(<ClassBody row={row(SESSION.annaToReview)!} />);
    expect(posted).toContain("Text that was posted");
    expect(posted).toContain("1.2 h after the class");
    expect(posted).toContain("the review job records a new post within the hour");
  });
});

describe("IncidentBody", () => {
  it("offers Acknowledge on an unacknowledged critical incident to the owner only", () => {
    const open = resolveDrawer({ kind: "incident", incidentId: INCIDENT.critical }, dashboard, review);
    if (open.kind !== "incident") throw new Error("the fixture has this incident");
    const viewer = renderToStaticMarkup(<IncidentBody incident={open.incident} about={open.about} canControl={false} onAcknowledged={() => undefined} />);
    const owner = renderToStaticMarkup(<IncidentBody incident={open.incident} about={open.about} canControl onAcknowledged={() => undefined} onOpen={() => undefined} />);
    expect(viewer).not.toContain(">Acknowledge<");
    expect(viewer).toContain("Only the owner acknowledges incidents.");
    expect(owner.match(/>Acknowledge</gu)).toHaveLength(1);
    expect(owner).toContain("A critical error was found in a post");
    expect(owner).toContain("Critical verdict: Wrong person");
    expect(owner).toContain("push sent");
    expect(owner).toContain("Ben · Year 8 English · 29 Sep, 16:00");
    expect(owner).toContain("Open the class");
  });

  it("shows an acknowledged or an info incident without the button, and an alert that was not delivered", () => {
    const acknowledged = renderToStaticMarkup(<IncidentBody incident={incident(INCIDENT.acknowledged)} about={null} canControl onAcknowledged={() => undefined} />);
    expect(acknowledged).not.toContain(">Acknowledge<");
    expect(acknowledged).toContain("push FAILED — not delivered");
    expect(acknowledged).toContain("email: relay down");
    expect(acknowledged).toContain("acknowledged by owner@example.com");
    const info = renderToStaticMarkup(<IncidentBody incident={incident(INCIDENT.info)} about={null} canControl onAcknowledged={() => undefined} />);
    expect(info).not.toContain(">Acknowledge<");
    expect(info).toContain(">Info<");
    expect(info).not.toContain("push ");
  });
});
