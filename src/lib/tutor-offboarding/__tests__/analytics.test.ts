import { describe, expect, it } from "vitest";
import {
  compileAnalyticsEvidence,
  buildTutorOffboardingAnalytics,
} from "../analytics";
import type { AnalyticsSession } from "../analytics-types";
import type { PersonSignals, OffboardingSignals } from "../types";
const NOW = new Date("2026-10-01T05:00:00Z");
const person = (key: string, relation = "TEACHER"): PersonSignals => ({
  canonicalKey: key,
  displayName: key,
  accounts: [
    {
      wiseTeacherId: key,
      wiseUserId: key,
      displayName: `${key} Tutor`,
      email: `${key}@example.com`,
      isOnlineVariant: false,
      status: "active",
      relation,
      joinedOn: "2025-01-01T00:00:00Z",
      courseCount: 0,
      activated: true,
      availabilityKnown: true,
      workingHourWindows: 0,
    },
  ],
  lastTaughtAt: "2026-03-01T03:00:00Z",
  lastTaughtBySource: { ledger: null, pastBlocks: null, postClass: null },
  upcomingSessions: 0,
  nextSessionAt: null,
  upcomingLeaveUntil: null,
  lastTeacherActionAt: null,
  lastAdminActionAt: null,
  fullTime: false,
});
const session = (
  id: string,
  key: string | null,
  date = "2026-03-01T03:00:00Z",
  course: string | null = "course",
): AnalyticsSession => ({
  wiseSessionId: id,
  canonicalKey: key,
  wiseClassId: course,
  title: "English",
  wiseCourseCategory: "Y2-8",
  startAt: date,
  endAt: null,
});
function report(
  history: AnalyticsSession[] = [],
  upcoming: AnalyticsSession[] = [],
  people = [person("A"), person("B"), person("Staff", "ADMIN")],
) {
  const signals: OffboardingSignals = {
    snapshotId: "snapshot",
    snapshotCreatedAt: NOW.toISOString(),
    generatedAt: NOW.toISOString(),
    people,
    taughtDates: {},
  };
  const evidence = compileAnalyticsEvidence({
    signals,
    catalog: people,
    qualifications: [
      {
        canonicalKey: "A",
        subject: "English",
        curriculum: "International",
        level: "Y2-8",
        examPrep: null,
      },
      {
        canonicalKey: "A",
        subject: "English",
        curriculum: "International",
        level: "Y2-8",
        examPrep: null,
      },
      {
        canonicalKey: "Staff",
        subject: "English",
        curriculum: "International",
        level: "Y2-8",
        examPrep: null,
      },
    ],
    history,
    upcoming,
  });
  return buildTutorOffboardingAnalytics({
    evidence,
    feeds: {
      tutorSnapshot: NOW.toISOString(),
      progressTests: NOW.toISOString(),
      postClass: NOW.toISOString(),
      wiseActivity: NOW.toISOString(),
      leaveRequests: NOW.toISOString(),
    },
    decisions: [],
    terminationSnapshot: {
      rows: [
        {
          sourceRow: 2,
          fullName: "A Tutor",
          wiseName: "A Tutor",
          nickname: "A",
          emails: ["A@example.com"],
          terminated: true,
        },
      ],
      checkedAt: NOW.toISOString(),
      lastError: null,
    },
    now: NOW,
  });
}
describe("read-only tutor analytics", () => {
  it("deduplicates people, sessions across sources/students, capabilities and overlapping departure scenarios", () => {
    const r = report([
      session("s1", "A"),
      session("s1", "A"),
      session("s2", "B"),
      session("s3", "Staff"),
    ]);
    expect(r.turnover).toMatchObject({
      actualRate: null,
      denominator: 2,
      markedNumerator: 1,
      markedShare: 50,
      markedAndInferredNumerator: 2,
      markedAndInferredShare: 100,
    });
    expect(r.monthly[0]).toMatchObject({
      month: "2026-03",
      teachingPeople: 2,
      endedSessions: 2,
      partial: false,
    });
    expect(r.monthly.at(-1)).toMatchObject({ month: "2026-10", partial: true });
    expect(r.coverage[0].currentPeople).toEqual(["A"]);
    expect(r.coverage[0].remainingAfterMarked).toEqual([]);
    expect(r.totals.missingQualifications).toBe(1);
    expect(
      r.people.find((p) => p.canonicalKey === "B")?.capabilitiesKnown,
    ).toBe(false);
  });
  it("keeps marked tutors with future classes pending and separates next30days from distant classes", () => {
    const p = person("A");
    p.upcomingSessions = 2;
    const r = report(
      [session("history", "A")],
      [
        session("soon", "A", "2026-10-02T03:00:00Z"),
        session("far", "A", "2028-01-01T03:00:00Z"),
      ],
      [p],
    );
    expect(r.people[0]).toMatchObject({
      category: "marked_pending_classes",
      upcomingSessions30Days: 1,
      upcomingSessionsAllTime: 2,
    });
    expect(r.courses[0]).toMatchObject({
      upcomingSessions30Days: 1,
      upcomingSessionsAllTime: 2,
      endedSessionsSinceMarch: 1,
      wiseCourseCategory: "Y2-8",
    });
    expect(r.futureHorizonEnd).toBe("2028-01-01T03:00:00Z");
  });
  it("excludes conflicting teacher assignments and distinguishes missing course IDs", () => {
    const r = report(
      [
        session("conflict", "A"),
        session("conflict", "B"),
        session("unknown", null),
      ],
      [
        session("missing1", "A", "2026-10-02T03:00:00Z", null),
        session("missing2", "A", "2026-10-03T03:00:00Z", null),
      ],
    );
    expect(r.turnover.markedShare).toBeNull();
    expect(r.totals.conflictingSessionAssignments).toBe(1);
    expect(r.totals.unresolvedHistoricalSessions).toBe(2);
    expect(r.totals.missingFutureCourseIds).toBe(2);
    expect(r.courses.filter((c) => c.wiseClassId === null)).toHaveLength(2);
  });
  it("includes off-roster teaching history and enriches missing course metadata across sources", () => {
    const r = report([
      {
        ...session("s1", "Former"),
        wiseClassId: null,
        title: null,
        wiseCourseCategory: null,
      },
      session("s1", "Former"),
    ]);
    expect(r.totals.historicalOffRosterPeople).toBe(1);
    expect(r.people.find((p) => p.canonicalKey === "Former")).toMatchObject({
      currentRoster: false,
      taughtSinceMarch: true,
    });
    expect(r.turnover.denominator).toBe(1);
  });
  it("counts only departure-cohort future assignments on historically shared courses", () => {
    const retained = person("B");
    retained.lastTaughtAt = NOW.toISOString();
    const r = report(
      [session("history", "A")],
      [
        session("retained-future", "B", "2026-10-02T03:00:00Z"),
        session("marked-future", "A", "2026-10-03T03:00:00Z"),
      ],
      [person("A"), retained],
    );
    expect(r.courses[0]).toMatchObject({
      upcomingSessions30Days: 1,
      upcomingSessionsAllTime: 1,
      markedUpcomingSessions30Days: 1,
      inferredUpcomingSessions30Days: 0,
      otherHistoricalPeople: [],
    });
    const historicalOnly = report(
      [session("history", "A")],
      [session("retained-future", "B", "2026-10-02T03:00:00Z")],
      [person("A"), retained],
    );
    expect(historicalOnly.courses[0].upcomingSessionsAllTime).toBe(0);
  });
  it("preserves marked evidence on staff while excluding staff from tutor metrics", () => {
    const r = report([session("staff", "A")], [], [person("A", "ADMIN")]);
    expect(r.people[0]).toMatchObject({ marked: true, category: "staff" });
    expect(r.turnover.denominator).toBe(0);
    expect(r.totals.markedTutors).toBe(0);
  });
});
