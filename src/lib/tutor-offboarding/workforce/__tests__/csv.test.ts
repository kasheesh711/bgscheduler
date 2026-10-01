import { describe, expect, it } from "vitest";
import { serializeWorkforceCsv } from "../csv";
import type { WorkforceReport } from "../types";
const report = {
  schemaVersion:1, reportRevision:"revision-1", generatedAt:"2026-10-01T00:00:00Z",
  query:{from:"2026-03-01",to:"2026-10-01",viewMonth:"2026-09",role:"all",modality:"all"},
  people:[{canonicalKey:"p1",displayName:'=SUM(1,2)\n"teacher"',role:"tutor",rosterState:"active",joinedAt:null,departedAt:null,pendingDeparture:false,
    bookedHours:{value:4,completeness:"complete",reasonCodes:[]},
    creditConsumedHours:{value:null,completeness:"unknown",reasonCodes:["NORMAL_CHARGE_UNKNOWN"]}}],
  months:[],subjects:[],weekCells:[],quality:{completeness:"partial",issueCodes:[],sourceCoverage:[],exceptions:[]},
} as unknown as WorkforceReport;
describe("workforce CSV",()=>{
  it("retains large report evidence once with an explicit reference from every metric row",()=>{
    const large = {...report, people:Array.from({length:100},(_,i)=>({...report.people[0],displayName:`Teacher ${i}`})), quality:{...report.quality,exceptions:[{code:"SOURCE_GAP",message:"x".repeat(1_000_000),entityId:"retained-source-record"}]}};
    const csv=serializeWorkforceCsv(large,"people");
    expect(csv.match(/retained-source-record/g)).toHaveLength(1);
    expect(csv).toContain('"report_metadata_data_row"');
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(101);
    expect(Buffer.byteLength(csv)).toBeLessThan(2_000_000);
    expect(csv).toContain('"Teacher 99"');
  });
  it("uses report values and includes revision, filters, null state and reasons",()=>{
    const csv=serializeWorkforceCsv(report,"people");
    expect(csv).toContain('"report_revision"');
    expect(csv).toContain('"revision-1"');
    expect(csv).toContain('"bookedHours_value"');
    expect(csv).toContain(',4,"complete",');
    expect(csv).toContain(',"","unknown","NORMAL_CHARGE_UNKNOWN"');
    expect(csv).toContain('"2026-09"');
  });
  it("quotes newlines and literal quotes while neutralizing formulas",()=>{
    expect(serializeWorkforceCsv(report,"people")).toContain('"\'=SUM(1,2)\n""teacher"""');
  });
  it("exports a header for an empty section",()=>{
    const csv=serializeWorkforceCsv(report,"months");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(csv).toContain('"turnoverPercent_value"');
  });
  it("retains source timestamps and exact coverage instead of only the export time",()=>{
    const evidenceReport = {...report,quality:{...report.quality,sourceCoverage:[{source:"wise_history",requestedFrom:"2026-03-01",requestedTo:"2026-03-31",returnedFrom:null,returnedTo:null,observedAt:"2026-10-01T04:00:00Z",pagesRequested:2,pagesReturned:1,recordsReturned:100,truncated:true,completeness:"partial" as const,issueCodes:["REQUEST_CAP_EXHAUSTED"]}]}};
    const csv=serializeWorkforceCsv(evidenceReport,"people");
    expect(csv).toContain("source_coverage"); expect(csv).toContain("2026-10-01T04:00:00Z"); expect(csv).toContain("REQUEST_CAP_EXHAUSTED");
  });
});
