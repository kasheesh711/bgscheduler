import { describe, it, expect } from "vitest";
import { buildInstitution, buildCompletions, type SourceRows } from "../transform";

describe("buildInstitution", () => {
  const src: SourceRows = {
    HD: {
      UNITID: "100",
      INSTNM: "Test University",
      STABBR: "CA",
      CONTROL: "1",
      ICLEVEL: "1",
      LONGITUD: "-122.34",
      LATITUDE: "37.80",
      HBCU: "2",
    },
    DRVADM: { UNITID: "100", DVADM01: "15", DVADM04: "40" },
    DRVEF: { UNITID: "100", ENRTOT: "12000", PCTENRW: "55" },
    // No EF2024D row → student-faculty ratio must be null, not 0.
  };

  const inst = buildInstitution(src, 100, "2024-25");

  it("maps directory + acceptance rate", () => {
    expect(inst.instName).toBe("Test University");
    expect(inst.stateAbbr).toBe("CA");
    expect(inst.acceptanceRate).toBe(15);
    expect(inst.yieldRate).toBe(40);
    expect(inst.enrollmentTotal).toBe(12000);
  });

  it("preserves negative longitude", () => {
    expect(inst.longitude).toBe(-122.34);
    expect(inst.latitude).toBe(37.8);
  });

  it("fail-closed: unreported metric is null, not 0", () => {
    expect(inst.studentFacultyRatio).toBeNull();
    expect(inst.retentionFt).toBeNull();
    expect(inst.avgNetPrice).toBeNull();
  });

  it("coerces flag (HBCU=2 → false) and keeps year/unit", () => {
    expect(inst.hbcu).toBe(false);
    expect(inst.dataYear).toBe("2024-25");
    expect(inst.unitId).toBe(100);
  });

  it("falls back to a synthetic name when blank", () => {
    const out = buildInstitution({ HD: { UNITID: "200", INSTNM: "" } }, 200, "2024-25");
    expect(out.instName).toBe("Institution 200");
  });
});

describe("buildCompletions", () => {
  const titles = new Map<string, string>([["11.0701", "Computer Science"]]);
  const rows = buildCompletions(
    [{ UNITID: "100", CIPCODE: "11.0701", AWLEVEL: "5", CTOTALT: "120" }],
    titles,
    "2024-25",
  );

  it("maps cip title, family, and count", () => {
    expect(rows[0].cipCode).toBe("11.0701");
    expect(rows[0].cipTitle).toBe("Computer Science");
    expect(rows[0].cip2).toBe("11");
    expect(rows[0].awardLevel).toBe(5);
    expect(rows[0].awardLevelLabel).toContain("Bachelor");
    expect(rows[0].count).toBe(120);
  });
});
