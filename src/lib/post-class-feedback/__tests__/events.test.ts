import { describe, expect, it } from "vitest";
import { toFeedbackEventEvidence, type PostClassActivityEventRow } from "../events";
import { deriveEventTimingEvidence, feedbackSubmitterRole } from "../policy";

/**
 * Payloads below are verbatim shapes returned by
 * `GET /institutes/{id}/events?eventName=SessionFeedbackSubmittedEvent`.
 * `payload.session` carries only `id` and, for auto-submissions,
 * `autoSubmitted` — no scheduled times and no submission id.
 */
function row(overrides: Partial<PostClassActivityEventRow> = {}): PostClassActivityEventRow {
  return {
    rowId: "row-1",
    eventId: "6a64e6263bee74fa9cfaa2a8",
    eventTimestamp: new Date("2026-07-25T16:36:54.315Z"),
    actorWiseUserId: "696e2c4343579bbada233f6b",
    actorName: "Chidchanok (Linn) Saetiaw Online",
    actorRole: "TEACHER",
    payload: {
      user: { id: "696e2c4343579bbada233f6b" },
      class: { id: "6a237b9333b96be1dd368761" },
      institute: { id: "696e1f4d90102225641cc413" },
      session: { id: "6a2e7700ee8bb3ed37766a10" },
    },
    ...overrides,
  };
}

describe("toFeedbackEventEvidence", () => {
  it("reads autoSubmitted from payload.session, the path Wise actually uses", () => {
    const evidence = toFeedbackEventEvidence("session-1", row({
      actorWiseUserId: null,
      actorName: null,
      actorRole: null,
      payload: {
        class: { id: "class-1" },
        institute: { id: "institute-1" },
        session: { id: "session-1", autoSubmitted: true },
      },
    }));
    expect(evidence.autoSubmitted).toBe(true);
    expect(feedbackSubmitterRole(evidence)).toBe("AUTO");
  });

  it("leaves autoSubmitted null for a human submission that omits the flag", () => {
    const evidence = toFeedbackEventEvidence("session-1", row());
    expect(evidence.autoSubmitted).toBeNull();
    expect(feedbackSubmitterRole(evidence)).toBe("TEACHER");
  });

  it("carries the Wise actor role through so admin submissions stay distinguishable", () => {
    const evidence = toFeedbackEventEvidence("session-1", row({ actorRole: "ADMIN" }));
    expect(evidence.actorRole).toBe("ADMIN");
    expect(feedbackSubmitterRole(evidence)).toBe("ADMIN");
  });

  it("reports no submission id, because Wise never sends one on these events", () => {
    expect(toFeedbackEventEvidence("session-1", row()).submissionId).toBeNull();
  });

  it("still honours the legacy root-level autoSubmitted fallback", () => {
    const evidence = toFeedbackEventEvidence("session-1", row({
      payload: { autoSubmitted: true, session: { id: "session-1" } },
    }));
    expect(evidence.autoSubmitted).toBe(true);
  });
});

describe("activity-event evidence end to end", () => {
  const deadlineAt = new Date("2026-07-27T16:59:59.999Z");
  const coverageFrom = new Date("2026-03-31T00:00:00.000Z");

  it("an auto-submitted event never proves the tutor met the deadline", () => {
    const events = [toFeedbackEventEvidence("session-1", row({
      actorRole: null,
      payload: { session: { id: "session-1", autoSubmitted: true } },
    }))];
    const timing = deriveEventTimingEvidence({ events, deadlineAt, eventCoverageFrom: coverageFrom });
    expect(timing.status).toBe("late");
    expect(timing.submitterRoles).toEqual(["AUTO"]);
  });

  it("a tutor event before the deadline proves on_time", () => {
    const events = [toFeedbackEventEvidence("session-1", row())];
    const timing = deriveEventTimingEvidence({ events, deadlineAt, eventCoverageFrom: coverageFrom });
    expect(timing.status).toBe("on_time");
    expect(timing.source).toBe("activity_event");
  });
});
