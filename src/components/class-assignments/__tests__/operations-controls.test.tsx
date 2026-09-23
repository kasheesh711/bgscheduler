import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassAssignmentsWorkspace } from "../class-assignments-workspace";
import { canRetryPausedPublish, isPublishActionDisabled } from "../publish-controls";

describe("classroom operations controls", () => {
  it("gives the owner Run, Publish and Force reassign", () => {
    const markup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun canForceReassign />);

    expect(markup).toContain("Sync Wise, then run");
    expect(markup).toContain("Publish to Wise");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("Force reassign");
  });

  it("gives an ordinary admin Run and Publish but not Force reassign, and notes it is Kevin-only", () => {
    const markup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun />);

    expect(markup).toContain("Sync Wise, then run");
    expect(markup).toContain("Publish to Wise");
    // No checkbox at all: Force reassign is the only checkbox rendered before any run data loads.
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain("Force reassign is restricted to Kevin");
  });

  it("gives a viewer none of Run, Publish or Force reassign, but keeps read-only controls", () => {
    const markup = renderToStaticMarkup(<ClassAssignmentsWorkspace />);

    expect(markup).not.toContain("Sync Wise, then run");
    expect(markup).not.toContain("Publish to Wise");
    expect(markup).not.toContain('type="checkbox"');
    for (const label of ["Refresh", "Email schedules", "Print day", "Print seven days"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("require admin access");
  });

  it("tells an ordinary admin automation is paused for publish/sync, but not the owner", () => {
    const adminMarkup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun automationPaused />);
    const ownerMarkup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun canForceReassign automationPaused />);

    expect(adminMarkup).toContain("only Kevin can publish or sync while paused");
    expect(ownerMarkup).not.toContain("only Kevin can publish or sync while paused");
  });

  it("disables Run and Publish (with a matching paused tooltip) for an ordinary admin while automation is paused", () => {
    const markup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun automationPaused />);

    // Both toolbar buttons carry the same paused title, and thus the same disabled condition.
    const pausedTitleMatches = markup.match(/title="Automation is paused — only Kevin can publish or sync while paused\."/g) ?? [];
    expect(pausedTitleMatches).toHaveLength(2);
  });

  it("does not disable Run and Publish for the owner while automation is paused", () => {
    const markup = renderToStaticMarkup(<ClassAssignmentsWorkspace canPublishAndRun canForceReassign automationPaused />);

    expect(markup).not.toContain("Automation is paused");
  });

  it("allows an explicit retry only after a pending job's cooldown, never during a running attempt", () => {
    const due = "2026-09-17T10:00:00Z", now = Date.parse(due);
    expect(canRetryPausedPublish({ status: "pending", nextAttemptAt: due }, now - 1)).toBe(false);
    expect(canRetryPausedPublish({ status: "pending", nextAttemptAt: due }, now)).toBe(true);
    expect(canRetryPausedPublish({ status: "running", nextAttemptAt: due }, now + 1)).toBe(false);
    expect(canRetryPausedPublish({ status: "pending" }, now)).toBe(false);
  });

  describe("isPublishActionDisabled", () => {
    it("disables while publishing or with no eligible rows", () => {
      expect(isPublishActionDisabled({ hasEligibleRows: false, publishing: false, progress: null, automationPaused: false, now: 0 })).toBe(true);
      expect(isPublishActionDisabled({ hasEligibleRows: true, publishing: true, progress: null, automationPaused: false, now: 0 })).toBe(true);
    });

    it("enables with eligible rows, not publishing, and no in-flight job", () => {
      expect(isPublishActionDisabled({ hasEligibleRows: true, publishing: false, progress: null, automationPaused: false, now: 0 })).toBe(false);
    });

    it("disables while a non-terminal job is in flight", () => {
      expect(isPublishActionDisabled({
        hasEligibleRows: true, publishing: false,
        progress: { status: "running", nextAttemptAt: null },
        automationPaused: false, now: 0,
      })).toBe(true);
    });

    it("re-enables a paused job once automation is paused and its cooldown has elapsed", () => {
      const due = "2026-09-17T10:00:00Z", now = Date.parse(due);
      expect(isPublishActionDisabled({
        hasEligibleRows: true, publishing: false,
        progress: { status: "pending", nextAttemptAt: due },
        automationPaused: true, now,
      })).toBe(false);
      expect(isPublishActionDisabled({
        hasEligibleRows: true, publishing: false,
        progress: { status: "pending", nextAttemptAt: due },
        automationPaused: true, now: now - 1,
      })).toBe(true);
    });

    it("stays disabled for a pending job when automation is not paused", () => {
      const due = "2026-09-17T10:00:00Z", now = Date.parse(due);
      expect(isPublishActionDisabled({
        hasEligibleRows: true, publishing: false,
        progress: { status: "pending", nextAttemptAt: due },
        automationPaused: false, now,
      })).toBe(true);
    });

    it("enables once the job reaches a terminal status", () => {
      expect(isPublishActionDisabled({
        hasEligibleRows: true, publishing: false,
        progress: { status: "succeeded", nextAttemptAt: null },
        automationPaused: false, now: 0,
      })).toBe(false);
    });
  });
});
