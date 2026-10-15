import { describe, expect, it } from "vitest";
import { assertCaptureBinding, captureConflict, captureTiming, screenshotMime, submissionDuringCapture } from "../capture-model";

const deadline = new Date("2026-10-12T16:59:59.999Z");
describe("Wise screenshot evidence", () => {
  it("warns for staff feedback during capture without rejecting the earlier observation", () => {
    const observed = new Date("2026-10-12T17:00:00Z"), captured = new Date("2026-10-12T17:00:02Z");
    const event = { actorRole: "TEACHER", autoSubmitted: false, eventTimestamp: captured };
    expect(captureConflict("missing", observed, [event])).toBe(false);
    expect(submissionDuringCapture("missing", observed, captured, [event])).toBe(true);
    for (const patch of [{ actorRole: "STUDENT" }, { autoSubmitted: true }, { eventTimestamp: observed }, { eventTimestamp: new Date(captured.getTime() + 1) }]) {
      expect(submissionDuringCapture("missing", observed, captured, [{ ...event, ...patch }])).toBe(false);
    }
  });
  it("keeps a capture after the deadline separate from a later check", () => {
    expect(captureTiming(deadline, new Date("2026-10-12T17:00:00Z"), "deadline")).toBe("within_window");
    expect(captureTiming(deadline, new Date("2026-10-12T17:15:00Z"), "deadline")).toBe("within_window");
    expect(captureTiming(deadline, new Date("2026-10-12T17:15:00.001Z"), "deadline")).toBe("late");
    expect(captureTiming(deadline, new Date("2026-10-12T17:00:00Z"), "current")).toBe("later_check");
    expect(() => captureTiming(deadline, new Date("2026-10-12T16:59:00Z"), "deadline")).toThrow();
  });
  it("rejects a different tutor, class, student, subject or deadline", () => {
    const expected = { wiseSessionId: "wise-1", tutorKey: "tutor-1", tutorName: "Tutor One", students: ["Student One"], subject: "Maths", deadlineAt: deadline.toISOString() };
    expect(() => assertCaptureBinding(expected, expected)).not.toThrow();
    for (const patch of [{ tutorKey: "other" }, { tutorName: "Other" }, { wiseSessionId: "wise-2" }, { students: ["Other"] }, { subject: "Science" }, { deadlineAt: "2026-10-13T16:59:59.999Z" }]) {
      expect(() => assertCaptureBinding(expected, { ...expected, ...patch })).toThrow();
    }
  });
  it("does not use student or automatic feedback as staff proof", () => {
    const at = new Date("2026-10-12T17:00:00Z");
    const events = [{ actorRole: "STUDENT", autoSubmitted: false, eventTimestamp: deadline }, { actorRole: "TEACHER", autoSubmitted: true, eventTimestamp: deadline }];
    expect(captureConflict("missing", at, events)).toBe(false);
    expect(captureConflict("missing", at, [...events, { actorRole: "ADMIN", autoSubmitted: false, eventTimestamp: deadline }])).toBe(true);
    expect(captureConflict("missing", at, [{ actorRole: "TEACHER", autoSubmitted: false, eventTimestamp: new Date(at.getTime() + 1) }])).toBe(false);
  });
  it("checks image bytes and size, not only the file name", () => {
    expect(screenshotMime(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
    expect(() => screenshotMime(Buffer.from("<html>"))).toThrow();
    expect(() => screenshotMime(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow();
  });
});
