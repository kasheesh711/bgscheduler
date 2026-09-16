import { describe, expect, it } from "vitest";
import { titleScopes, type Lesson } from "../model";
import { allocateScience } from "../allocation";
import { classSummaries, datedRoster } from "../readiness";
import { sessionStudentIds } from "@/lib/normalization/sessions";
import type { WiseSession } from "@/lib/wise/types";

describe("coverage classification", () => {
  it.each([
    "Eng VR",
    "Eng+VR",
    "English + VR",
    "ENGLISH-VR",
    "EngVR",
    "English / Verbal Reasoning",
    "eng.verbal-reasoning",
    "ISEB English Verbal Reasoning",
  ])("assigns %s only to English ISEB", (title) => {
    expect(titleScopes(title)).toEqual(["iseb_english_vr"]);
  });
  it.each([
    "Math VR",
    "Math + VR",
    "Maths+VR",
    "mathvr",
    "Mathematics: Verbal Reasoning",
  ])("assigns %s only to Maths ISEB", (title) => {
    expect(titleScopes(title)).toEqual(["iseb_maths_vr"]);
  });
  it.each([
    "VR",
    "Non VR",
    "NON-VR",
    "NonVR",
    "NVR",
    "Verbal Reasoning",
    "Non-verbal Reasoning",
    "non verbal reasoning",
  ])("assigns %s to other ISEB", (title) => {
    expect(titleScopes(title)).toEqual(["iseb_other"]);
  });
  it("retains ordinary subjects and distinguishes general Science", () => {
    expect(titleScopes("Maths and English")).toEqual(["maths", "english"]);
    expect(titleScopes("IGCSE Science")).toEqual(["science"]);
    expect(titleScopes("Physics and Chemistry Science")).toEqual([
      "physics",
      "chemistry",
    ]);
    expect(titleScopes("Year 7–9")).toEqual([]);
  });
});

describe("science allocation", () => {
  const options = ["Peat", "Ek", "Mimi"].map((email) => ({
    email,
    starts: ["2026-10-03"],
  }));
  it("balances Science loads and is stable on repeated generation", () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({
      key: String(i),
      options,
    }));
    const result = allocateScience(candidates);
    const counts = options.map(
      (o) => [...result.values()].filter((v) => v === o.email).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1);
    expect(allocateScience(candidates)).toEqual(result);
  });
  it("prioritizes scarce lessons and available observers, accounting for pinned loads", () => {
    const result = allocateScience(
      [
        {
          key: "many",
          options: options.map((o) => ({
            ...o,
            starts: ["2026-10-03", "2026-10-04"],
          })),
        },
        {
          key: "scarce",
          options: [
            { email: "Ek", starts: ["2026-10-05"] },
            { email: "Peat", starts: [] },
          ],
        },
      ],
      new Map([["Ek", 2]]),
    );
    expect([...result.keys()]).toEqual(["scarce", "many"]);
    expect(result.get("scarce")).toBe("Ek");
    expect(result.get("many")).not.toBe("Ek");
  });
  it("handles no eligible alternate without inventing an observer", () => {
    expect(
      allocateScience([{ key: "self", options: [] }]).get("self"),
    ).toBeNull();
  });
});

describe("dated student evidence", () => {
  const students = new Map([
    [
      "wise-a",
      {
        wiseStudentId: "wise-a",
        studentKey: "a",
        studentName: "Known Student",
        parentName: "Parent",
      },
    ],
  ]);
  it("retains authoritative student IDs independently of packages", () => {
    expect(
      sessionStudentIds({
        students: ["wise-a", { _id: "wise-b" }, "wise-a"],
      } as WiseSession),
    ).toEqual(["wise-a", "wise-b"]);
    expect(
      sessionStudentIds({ participants: ["teacher"] } as WiseSession),
    ).toBeNull();
    expect(sessionStudentIds({ students: [{}] } as WiseSession)).toBeNull();
    expect(datedRoster(["wise-a"], students).participants[0]).toMatchObject({
      wiseStudentId: "wise-a",
      studentKey: "a",
    });
  });
  it("keeps known students visible even when the final occurrence is empty", () => {
    const base = {
      classId: "class",
      title: "Physics",
      tutorName: "Tutor",
      tutorKey: "tutor",
      departments: ["physics"],
    };
    const lessons = [
      { ...base, id: "first", ...datedRoster(["wise-a"], students) },
      { ...base, id: "empty", ...datedRoster(null, students) },
    ] as Lesson[];
    const [summary] = classSummaries(lessons);
    expect(summary).toMatchObject({
      unresolved: false,
      rosterPending: 1,
      sessionCount: 2,
      familyPending: 0,
    });
    expect(summary.students.map((s) => s.studentName)).toEqual([
      "Known Student",
    ]);
    expect(lessons[1].participants).toEqual([]);
  });
  it("blocks partial or empty rosters and keeps family issues separate", () => {
    expect(
      datedRoster(["wise-a", "unknown"], students).issues[0].category,
    ).toBe("students");
    expect(datedRoster([], students).issues[0].category).toBe("students");
    const noParent = new Map([
      ["wise-a", { ...students.get("wise-a")!, parentName: "" }],
    ]);
    expect(
      datedRoster(["wise-a"], noParent).issues.map((i) => i.category),
    ).toEqual(["family"]);
  });
});
