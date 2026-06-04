import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataHealthDashboard } from "../data-health-dashboard";
import type { DataHealthDashboardPayload } from "@/lib/data-health/types";

function payload(overrides: Partial<DataHealthDashboardPayload> = {}): DataHealthDashboardPayload {
  return {
    checkedAt: "2026-06-01T00:00:00.000Z",
    overall: {
      status: "late",
      headline: "One or more crons are late",
      detail: "5 healthy, 1 late, 0 failing, 0 running, 1 manual-only.",
      healthyCount: 5,
      lateCount: 1,
      failingCount: 0,
      runningCount: 0,
      unknownCount: 0,
      manualOnlyCount: 1,
    },
    cronJobs: [
      {
        key: "wise_snapshot",
        label: "Wise Snapshot",
        feature: "Tutor Search",
        path: "/api/internal/sync-wise",
        schedule: "*/30 * * * *",
        cadenceLabel: "Every 30 min",
        maxDurationSeconds: 800,
        manualOnly: false,
        dangerous: false,
        status: "healthy",
        proof: "direct",
        proofLabel: "Direct cron audit",
        lastSeenAt: "2026-06-01T00:00:00.000Z",
        lastSuccessAt: "2026-06-01T00:04:00.000Z",
        lastFailureAt: null,
        nextExpectedAt: "2026-06-01T00:30:00.000Z",
        lastExpectedAt: "2026-06-01T00:00:00.000Z",
        lateAfterAt: "2026-06-01T00:45:00.000Z",
        durationMs: 240000,
        responseStatus: 200,
        errorSummary: null,
        healthDetail: "Cron audit confirms this route fired recently.",
        latestInvocation: null,
        recentInvocations: [],
        canRunManually: true,
      },
      {
        key: "room_utilization",
        label: "Room Utilization",
        feature: "Room Capacity",
        path: "/api/internal/sync-room-utilization",
        schedule: null,
        cadenceLabel: "Manual only",
        maxDurationSeconds: 800,
        manualOnly: true,
        dangerous: false,
        status: "manual-only",
        proof: "none",
        proofLabel: "No automatic schedule",
        lastSeenAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        nextExpectedAt: null,
        lastExpectedAt: null,
        lateAfterAt: null,
        durationMs: null,
        responseStatus: null,
        errorSummary: null,
        healthDetail: "Not listed in vercel.json; runs only from manual controls.",
        latestInvocation: null,
        recentInvocations: [],
        canRunManually: true,
      },
    ],
    dataDomains: [
      {
        key: "wise_snapshot",
        label: "Tutor Snapshot",
        status: "healthy",
        freshnessLabel: "Just now",
        lastSuccessAt: "2026-06-01T00:04:00.000Z",
        lastRunAt: "2026-06-01T00:00:00.000Z",
        recordCountLabel: "140 teachers",
        issueCount: 2,
        detail: "Primary search and compare source of truth.",
      },
    ],
    wiseSnapshot: {
      activeSnapshotId: "snapshot-123456",
      lastSuccessfulSync: "2026-06-01T00:04:00.000Z",
      lastFailedSync: null,
      lastFailureError: null,
      staleAgeMs: 0,
      staleMinutes: 0,
      stats: {
        totalWiseTeachers: 140,
        totalIdentityGroups: 72,
        resolvedGroups: 70,
        unresolvedGroups: 2,
        totalDataIssues: 3,
        totalFutureSessions: 1200,
      },
    },
    issueSummary: { alias: 1, modality: 1, tag: 1 },
    issueDetails: {
      unresolvedAliases: [{ entityName: "Kev", message: "Unresolved alias" }],
      unresolvedModality: [{ entityName: "Session 1", message: "Contradiction", issueType: "conflict_model" }],
      unmappedTags: [{ entityName: "Biology", message: "Unmapped tag" }],
    },
    recentRuns: [
      {
        id: "run-1",
        jobKey: "wise_snapshot",
        label: "Wise Snapshot",
        status: "success",
        startedAt: "2026-06-01T00:00:00.000Z",
        finishedAt: "2026-06-01T00:04:00.000Z",
        durationMs: 240000,
        triggerType: null,
        countLabel: "140 teachers",
        errorSummary: null,
      },
    ],
    manualActions: [
      { key: "wise_snapshot", label: "Wise Snapshot", dangerous: false, confirmationLabel: null },
      { key: "classroom_morning", label: "Classroom Morning", dangerous: true, confirmationLabel: "Publishes rooms" },
    ],
    lastSuccessfulSync: "2026-06-01T00:04:00.000Z",
    lastFailedSync: null,
    lastFailureError: null,
    staleAgeMs: 0,
    staleMinutes: 0,
    activeSnapshotId: "snapshot-123456",
    stats: null,
    issuesByType: { alias: 1, modality: 1, tag: 1 },
    unresolvedAliases: [],
    unresolvedModality: [],
    unmappedTags: [],
    recentSyncs: [],
    ...overrides,
  };
}

describe("DataHealthDashboard", () => {
  it("renders ops command sections and cron proof labels", () => {
    const html = renderToStaticMarkup(<DataHealthDashboard initialData={payload()} />);

    expect(html).toContain("Data Health");
    expect(html).toContain("Next expected cron");
    expect(html).toContain("Manual controls");
    expect(html).toContain("Cron control plane");
    expect(html).toContain("Wise snapshot fidelity");
    expect(html).toContain("Unified run history");
    expect(html).toContain("Direct audit");
    expect(html).toContain("Room Utilization");
    expect(html).toContain("manual only");
  });
});
