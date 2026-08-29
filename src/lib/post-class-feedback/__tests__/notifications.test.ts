import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  buildPostClassAdminDigestContent,
  buildPostClassNotificationKey,
  classifyPostClassReminderMembership,
  planPostClassReminderMemberships,
  postClassAdminDigestSince,
  postClassRemindersEnabledForState,
  postClassSenderKeyForAttempt,
  resolvePostClassTutorRecipient,
  safePostClassWiseSessionUrl,
  shouldRecoverPostClassSendingAttempt,
  summarizePostClassDigestDeductions,
  summarizePostClassNotificationRun,
} from "@/lib/post-class-feedback/notifications";

describe("post-class notification lifecycle", () => {
  const membership = (overrides: Partial<Parameters<
    typeof classifyPostClassReminderMembership
  >[0]> = {}) => classifyPostClassReminderMembership({
    eligible: true,
    enforcementMode: "live",
    sourceStatus: "ready",
    assessmentSourceStatus: "ready",
    policyApplies: true,
    adjustedCompliant: false,
    requiredFieldsPassed: false,
    combinedRawCharCount: 120,
    lastObservedAt: new Date("2026-07-21T01:55:00.000Z"),
    freshAfter: new Date("2026-07-21T01:40:00.000Z"),
    ...overrides,
  });

  it("keeps a retry-scheduled failure active instead of reporting a terminal failure", () => {
    const summary = summarizePostClassNotificationRun([{
      status: "failed",
      attemptCount: 1,
      nextAttemptAt: new Date("2026-07-21T03:30:00.000Z"),
    }]);

    expect(summary).toMatchObject({
      active: true,
      status: "sending",
      failed: 0,
    });
  });

  it("reports a failure only after retries are exhausted", () => {
    const summary = summarizePostClassNotificationRun([{
      status: "failed",
      attemptCount: 4,
      nextAttemptAt: null,
    }]);

    expect(summary).toMatchObject({
      active: false,
      status: "failed",
      failed: 1,
    });
  });

  it("stops queued reminders when enforcement is paused", () => {
    expect(postClassRemindersEnabledForState({
      mode: "paused",
      mappingValid: true,
      hasBlockingGlobalIssue: false,
    })).toBe(false);
  });

  it("defers stale-only and mixed fresh/stale grouped reminder memberships", () => {
    const stale = membership({
      lastObservedAt: new Date("2026-07-21T01:39:59.000Z"),
    });
    const active = membership();
    expect(stale).toBe("stale");
    expect(active).toBe("active");
    expect(planPostClassReminderMemberships([stale])).toEqual({
      disposition: "defer",
      activeIndexes: [],
    });
    expect(planPostClassReminderMemberships([active, stale])).toEqual({
      disposition: "defer",
      activeIndexes: [],
    });
  });

  it("keeps a source-ready not-due incomplete session active for both reminder checkpoints", () => {
    // The persisted assessment denominator flag is false before 23:59, but
    // sourceStatus remains ready and is the correct reminder evidence gate.
    const notDueIncomplete = membership({
      assessmentSourceStatus: "ready",
      adjustedCompliant: false,
      requiredFieldsPassed: false,
      combinedRawCharCount: 0,
    });
    expect(notDueIncomplete).toBe("active");
    expect(planPostClassReminderMemberships([
      notDueIncomplete,
    ])).toEqual({ disposition: "send", activeIndexes: [0] });
  });

  it("does not remind a class with empty fields but 300+ combined characters", () => {
    // Char-count-only bar (2026-08-29): field emptiness is informational.
    const emptyFieldButLong = membership({
      requiredFieldsPassed: false,
      combinedRawCharCount: 470,
      contentViolationReasons: [],
    });
    expect(emptyFieldButLong).toBe("inactive");
  });

  it("keeps reminding an all-placeholder class even past 300 characters", () => {
    const placeholderOnly = membership({
      requiredFieldsPassed: false,
      combinedRawCharCount: 350,
      contentViolationReasons: ["all_fields_placeholder"],
    });
    expect(placeholderOnly).toBe("active");
  });

  it("cancels retries after late content remediation without erasing the violation", () => {
    const remediatedLate = membership({
      adjustedCompliant: false,
      requiredFieldsPassed: true,
      combinedRawCharCount: 300,
    });
    expect(remediatedLate).toBe("inactive");
    expect(planPostClassReminderMemberships([remediatedLate])).toEqual({
      disposition: "cancel",
      activeIndexes: [],
    });
  });

  it("uses the prior successful digest cutoff or exactly 24 hours as fallback", () => {
    const now = new Date("2026-07-21T01:00:00.000Z");
    const priorScheduledFor = new Date("2026-07-20T01:00:00.000Z");
    expect(postClassAdminDigestSince(now, priorScheduledFor)).toBe(priorScheduledFor);
    expect(postClassAdminDigestSince(now, null)).toEqual(
      new Date("2026-07-20T01:00:00.000Z"),
    );
  });

  it("counts new violations by creation time regardless of their reviewed status", () => {
    const since = new Date("2026-07-20T01:00:00.000Z");
    expect(summarizePostClassDigestDeductions([
      { status: "approved", createdAt: since },
      { status: "waived", createdAt: new Date("2026-07-20T02:00:00.000Z") },
      { status: "pending_review", createdAt: new Date("2026-07-20T03:00:00.000Z") },
      { status: "pending_review", createdAt: new Date("2026-07-19T03:00:00.000Z") },
      { status: "processed", createdAt: new Date("2026-07-19T04:00:00.000Z") },
    ], since)).toEqual({
      newViolations: 3,
      pendingDeductions: 2,
    });
  });

  it("reports exact digest totals while retaining capped issue samples", () => {
    const digest = buildPostClassAdminDigestContent({
      newViolations: 2,
      pendingDeductions: 3,
      pendingAiReviews: 4,
      sourceIssueCount: 13,
      sourceIssueSamples: Array.from({ length: 12 }, (_, index) => ({
        message: `Sample issue ${index + 1}`,
      })),
      reminderFailureCount: 26,
      unresolvedRecipients: [],
    });

    expect(digest.counts).toMatchObject({ sourceIssues: 13, reminderFailures: 26 });
    expect(digest.metadata.counts).toMatchObject({ sourceIssues: 13, reminderFailures: 26 });
    expect(digest.text).toContain("Open source/form issues: 13");
    expect(digest.text).toContain("Final reminder failures: 26");
    expect(digest.html).toContain("Open source/form issues: 13");
    expect(digest.html).toContain("Final reminder failures: 26");
    expect(digest.text.match(/^- Sample issue /gmu)).toHaveLength(12);
    expect(digest.html.match(/<li>Sample issue /gu)).toHaveLength(12);
  });

  it("stops queued reminders for form drift or a blocking source issue", () => {
    expect(postClassRemindersEnabledForState({
      mode: "live",
      mappingValid: false,
      hasBlockingGlobalIssue: false,
    })).toBe(false);
    expect(postClassRemindersEnabledForState({
      mode: "live",
      mappingValid: true,
      hasBlockingGlobalIssue: true,
    })).toBe(false);
  });

  it("uses the primary relay once and the backup relay for all retries", () => {
    expect(postClassSenderKeyForAttempt(1)).toBe("primary");
    expect([2, 3, 4].map(postClassSenderKeyForAttempt)).toEqual([
      "backup",
      "backup",
      "backup",
    ]);
  });

  it("recovers an ambiguous stale send on the same durable attempt", () => {
    const now = new Date("2026-07-21T04:00:00.000Z");
    expect(shouldRecoverPostClassSendingAttempt({
      status: "sending",
      updatedAt: new Date("2026-07-21T03:39:59.000Z"),
      now,
    })).toBe(true);
    expect(shouldRecoverPostClassSendingAttempt({
      status: "sending",
      updatedAt: new Date("2026-07-21T03:45:00.000Z"),
      now,
    })).toBe(false);
  });

  it("hashes overlong provider keys so distinct tutor identities cannot collide", () => {
    const sharedPrefix = "x".repeat(300);
    const first = buildPostClassNotificationKey(["tutor_deadline", sharedPrefix, "a"]);
    const second = buildPostClassNotificationKey(["tutor_deadline", sharedPrefix, "b"]);
    expect(first).toHaveLength(250);
    expect(second).toHaveLength(250);
    expect(first).not.toBe(second);
  });

  it("allows only HTTPS Wise hosts in emailed session links", () => {
    const fallback = "https://app.wise.live/classes/class-1/sessions/session-1";
    expect(safePostClassWiseSessionUrl({
      configuredUrl: "https://app.wise.live/classes/class-1/sessions/session-1?tab=feedback",
      wiseClassId: "class-1",
      wiseSessionId: "session-1",
    })).toContain("app.wise.live");
    expect(safePostClassWiseSessionUrl({
      configuredUrl: "javascript:alert(1)",
      wiseClassId: "class-1",
      wiseSessionId: "session-1",
    })).toBe(fallback);
    expect(safePostClassWiseSessionUrl({
      configuredUrl: "https://wise.live.evil.example/session",
      wiseClassId: "class-1",
      wiseSessionId: "session-1",
    })).toBe(fallback);
  });

  it("prefers a primary email and rejects ambiguous Wise addresses", () => {
    expect(resolvePostClassTutorRecipient({
      primaryEmail: " Primary@Example.com ",
      onsiteEmail: "onsite@example.com",
      onlineEmail: "online@example.com",
    })).toEqual({ email: "primary@example.com", source: "primary" });
    expect(resolvePostClassTutorRecipient({
      primaryEmail: null,
      onsiteEmail: "onsite@example.com",
      onlineEmail: "online@example.com",
    })).toEqual({ email: null, source: "conflict" });
  });
});
