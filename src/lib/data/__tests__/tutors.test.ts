import { describe, expect, it } from "vitest";
import { buildTutorList, supportedModesFromModality } from "@/lib/data/tutors";

describe("supportedModesFromModality", () => {
  it("maps persisted modality values to compare selector modes", () => {
    expect(supportedModesFromModality("both")).toEqual(["online", "onsite"]);
    expect(supportedModesFromModality("online")).toEqual(["online"]);
    expect(supportedModesFromModality("onsite")).toEqual(["onsite"]);
    expect(supportedModesFromModality("unresolved")).toEqual([]);
  });
});

describe("buildTutorList", () => {
  it("sorts tutors and attaches deduped sorted subjects by group", () => {
    const result = buildTutorList(
      [
        { id: "g2", displayName: "Zed Tutor", supportedModality: "onsite" },
        { id: "g1", displayName: "Ada Tutor", supportedModality: "both" },
      ],
      [
        { groupId: "g1", subject: "Math" },
        { groupId: "g1", subject: "Physics" },
        { groupId: "g1", subject: "Math" },
        { groupId: "g2", subject: "Biology" },
      ],
    );

    expect(result).toEqual([
      {
        tutorGroupId: "g1",
        displayName: "Ada Tutor",
        supportedModes: ["online", "onsite"],
        subjects: ["Math", "Physics"],
      },
      {
        tutorGroupId: "g2",
        displayName: "Zed Tutor",
        supportedModes: ["onsite"],
        subjects: ["Biology"],
      },
    ]);
  });
});
