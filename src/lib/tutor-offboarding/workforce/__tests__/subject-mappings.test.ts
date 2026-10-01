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
});
