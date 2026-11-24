import { describe, expect, it } from "vitest";
import { baseConfigSchema, profileWeightsSchema, DEFAULT_WEIGHTS } from "../model";
import { highSchoolFraction, highSchoolMatch, profileScore, validateAssessment } from "../scoring";

const config = baseConfigSchema.parse({});
const criteria = (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
  id, result: "met" as const, evidence: "", reason: "r",
}));

describe("high-school score part", () => {
  it("matches a top-tier school without the city, and a Thai school by its other name", () => {
    expect(highSchoolMatch([{ name: "Harrow International School" }], config.highSchools))
      .toMatchObject({ name: "Harrow International School Bangkok", tier: 1, fraction: 1 });
    expect(highSchoolMatch([{ name: "Satit Chula" }], config.highSchools)?.tier).toBe(1);
    expect(highSchoolMatch([{ name: "โรงเรียนเตรียมอุดมศึกษา" }], config.highSchools)?.tier).toBe(1);
  });
  it("gives half for a listed school and takes the best of two schools", () => {
    expect(highSchoolMatch([{ name: "Traill International School" }], config.highSchools)?.fraction).toBe(0.5);
    expect(highSchoolMatch([{ name: "Traill International School" }, { name: "NIST International School" }], config.highSchools)?.fraction).toBe(1);
  });
  it("gives nothing for an unlisted school, a longer branch name, or a row with no schools", () => {
    expect(highSchoolMatch([{ name: "Harrow School" }], config.highSchools)).toBeNull();
    for (const name of ["International School", "ISB", "KIS", "King's College", "St Andrews", "Harrow", "Prep", "Garden International School", "Singapore International School"])
      expect(highSchoolMatch([{ name }], config.highSchools), name).toBeNull();
    expect(highSchoolMatch([{ name: "Harrow International School (Bangkok, Thailand)" }], config.highSchools)?.tier).toBe(1);
    expect(highSchoolMatch([{ name: "The International School Bangkok" }], config.highSchools)?.tier).toBe(1);
    expect(highSchoolMatch([{ name: "สาธิตจุฬา" }], config.highSchools)?.tier).toBe(1);
    expect(highSchoolMatch([{ name: "Triam Udom Suksa Pattanakarn School" }], config.highSchools)).toBeNull();
    expect(highSchoolFraction({}, config)).toBe(0);
    expect(highSchoolFraction(null, {})).toBe(0);
  });
  it("adds the school weight to the profile score", () => {
    expect(DEFAULT_WEIGHTS).toMatchObject({ curriculum: 15, prestige: 15, school: 10 });
    expect(profileScore({ criteria }, DEFAULT_WEIGHTS, 0.5, 0, 1)).toBe(75 + 7.5 + 10);
    expect(profileScore({ criteria }, DEFAULT_WEIGHTS, 0.5, 0, 0)).toBe(82.5);
  });
  it("reads a config saved before the part with a school weight of 0", () => {
    const old = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20 };
    expect(profileWeightsSchema.parse(old).school).toBe(0);
  });
  it("rejects a school whose evidence is not in the source", () => {
    const base = { criteria: criteria.map((c) => ({ ...c, result: "unknown" as const })), subjects: [], universities: [], summary: "s" };
    const source = "Harrow International School (Bangkok, Thailand) Graduated: June 2018";
    expect(validateAssessment({ ...base, schools: [{ name: "Harrow International School", evidence: "Harrow International School (Bangkok, Thailand)" }] }, source).schools).toHaveLength(1);
    expect(() => validateAssessment({ ...base, schools: [{ name: "NIST", evidence: "NIST International School" }] }, source)).toThrow();
  });
});
