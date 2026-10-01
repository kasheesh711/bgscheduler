import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkforceReport, WorkforceUtilizationMetrics } from "@/lib/tutor-offboarding/workforce/types";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/tutor-offboarding/access", () => ({ requireTutorOffboardingAdmin: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/workforce/service", () => ({ getWorkforceReport: vi.fn(), getWorkforceDrilldown: vi.fn() }));
import { getDb } from "@/lib/db";
import { requireTutorOffboardingAdmin } from "@/lib/tutor-offboarding/access";
import { TutorOffboardingError } from "@/lib/tutor-offboarding/errors";
import { getWorkforceReport, getWorkforceDrilldown } from "@/lib/tutor-offboarding/workforce/service";
import { GET as reportGet } from "../route";
import { GET as detailGet } from "../drilldown/route";
import { GET as exportGet } from "../export/route";
const filters = "from=2026-03-01&to=2026-10-01&viewMonth=2026-09&subject=Maths";
const request = (extra="") => new Request(`https://example.test/api/workforce?${filters}${extra}`);
const unknown = {value:null,completeness:"unknown" as const,reasonCodes:["NO_AVAILABILITY_HISTORY"]};
const metrics: WorkforceUtilizationMetrics = {
  uniqueStudents:unknown,studentBookings:unknown,distinctClasses:unknown,bookedHours:unknown,
  cancelledBookings:unknown,noShowBookings:unknown,creditConsumedHours:unknown,recordedTeachingHours:unknown,
  qualifiedPeople:unknown,offeredHours:unknown,leaveHours:unknown,usableHours:unknown,reservedHours:unknown,
  freeHours:unknown,outsideHours:unknown,overlapHours:unknown,coverageHours:unknown,expectedCoverageHours:unknown,
  coveragePercent:unknown,utilizationReservedHours:unknown,utilizationCreditConsumedHours:unknown,
  utilizationRecordedTeachingHours:unknown,reservedUtilizationPercent:unknown,consumedUtilizationPercent:unknown,
  recordedTeachingUtilizationPercent:unknown,
};
const report: WorkforceReport = {
  schemaVersion:1,reportRevision:"r1",generatedAt:"2026-10-01T00:00:00Z",
  query:{from:"2026-03-01",to:"2026-10-01",viewMonth:"2026-09",subject:"Maths",role:"all",modality:"all"},
  totals:metrics,months:[],subjects:[],weekCells:[],
  people:[{...metrics,canonicalKey:"p1",displayName:"Tutor A",role:"tutor",rosterState:"active",joinedAt:null,departedAt:null,pendingDeparture:false,months:[],reasonCodes:[],
    creditConsumedHours:{value:0.75,completeness:"complete",reasonCodes:[]},
    usableHours:{value:null,completeness:"unknown",reasonCodes:["NO_AVAILABILITY_HISTORY"]}}],
  quality:{completeness:"partial",issueCodes:["NO_AVAILABILITY_HISTORY"],sourceCoverage:[],exceptions:[]},
};
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(requireTutorOffboardingAdmin).mockResolvedValue({email:"admin@example.test",isOwner:false,canRemove:false});
  vi.mocked(getWorkforceReport).mockResolvedValue(report);
  vi.mocked(getWorkforceDrilldown).mockResolvedValue({query:report.query,reportRevision:"r1",kind:"person",key:"p1",contributors:{canonicalKeys:["p1"],wiseSessionIds:[],wiseClassIds:[],wiseStudentIds:[],terminationSourceIds:[],observationIds:[]},people:report.people,sessions:[],observations:[],exceptions:[],nextCursor:null});
});
describe("authorized workforce reports and exports",()=>{
  it.each([reportGet,detailGet,exportGet])("checks access before parsing or reading data",async handler=>{
    vi.mocked(requireTutorOffboardingAdmin).mockRejectedValue(new TutorOffboardingError("Unauthorized",401));
    const response=await handler(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getWorkforceReport).not.toHaveBeenCalled();
    expect(getWorkforceDrilldown).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });
  it("preserves nulls and forwards selected filters",async()=>{
    const response=await reportGet(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(vi.mocked(getWorkforceReport).mock.calls[0][1]).toEqual(report.query);
  });
  it("rejects malformed filters before a data read",async()=>{
    const response=await reportGet(new Request("https://example.test/?from=2026-02-30"));
    expect(response.status).toBe(400);
    expect(getWorkforceReport).not.toHaveBeenCalled();
  });
  it("returns matching selected-person detail",async()=>{
    const response=await detailGet(request("&kind=person&key=p1&reportRevision=r1"));
    expect(response.status).toBe(200);
    expect((await response.json()).people).toEqual(report.people);
    expect(vi.mocked(getWorkforceDrilldown).mock.calls[0][1]).toMatchObject({...report.query,key:"p1",reportRevision:"r1",pageSize:100});
  });
  it("exports exactly the report revision and metric values",async()=>{
    const response=await exportGet(request("&section=people&reportRevision=r1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("workforce-people-2026-03-01-2026-10-01.csv");
    const csv=await response.text();
    expect(csv).toContain(',0.75,"complete",');
    expect(csv).toContain(',"","unknown","NO_AVAILABILITY_HISTORY"');
    expect(vi.mocked(getWorkforceReport).mock.calls[0][1]).toEqual(report.query);
  });
  it("rejects an export for a previous source revision",async()=>{
    const response=await exportGet(request("&section=people&reportRevision=old"));
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
  it("preserves a stale detail response and hides unexpected error details",async()=>{
    vi.mocked(getWorkforceDrilldown).mockRejectedValueOnce(new TutorOffboardingError("Refresh the report.",409));
    expect((await detailGet(request("&kind=person&key=p1&reportRevision=old"))).status).toBe(409);
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    vi.mocked(getWorkforceReport).mockRejectedValueOnce(new Error("private DB parameters"));
    const response=await reportGet(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private DB parameters");
    log.mockRestore();
  });
});
