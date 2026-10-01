import { describe, expect, it } from "vitest";
import { serializeGrowthCsv } from "../csv";
import type { GrowthReport } from "../types";

const zero = {value:0,completeness:"complete" as const,reasonCodes:[]};
const monthlyDefaults = {
  newlyObservedStudents:zero,reactivatedStudents:zero,churnedStudents:zero,
  reactivatedStudentHours:zero,churnStudentHours:zero,bookedStudentHours:zero,cancellationStudentHours:zero,
  bookedTutorHours:zero,creditTutorHours:zero,cancellationTutorHours:zero,newTutorHours:zero,reactivatedTutorHours:zero,
  trialStudentHours:zero,pretestStudentHours:zero,mature:true,provisional:false,startingCohortExcluded:false,
};

function fixture(): GrowthReport {
  return {
    schemaVersion: 1, reportRevision: "growth-r1", generatedAt: "2026-10-01T05:00:00Z",
    query: { filters: { from: "2026-03-01", to: "2026-10-01", viewMonth: "2026-09", role: "all", modality: "all" }, assumptions: { bufferPercent: 0 } },
    flows: { months: [{ ...monthlyDefaults, key: "math-aug", courseKey: "math", subject: '=SUM(1,2)\n"math"', curriculum: "International", level: "9–11", month: "2026-08", newStudentHours: { value: 12, completeness: "complete", reasonCodes: [] }, creditStudentHours: { value: null, completeness: "unknown", reasonCodes: ["CREDITS_MISSING"] }, contributors: { studentIds: ["s1"], sessionIds: ["lesson1"], eventKeys: ["churn1"] } }], lifecycleEvents: [{ eventKey: "churn1", revision: 1, studentId: "s1", subject: "Maths", kind: "churn", lastTaughtAt: "2026-07-20T03:00:00Z", returnAt: null, effectiveMonth: "2026-08", confirmedAt: "2026-09-18T03:00:00Z", baselineMonths: ["2026-04", "2026-05", "2026-06"], baselineStudentHours: { value: 4, completeness: "complete", reasonCodes: [] }, evidenceRevision: "source-r1", sourceSessionIds: ["lesson1"], status: "active", certainty: "inferred", reasonCodes: ["HISTORIC_BOOKINGS_UNOBSERVED"] }], commonWindow: ["2026-06", "2026-07", "2026-08"], averages: [], patterns: [], quality: { completeness: "partial", issueCodes: [], sourceCoverage: [], exceptions: [] } },
    forecast: { baseMonth: "2026-09", inputs: [], months: [], allocations: [], hiring: [], bufferPercent: 0, assumptions: ["Shared tutor hours are allocated once."], quality: { completeness: "partial", issueCodes: [], sourceCoverage: [], exceptions: [] } },
    quality: { completeness: "partial", issueCodes: ["CREDITS_MISSING"], sourceCoverage: [{ source: "wise_history", requestedFrom: "2026-08-01", requestedTo: "2026-08-31", returnedFrom: null, returnedTo: null, observedAt: "2026-10-01T04:00:00Z", pagesRequested: 1, pagesReturned: 1, recordsReturned: 0, truncated: false, completeness: "complete", issueCodes: [] }], exceptions: [] },
  };
}

describe("growth CSV", () => {
  it("exports source provenance, cohort IDs, exact windows, certainty and null metric states", () => {
    const csv = serializeGrowthCsv(fixture(), "months");
    for (const value of ["growth-r1", "2026-06|2026-07|2026-08", "2026-05", "inferred", "lesson1", "2026-10-01T04:00:00Z", "CREDITS_MISSING", "source_coverage", "newStudentHours_value"]) expect(csv).toContain(value);
    expect(csv).toContain(',12,"complete",');
    expect(csv).toContain(',"","unknown","CREDITS_MISSING"');
  });
  it("escapes spreadsheet formulas, quotes and multiline labels", () => {
    expect(serializeGrowthCsv(fixture(), "months")).toContain('"\'=SUM(1,2)\n""math"""');
  });
  it("keeps stable headers for empty exports and includes scenario inputs", () => {
    const report = fixture();
    report.query.assumptions = { bufferPercent: 20, subjects: { math: { newStudentHours: 8 } } };
    const csv = serializeGrowthCsv(report, "forecast");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(csv).toContain('"model_inputs"');
    expect(csv).toContain('"capacityRequiredTutorHours_value"');
  });
  it('exports only lifecycle evidence that contributes to the chart row', () => {
    const report = fixture();
    report.flows.lifecycleEvents.push({ ...report.flows.lifecycleEvents[0], eventKey: 'unrelated-event', studentId: 'unrelated-student' });
    const csv = serializeGrowthCsv(report, 'months');
    expect(csv).toContain('churn1');
    expect(csv).not.toContain('unrelated-event');
    expect(csv).not.toContain('unrelated-student');
  });
});
