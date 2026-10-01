import { describe, expect, it } from "vitest";
import { parseGrowthRequest, parseGrowthDetailRequest, parseGrowthExportRequest, readGrowthBody } from "../query";

const filters = { from:"2026-03-01", to:"2026-10-01", viewMonth:"2026-10", role:"all", modality:"all" };
describe("growth scenario boundaries", () => {
  it("uses explicit defaults and preserves valid measured overrides", () => {
    expect(parseGrowthRequest({filters}).assumptions).toEqual({bufferPercent:0});
    expect(parseGrowthRequest({filters,assumptions:{bufferPercent:20,subjects:{Maths:{newStudentHours:12,cancellationFraction:0.5,studentHoursPerTutorHour:2}}}}).assumptions.bufferPercent).toBe(20);
  });
  it("rejects invalid model inputs, dates and unknown keys", () => {
    for(const values of [{newStudentHours:-1},{churnStudentHours:NaN},{cancellationFraction:1.1},{studentHoursPerTutorHour:0},{other:1}])
      expect(()=>parseGrowthRequest({filters,assumptions:{subjects:{Maths:values}}})).toThrow();
    expect(()=>parseGrowthRequest({filters,assumptions:{bufferPercent:101}})).toThrow();
    expect(()=>parseGrowthRequest({filters:{...filters,from:"2026-02-30"}})).toThrow();
    expect(()=>parseGrowthRequest({filters,admin:true})).toThrow();
  });
  it("rejects prototype keys and more than100 overrides", () => {
    expect(()=>parseGrowthRequest(JSON.parse('{"filters":{},"assumptions":{"subjects":{"__proto__":{"newStudentHours":1}}}}'))).toThrow();
    expect(()=>parseGrowthRequest({filters,assumptions:{subjects:Object.fromEntries(Array.from({length:101},(_,i)=>[String(i),{newStudentHours:1}]))}})).toThrow();
  });
  it("requires stable revision and validates selection bounds", () => {
    expect(parseGrowthDetailRequest({filters,kind:"churn",key:"x",reportRevision:"r"}).pageSize).toBe(100);
    expect(()=>parseGrowthDetailRequest({filters,kind:"churn",key:"x",reportRevision:"r",pageSize:501})).toThrow();
    expect(()=>parseGrowthExportRequest({filters,section:"forecast"})).toThrow();
    expect(parseGrowthExportRequest({filters,section:"gaps",reportRevision:"r"}).section).toBe("gaps");
  });
  it("bounds bodies before parsing and rejects malformed JSON", async () => {
    const req=(body:string)=>new Request("https://example.test",{method:"POST",headers:{"Content-Type":"application/json"},body});
    await expect(readGrowthBody(req('{"a":1}'))).resolves.toEqual({a:1});
    await expect(readGrowthBody(req("x".repeat(65537)))).rejects.toThrow("64");
    await expect(readGrowthBody(req("{"))).rejects.toThrow("JSON");
  });
});
