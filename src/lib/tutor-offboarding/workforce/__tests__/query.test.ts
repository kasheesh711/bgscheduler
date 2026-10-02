import { describe, expect, it } from "vitest";
import { parseWorkforceQuery, parseWorkforceDrilldownQuery, parseWorkforceExportQuery } from "../query";
const base = "from=2026-03-01&to=2026-10-01&viewMonth=2026-09";
describe("workforce query boundaries", () => {
  it("normalizes valid shared filters", () => {
    expect(parseWorkforceQuery(new URLSearchParams(`${base}&role=teaching_admin&subject=Maths&modality=online`))).toEqual({
      from:"2026-03-01", to:"2026-10-01", viewMonth:"2026-09", role:"teaching_admin", subject:"Maths", modality:"online",
    });
  });
  it.each(["from=2026-02-01", "to=2026-02-30", "role=admin", "modality=hybrid", "viewMonth=2026-13", "from=2026-10-02&to=2026-10-01", "viewMonth=2027-01", "from=2026-03-01&from=2026-04-01", "unknown=1", "__proto__=1"])("rejects invalid or ambiguous query %s", (bad) => {
    const params = new URLSearchParams(base);
    for (const [key] of new URLSearchParams(bad)) params.delete(key);
    for (const [key,value] of new URLSearchParams(bad)) params.append(key,value);
    expect(() => parseWorkforceQuery(params)).toThrow();
  });
  it("requires the exact revision for detail and bounds paging", () => {
    const q = parseWorkforceDrilldownQuery(new URLSearchParams(`${base}&kind=person&key=tutor-a&reportRevision=revision-1`));
    expect(q.pageSize).toBe(100);
    expect(q.key).toBe("tutor-a");
    expect(() => parseWorkforceDrilldownQuery(new URLSearchParams(`${base}&kind=person&key=a`))).toThrow();
    expect(() => parseWorkforceDrilldownQuery(new URLSearchParams(`${base}&kind=person&key=a&reportRevision=r&pageSize=501`))).toThrow();
  });
  it("validates export section and revision", () => {
    expect(parseWorkforceExportQuery(new URLSearchParams(`${base}&section=people&reportRevision=r`)).section).toBe("people");
    expect(() => parseWorkforceExportQuery(new URLSearchParams(`${base}&section=secret&reportRevision=r`))).toThrow();
    expect(() => parseWorkforceExportQuery(new URLSearchParams(`${base}&section=people`))).toThrow();
  });
});
