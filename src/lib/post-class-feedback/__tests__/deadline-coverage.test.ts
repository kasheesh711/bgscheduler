/**
 * FU1 — the post-deadline assessment invariant behind the cron watchdog's
 * "Feedback Deadline Coverage" entry.
 *
 * An eligible class must be observed again after its feedback deadline, or a
 * late or short submission is never charged. The collector's deadline_crossed
 * lane does that work; this check proves it keeps up, and stays silent while
 * the collection cron itself is unscheduled.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const registry = vi.hoisted(() => ({ collectionUnscheduled: false }));

vi.mock("@/lib/data-health/cron-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data-health/cron-registry")>();
  return {
    ...actual,
    getCronJobDefinition: (key: string) => {
      const definition = actual.getCronJobDefinition(key);
      return registry.collectionUnscheduled && definition
        ? { ...definition, schedule: null }
        : definition;
    },
  };
});

import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import type { Database } from "@/lib/db";
import {
  classifyFeedbackDeadlineCoverage,
  FEEDBACK_DEADLINE_COVERAGE_THRESHOLD_HOURS,
  loadFeedbackDeadlineCoverage,
  POST_CLASS_COLLECTION_JOB_KEY,
} from "@/lib/post-class-feedback/deadline-coverage";

const NOW = new Date("2026-10-03T03:00:00.000Z");

/** The loader's one aggregate read: select -> from -> where. */
function fakeDb(rows: unknown[] | Error): Database {
  return {
    select: () => {
      if (rows instanceof Error) throw rows;
      return { from: () => ({ where: async () => rows }) };
    },
  } as unknown as Database;
}

describe("classifyFeedbackDeadlineCoverage", () => {
  it("flags any eligible session left unassessed past the threshold", () => {
    const result = classifyFeedbackDeadlineCoverage({
      overdueCount: 3,
      oldestDeadlineAt: new Date("2026-10-01T16:59:59.999Z"),
      thresholdHours: 12,
    });

    expect(result).toMatchObject({
      stale: true,
      overdueCount: 3,
      oldestDeadlineAt: new Date("2026-10-01T16:59:59.999Z"),
      thresholdHours: 12,
    });
    expect(result.detail).toContain("3");
    expect(result.detail).toContain("2026-10-01T16:59:59.999Z");
    expect(result.detail).toContain("12 h");
  });

  it("stays healthy when nothing is overdue", () => {
    const result = classifyFeedbackDeadlineCoverage({
      overdueCount: 0,
      oldestDeadlineAt: null,
      thresholdHours: 12,
    });

    expect(result).toMatchObject({ stale: false, overdueCount: 0, oldestDeadlineAt: null });
    expect(result.detail).toContain("12 h");
  });
});

describe("loadFeedbackDeadlineCoverage", () => {
  /**
   * Tripwire: the invariant is only armed while the collection cron is
   * scheduled; if the registry entry ever loses its schedule this flips.
   */
  it("speaks for the scheduled collection cron at a 12 h threshold", () => {
    expect(POST_CLASS_COLLECTION_JOB_KEY).toBe("post_class_feedback");
    expect(getCronJobDefinition(POST_CLASS_COLLECTION_JOB_KEY)?.schedule).toBe("13,43 * * * *");
    expect(FEEDBACK_DEADLINE_COVERAGE_THRESHOLD_HOURS).toBe(12);
  });

  it("stays silent without reading the database while the collection cron is unscheduled", async () => {
    registry.collectionUnscheduled = true;
    try {
      await expect(loadFeedbackDeadlineCoverage(fakeDb(new Error("loader reached the database")), NOW))
        .resolves.toBeNull();
    } finally {
      registry.collectionUnscheduled = false;
    }
  });

  it("propagates a database error", async () => {
    await expect(loadFeedbackDeadlineCoverage(fakeDb(new Error("coverage query failed")), NOW))
      .rejects.toThrow("coverage query failed");
  });

  it("treats a missing aggregate row as a failed read", async () => {
    await expect(loadFeedbackDeadlineCoverage(fakeDb([]), NOW))
      .rejects.toThrow(/no aggregate row/);
  });

  it("coerces the driver's string aggregates before classifying", async () => {
    const coverage = await loadFeedbackDeadlineCoverage(fakeDb([{
      overdueCount: "2",
      oldestDeadlineAt: "2026-10-01T16:59:59.999Z",
    }]), NOW);

    expect(coverage).toMatchObject({ stale: true, overdueCount: 2, thresholdHours: 12 });
    expect(coverage?.oldestDeadlineAt).toBeInstanceOf(Date);
    expect(coverage?.oldestDeadlineAt?.toISOString()).toBe("2026-10-01T16:59:59.999Z");
  });

  it("reports healthy coverage when the aggregate counts nothing", async () => {
    const coverage = await loadFeedbackDeadlineCoverage(fakeDb([{
      overdueCount: 0,
      oldestDeadlineAt: null,
    }]), NOW);

    expect(coverage).toMatchObject({ stale: false, overdueCount: 0, oldestDeadlineAt: null });
  });
});
