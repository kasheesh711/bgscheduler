import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrowthReport } from "@/lib/tutor-offboarding/workforce/growth/types";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/tutor-offboarding/access", () => ({ requireTutorOffboardingAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/workforce/growth/service", () => ({ getGrowthReport: vi.fn(), getGrowthDrilldown: vi.fn() }));
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { getGrowthReport, getGrowthDrilldown } from "@/lib/tutor-offboarding/workforce/growth/service";
import { GET, POST, maxDuration as reportDuration } from "../route";
import { POST as detail, maxDuration as detailDuration } from "../drilldown/route";
import { POST as exporting, maxDuration as exportDuration } from "../export/route";
import * as csv from "@/lib/tutor-offboarding/workforce/growth/csv";
const filters = { from: "2026-03-01", to: "2026-10-01", viewMonth: "2026-09", role: "all" as const, modality: "all" as const };
const quality = { completeness: "partial" as const, issueCodes: ["CREDIT_HISTORY_MISSING"], sourceCoverage: [], exceptions: [] };
const report: GrowthReport = { schemaVersion: 1, reportRevision: "r1", generatedAt: "2026-10-01T05:00:00Z", query: { filters, assumptions: { bufferPercent: 0 } }, flows: { months: [], averages: [], lifecycleEvents: [], commonWindow: ["2026-06", "2026-07", "2026-08"], patterns: [], quality }, forecast: { baseMonth: "2026-09", inputs: [], months: [], allocations: [], hiring: [], bufferPercent: 0, assumptions: [], quality }, quality };
const request = (body: unknown = { filters }) => new Request("https://example.test/growth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireTutorOffboardingAdmin).mockResolvedValue({ email: "admin@example.test", isOwner: false, canRemove: false });
  vi.mocked(getGrowthReport).mockResolvedValue(report);
  vi.mocked(getGrowthDrilldown).mockResolvedValue({ reportRevision: "r1", kind: "cohort", key: "row1", contributors: { studentIds: [], sessionIds: [], eventKeys: [] }, sessions: [], events: [], observations: [], exceptions: [], nextCursor: null });
});
describe("authorized read-only growth endpoints", () => {
  it.each([GET, POST, detail, exporting])("checks authorization before parsing or data access", async handler => {
    vi.mocked(requireTutorOffboardingAdmin).mockRejectedValue(new TutorOffboardingError("Forbidden", 403));
    const response = await handler(request());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getDb).not.toHaveBeenCalled(); expect(getGrowthReport).not.toHaveBeenCalled(); expect(getGrowthDrilldown).not.toHaveBeenCalled();
  });
  it("returns measured defaults and forwards validated scenario overrides", async () => {
    expect((await GET(new Request(`https://example.test/?${new URLSearchParams(filters)}`))).status).toBe(200);
    expect(vi.mocked(getGrowthReport).mock.calls[0][1]).toEqual(report.query);
    const assumptions = { bufferPercent: 20, subjects: { math: { newStudentHours: 12 } } };
    const response = await POST(request({ filters, assumptions }));
    expect(await response.json()).toEqual(report);
    expect(vi.mocked(getGrowthReport).mock.lastCall?.[1]).toEqual({ filters, assumptions });
  });
  it('forwards explicit refresh for a read-only scenario without changing its assumptions', async () => {
    const original = request({ filters, assumptions: { bufferPercent: 0 } });
    const response = await POST(new Request(original, { headers: { 'content-type': 'application/json', 'x-workforce-refresh': '1' } }));
    expect(response.status).toBe(200);
    expect(vi.mocked(getGrowthReport).mock.lastCall?.[4]).toBe(true);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it("rejects duplicate filters, invalid assumptions and oversized JSON without reading evidence", async () => {
    expect((await GET(new Request("https://example.test/?role=all&role=tutor"))).status).toBe(400);
    expect((await POST(request({ filters, assumptions: { bufferPercent: 101 } }))).status).toBe(400);
    expect((await POST(request({ filters, padding: "x".repeat(66000) }))).status).toBe(400);
    expect(getGrowthReport).not.toHaveBeenCalled();
  });
  it("forwards revision-bound detail and preserves stale errors", async () => {
    const response = await detail(request({ filters, reportRevision: "r1", kind: "cohort", key: "row1" }));
    expect(response.status).toBe(200);
    expect(vi.mocked(getGrowthDrilldown).mock.lastCall?.[1]).toMatchObject({ reportRevision: "r1", key: "row1", pageSize: 100 });
    vi.mocked(getGrowthDrilldown).mockRejectedValueOnce(new TutorOffboardingError("Refresh the report.", 409));
    expect((await detail(request({ filters, reportRevision: "old", kind: "cohort", key: "row1" }))).status).toBe(409);
  });
  it("exports only a matching report and never exposes unexpected error text", async () => {
    const good = await exporting(request({ filters, reportRevision: "r1", section: "forecast" }));
    expect(good.headers.get("content-type")).toContain("text/csv");
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    expect(await good.text()).toContain('"report_revision"');
    expect((await exporting(request({ filters, reportRevision: "old", section: "forecast" }))).status).toBe(409);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getGrowthReport).mockRejectedValueOnce(new Error("private SQL params"));
    const bad = await POST(request());
    expect(bad.status).toBe(500); expect(await bad.text()).not.toContain("private SQL params");
    log.mockRestore();
  });
});


describe("large growth transport", () => {
  it("streams GET/scenario/detail/CSV without dropping final evidence", async () => {
    const label = "x".repeat(4_600_000) + "ไทย🧑";
    const large = { ...report, quality: { ...quality, issueCodes: [label] } };
    const largeDetail = { reportRevision:"r1",kind:"cohort" as const,key:"row1",contributors:{studentIds:[],sessionIds:[],eventKeys:[]},sessions:[],events:[],observations:[],exceptions:[{code:"UNKNOWN",entityId:"synthetic",message:label}],nextCursor:null };
    vi.mocked(getGrowthReport).mockResolvedValue(large);
    vi.mocked(getGrowthDrilldown).mockResolvedValue(largeDetail);
    const csvSpy = vi.spyOn(csv,"serializeGrowthCsv").mockReturnValue('"evidence"\r\n"'+label+'"\r\n');
    try {
      for (const [handler, input, expected] of [
        [GET,new Request(`https://example.test/?${new URLSearchParams(filters)}`),large],
        [POST,request(),large],
        [detail,request({filters,reportRevision:"r1",kind:"cohort",key:"row1"}),largeDetail],
        [exporting,request({filters,reportRevision:"r1",section:"forecast"}),null],
      ] as const) {
        const response = await handler(input);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("content-length")).toBeNull();
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(first.value!.byteLength).toBeLessThanOrEqual(65536);
        const parts = [first.value!];
        for (;;) { const next = await reader.read(); if(next.done)break;parts.push(next.value); }
        const bytes = Buffer.concat(parts);
        expect(bytes.byteLength).toBeGreaterThan(4_500_000);
        if(expected)expect(JSON.parse(bytes.toString())).toEqual(expected);
        else {
          expect(bytes.equals(Buffer.from('\uFEFF"evidence"\r\n"'+label+'"\r\n'))).toBe(true);
          expect(response.headers.get("content-disposition")).toContain("course-demand-forecast");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        }
      }
    } finally { csvSpy.mockRestore(); }
    expect([reportDuration,detailDuration,exportDuration]).toEqual([120,120,120]);
  });
});
