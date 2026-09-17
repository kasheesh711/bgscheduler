import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassAssignmentsWorkspace } from "../class-assignments-workspace";
import { canRetryPausedPublish } from "../publish-controls";

describe("classroom operations controls", () => {
  it("shows run, force reassign and publish only with server-provided owner access", () => {
    const owner = renderToStaticMarkup(<ClassAssignmentsWorkspace canOperate automationPaused />);
    const other = renderToStaticMarkup(<ClassAssignmentsWorkspace automationPaused />);
    for (const label of ["Sync Wise, then run", "Force reassign", "Publish to Wise"]) {
      expect(owner).toContain(label);
      expect(other).not.toContain(label);
    }
    for (const label of ["Refresh", "Email schedules", "Print day", "Print seven days"]) expect(other).toContain(label);
    expect(other).toContain("restricted to Kevin");
  });
  it("allows an explicit retry only after a pending job's cooldown, never during a running attempt", () => {
    const due = "2026-09-17T10:00:00Z", now = Date.parse(due);
    expect(canRetryPausedPublish({ status: "pending", nextAttemptAt: due }, now - 1)).toBe(false);
    expect(canRetryPausedPublish({ status: "pending", nextAttemptAt: due }, now)).toBe(true);
    expect(canRetryPausedPublish({ status: "running", nextAttemptAt: due }, now + 1)).toBe(false);
    expect(canRetryPausedPublish({ status: "pending" }, now)).toBe(false);
  });
});
