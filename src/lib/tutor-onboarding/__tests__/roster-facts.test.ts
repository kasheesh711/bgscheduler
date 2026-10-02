import { describe, expect, it } from "vitest";
import type { WiseTeacher } from "@/lib/wise/types";
import { extractRosterFacts } from "../roster-facts";

describe("extractRosterFacts", () => {
  it("reads relation, joined date, course count and login activation from a live roster row", () => {
    const teacher: WiseTeacher = {
      _id: "t1",
      userId: { _id: "u1", name: "Aria (Aria)", activated: true },
      relation: "teacher",
      joinedOn: "2026-08-15T03:00:00.000Z",
      classes: [{ _id: "c1", name: "Maths" }, "c2"],
    };
    expect(extractRosterFacts([teacher])).toEqual([{
      wiseTeacherId: "t1",
      relation: "TEACHER",
      joinedOn: new Date("2026-08-15T03:00:00.000Z"),
      courseCount: 2,
      activated: true,
    }]);
  });

  it("keeps every missing or malformed field unknown (null), never a guessed value (OFF-02)", () => {
    expect(extractRosterFacts([
      { _id: "t2", userId: "u2" },
      { _id: "t3", userId: { _id: "u3" }, relation: "  ", joinedOn: "not a date", classes: "x" as never },
    ])).toEqual([
      { wiseTeacherId: "t2", relation: null, joinedOn: null, courseCount: null, activated: null },
      { wiseTeacherId: "t3", relation: null, joinedOn: null, courseCount: null, activated: null },
    ]);
  });

  it("counts an explicitly empty course list as zero", () => {
    expect(extractRosterFacts([{ _id: "t4", classes: [] }])[0].courseCount).toBe(0);
  });
});
