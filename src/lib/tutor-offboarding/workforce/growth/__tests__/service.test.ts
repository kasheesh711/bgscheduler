import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import type { GrowthEvidence, GrowthFlows, GrowthForecast, GrowthMonthlyRow, GrowthQuery } from "../types";
vi.mock("server-only", () => ({}));
vi.mock("../flows", () => ({ buildAllGrowthFlows: vi.fn() }));
vi.mock("../forecast", () => ({ buildGrowthForecast: vi.fn(), selectGrowthFlows: vi.fn((flows) => flows) }));
vi.mock("../store", () => ({ loadGrowthEvidence: vi.fn(), reconcileGrowthLifecycleEvents: vi.fn(), storeGrowthBookingMetadata: vi.fn() }));
import { buildAllGrowthFlows } from "../flows";
import { buildGrowthForecast } from "../forecast";
import { loadGrowthEvidence, reconcileGrowthLifecycleEvents, storeGrowthBookingMetadata } from "../store";
import { buildGrowthReport, getGrowthDrilldown, getGrowthReport } from "../service";

const db = {} as Database, now = new Date("2026-10-01T05:00:00Z");
const query: GrowthQuery = { filters: { from: "2026-03-01", to: "2026-10-01", viewMonth: "2026-09", role: "all", modality: "all" }, assumptions: { bufferPercent: 0 } };
const m = { value: 1, completeness: "complete" as const, reasonCodes: [] };
const row: GrowthMonthlyRow = { key: "math-sep", courseKey: "math", subject: "Maths", curriculum: null, level: null, month: "2026-09", newlyObservedStudents: m, reactivatedStudents: m, churnedStudents: m, newStudentHours: m, reactivatedStudentHours: m, churnStudentHours: m, bookedStudentHours: m, creditStudentHours: m, cancellationStudentHours: m, bookedTutorHours: m, creditTutorHours: m, cancellationTutorHours: m, newTutorHours: m, reactivatedTutorHours: m, trialStudentHours: m, pretestStudentHours: m, mature: false, provisional: true, startingCohortExcluded: false, contributors: { studentIds: ["s1"], sessionIds: ["lesson1", "lesson2", "lesson3"], eventKeys: [] } };
const quality = { completeness: "complete" as const, issueCodes: [], sourceCoverage: [], exceptions: [] };
const flows: GrowthFlows = { months: [row], lifecycleEvents: [], commonWindow: ["2026-06", "2026-07", "2026-08"], averages: [], patterns: [], quality };
const forecast: GrowthForecast = { baseMonth: "2026-09", inputs: [], months: [], allocations: [], hiring: [], bufferPercent: 0, assumptions: [], quality };
const evidence: GrowthEvidence = { revision: "evidence1", bookingMetadata: [], lifecycleEvents: [], workforce: { people: [], observations: [], tutorFacts: [], sessions: row.contributors.sessionIds.map(wiseSessionId => ({ wiseSessionId, wiseClassId: "class1", classTitle: "Maths", startAt: "2026-09-01T02:00:00Z", endAt: "2026-09-01T03:00:00Z", scheduledMinutes: 60, canonicalTutorKeys: ["tutor1"], historicalBookedStudentIds: ["s1"], participantCompleteness: "complete", completeness: "complete", meetingStatus: "ENDED", attendanceStatus: null, modality: "online", subject: "Maths", curriculum: null, level: null, reasonCodes: [] })), historicalBookedParticipants: [], studentCredits: [], subjectMappings: [], terminationMarks: [], sourceCoverage: [] } };
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(buildAllGrowthFlows).mockReturnValue(flows); vi.mocked(buildGrowthForecast).mockReturnValue(forecast); vi.mocked(loadGrowthEvidence).mockResolvedValue(evidence);
});

describe("growth report evidence and pagination", () => {
  it("binds later exports to the original time and changes revisions for maturity or assumptions", async () => {
    const first = buildGrowthReport(evidence, query, now);
    expect((await getGrowthReport(db, query, new Date(now.getTime() + 1000), first.reportRevision)).reportRevision).toBe(first.reportRevision);
    expect(buildGrowthReport(evidence, { ...query, assumptions: { bufferPercent: 20 } }, now).reportRevision).not.toBe(first.reportRevision);
    vi.mocked(buildAllGrowthFlows).mockReturnValue({ ...flows, months: [{ ...row, mature: true, provisional: false }] });
    expect(buildGrowthReport(evidence, query, now).reportRevision).not.toBe(first.reportRevision);
  });
  it("rejects stale revisions and nonexistent rows", async () => {
    await expect(getGrowthDrilldown(db, { ...query, reportRevision: "old", kind: "cohort", key: row.key }, now)).rejects.toMatchObject({ status: 409 });
    const revision = buildGrowthReport(evidence, query, now).reportRevision;
    await expect(getGrowthDrilldown(db, { ...query, reportRevision: revision, kind: "cohort", key: "absent" }, now)).rejects.toMatchObject({ status: 404 });
  });
  it("bounds the combined page and binds its cursor to revision, kind and row", async () => {
    const revision = buildGrowthReport(evidence, query, now).reportRevision;
    const selection = { ...query, reportRevision: revision, kind: "cohort" as const, key: row.key, pageSize: 2 };
    const first = await getGrowthDrilldown(db, selection, new Date(now.getTime() + 2500));
    expect(first.sessions.map(value => value.wiseSessionId)).toEqual(["lesson1", "lesson2"]);
    const second = await getGrowthDrilldown(db, { ...selection, cursor: first.nextCursor! }, now);
    expect(second.sessions.map(value => value.wiseSessionId)).toEqual(["lesson3"]); expect(second.nextCursor).toBeNull();
    await expect(getGrowthDrilldown(db, { ...selection, kind: "cancellation", cursor: first.nextCursor! }, now)).rejects.toMatchObject({ status: 400 });
    expect(reconcileGrowthLifecycleEvents).not.toHaveBeenCalled(); expect(storeGrowthBookingMetadata).not.toHaveBeenCalled();
  });
});
