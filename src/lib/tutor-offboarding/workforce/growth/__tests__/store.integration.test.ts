import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { loadGrowthEvidence, reconcileGrowthLifecycleEvents, storeGrowthBookingMetadata } from "../store";
import type { GrowthBookingMetadata, GrowthLifecycleEvent } from "../types";
let h: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => { h = await startTestDb(); }, 60000);
afterAll(async () => { if (h) await stopTestDb(h); });
beforeEach(async () => { await truncateAll(h.db); });
const db = () => h.db as unknown as Database;
const metadata = (classification: GrowthBookingMetadata["classification"], time = "2026-10-01T03:00:00Z"): GrowthBookingMetadata => ({
  wiseSessionId: "class1", classification, sourceField: "purpose", sourceValue: classification,
  observedAt: time, completeness: "complete", reasonCodes: [],
});
const event = (overrides: Partial<GrowthLifecycleEvent> = {}): GrowthLifecycleEvent => ({
  eventKey: "s1:Maths:churn:2026-06-01", revision: 1, studentId: "s1", subject: "Maths", kind: "churn",
  lastTaughtAt: "2026-06-01T04:00:00Z", returnAt: null, effectiveMonth: "2026-07", confirmedAt: "2026-10-01T03:00:00Z",
  baselineMonths: ["2026-03", "2026-04", "2026-05"], baselineStudentHours: { value: 4, completeness: "complete", reasonCodes: [] },
  evidenceRevision: "source1", sourceSessionIds: ["class1"], status: "active", certainty: "observed", reasonCodes: [], ...overrides,
});
it("keeps classification corrections, skips replays and does not let an older import replace the current value", async () => {
  await storeGrowthBookingMetadata(db(), [metadata("trial")]);
  await storeGrowthBookingMetadata(db(), [metadata("trial")]);
  await storeGrowthBookingMetadata(db(), [metadata("regular", "2026-10-01T04:00:00Z")]);
  await storeGrowthBookingMetadata(db(), [metadata("pretest", "2026-09-01T03:00:00Z")]);
  const rows = await h.db.select().from(s.workforceBookingClassifications);
  expect(rows).toHaveLength(3);
  expect(rows.filter(r => r.isCurrent)).toHaveLength(1);
  expect(rows.find(r => r.isCurrent)?.payload).toMatchObject({ classification: "regular" });
});
it("reconciles lifecycle versions without duplicating a departure on refresh or erasing its original evidence", async () => {
  await reconcileGrowthLifecycleEvents(db(), [event()]);
  await reconcileGrowthLifecycleEvents(db(), [event({ evidenceRevision: "other-unrelated-source-change", confirmedAt: "2026-10-01T05:00:00Z" })]);
  expect(await h.db.select().from(s.workforceCourseLifecycleEvents)).toHaveLength(1);
  await reconcileGrowthLifecycleEvents(db(), [event({ baselineStudentHours: { value: 5, completeness: "complete", reasonCodes: [] } })]);
  const rows = await h.db.select().from(s.workforceCourseLifecycleEvents);
  expect(rows).toHaveLength(2);
  expect(rows.filter(r => r.isCurrent)).toHaveLength(1);
  expect(rows.find(r => !r.isCurrent)?.payload).toMatchObject({ baselineStudentHours: { value: 4 } });
});
it("supports explicit supersession and changes report revision with mapping revisions", async () => {
  await reconcileGrowthLifecycleEvents(db(), [event()]);
  await reconcileGrowthLifecycleEvents(db(), [event({ status: "superseded", reasonCodes: ["SOURCE_CORRECTION"] })]);
  const before = await loadGrowthEvidence(db(), new Date("2026-10-02T03:00:00Z"));
  expect(before.lifecycleEvents).toHaveLength(1);
  expect(before.lifecycleEvents[0].status).toBe("superseded");
  await h.db.insert(s.workforceSubjectMappings).values({ sourceValue: "Maths", subject: "Maths", revision: 1, reviewedBy: "test", reviewedAt: new Date() });
  const after = await loadGrowthEvidence(db(), new Date("2026-10-02T03:00:00Z"));
  expect(after.revision).not.toBe(before.revision);
});
