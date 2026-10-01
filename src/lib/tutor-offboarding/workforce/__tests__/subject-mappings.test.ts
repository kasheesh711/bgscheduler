import { describe, expect, it } from "vitest";
import type { ReviewedSubjectMapping } from "../types";
import { assertSubjectMappingRevision, resolveAcademicSubject } from "../subject-mappings";

const mapping = (id: string, classId: string | null, sourceValue: string, subject: string, revision = 1): ReviewedSubjectMapping => ({
  id, classId, sourceValue, subject, curriculum: null, level: null, revision,
  reviewedBy: "reviewer@example.test", reviewedAt: "2026-10-01T00:00:00.000Z",
});

describe("reviewed academic subject mappings", () => {
  it("prefers an exact class ID and source label over a reviewed global alias", () => {
    const mappings = [mapping("global", null, "Physics", "Global Physics"), mapping("scoped", "class-1", "Physics", "IGCSE Physics")];
    expect(resolveAcademicSubject({ classId: "class-1", sourceValue: "Physics" }, mappings)).toMatchObject({ subject: "IGCSE Physics", mappingId: "scoped", completeness: "complete" });
  });

  it("uses a reviewed exact global alias when there is no exact class mapping", () => {
    expect(resolveAcademicSubject({ classId: "class-2", sourceValue: "Physics" }, [mapping("global", null, "Physics", "Physics")])).toMatchObject({ subject: "Physics", completeness: "complete" });
  });

  it("leaves changed labels, ambiguous matches and unmapped classes unknown", () => {
    expect(resolveAcademicSubject({ classId: "class-1", sourceValue: "Physics Advanced" }, [mapping("old", "class-1", "Physics", "Physics")])).toMatchObject({ subject: null, reasonCodes: ["CLASS_LABEL_CHANGED_REVIEW_REQUIRED"] });
    expect(resolveAcademicSubject({ classId: "class-1", sourceValue: "Physics" }, [mapping("a", "class-1", "Physics", "Physics"), mapping("b", "class-1", "Physics", "Applied Physics")])).toMatchObject({ completeness: "unknown", reasonCodes: ["SUBJECT_MAPPING_AMBIGUOUS"] });
    expect(resolveAcademicSubject({ classId: null, sourceValue: "Unreviewed Course" }, [])).toMatchObject({ subject: null, completeness: "unknown", reasonCodes: ["SUBJECT_MAPPING_UNMAPPED"] });
  });

  it("does not use a mapping that lacks review provenance and rejects stale edits", () => {
    const unreviewed = { ...mapping("x", "class-1", "Physics", "Physics"), reviewedBy: null, reviewedAt: null };
    expect(resolveAcademicSubject({ classId: "class-1", sourceValue: "Physics" }, [unreviewed])).toMatchObject({ subject: null, reasonCodes: ["SUBJECT_MAPPING_UNREVIEWED"] });
    expect(() => assertSubjectMappingRevision(2, 3)).toThrow(/changed/);
    expect(() => assertSubjectMappingRevision(2, 3)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("reuses reviewed academic labels across lesson-format, spacing and cancellation suffixes", () => {
    const rows = [mapping("math", null, "On-site Session - Math", "Math")];
    for (const sourceValue of ["On-site Session - Math (Cancelled)", "In-Person Session-Math (Cancelled)", "Online Session - Math", "Live Session - Math (Canceled)"]) {
      expect(resolveAcademicSubject({classId:"c1",sourceValue}, rows)).toMatchObject({subject:"Math", mappingId:"math", completeness:"complete", reasonCodes:["REVIEWED_TITLE_FORMAT_VARIANT"]});
    }
  });

  it("preserves class-specific levels and refuses generic, conflicting or academically different titles", () => {
    const scoped = {...mapping("scoped", "c1", "Live Session - Physics", "Physics"),curriculum:"Int.",level:"Y9-11"};
    const rows = [mapping("global", null, "Physics", "Physics"),scoped];
    expect(resolveAcademicSubject({classId:"c1",sourceValue:"Live Session - Physics (Cancelled)"},rows)).toMatchObject({curriculum:"Int.",level:"Y9-11",mappingId:"scoped"});
    for (const sourceValue of ["Live Session", "In-Person Session", "Physics Advanced", "Physics / Chemistry"]) {
      expect(resolveAcademicSubject({classId:"c1",sourceValue},rows).subject).toBeNull();
    }
    const conflicting=[mapping("a",null,"Live Session - English","EFL"),mapping("b",null,"On-site Session - English","ESL")];
    expect(resolveAcademicSubject({classId:"c2",sourceValue:"Online Session - English (Cancelled)"},conflicting).subject).toBeNull();
  });

  it("applies the owner's reviewed English-to-EFL alias without guessing a level or overriding course review", () => {
    const english = mapping("owner-english", null, "English", "EFL");
    for (const sourceValue of ["English", "In-Person Session-English", "On-site Session - English (Cancelled)"]) {
      expect(resolveAcademicSubject({classId:"c2",sourceValue}, [english])).toMatchObject({subject:"EFL",curriculum:null,level:null,mappingId:"owner-english"});
    }
    const course = {...mapping("reviewed-esl","c2","English","ESL"),curriculum:"Int.",level:"Y9-11"};
    expect(resolveAcademicSubject({classId:"c2",sourceValue:"Live Session - English (Cancelled)"}, [english,course])).toMatchObject({subject:"ESL",curriculum:"Int.",level:"Y9-11",mappingId:"reviewed-esl"});
    expect(resolveAcademicSubject({classId:"c2",sourceValue:"English literature"}, [english]).subject).toBeNull();
  });
});
