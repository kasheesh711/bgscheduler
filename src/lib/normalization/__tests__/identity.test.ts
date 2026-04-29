import { describe, it, expect } from "vitest";
import {
  extractNickname,
  isOnlineVariant,
  getBaseName,
  resolveIdentities,
} from "../identity";
import type { WiseTeacher } from "@/lib/wise/types";

describe("extractNickname", () => {
  it("extracts nickname from parenthetical", () => {
    expect(extractNickname("Chinnakrit (Celeste) Channiti")).toBe("Celeste");
  });

  it("extracts nickname from online variant", () => {
    expect(extractNickname("Usanee (Aey) Tortermpun Online")).toBe("Aey");
  });

  it("returns null when no parenthetical", () => {
    expect(extractNickname("John Smith")).toBeNull();
  });

  it("handles multiple parentheticals by taking first", () => {
    expect(extractNickname("First (Nick) Last (Other)")).toBe("Nick");
  });
});

describe("isOnlineVariant", () => {
  it("detects Online suffix", () => {
    expect(isOnlineVariant("Usanee (Aey) Tortermpun Online")).toBe(true);
  });

  it("does not match without suffix", () => {
    expect(isOnlineVariant("Usanee (Aey) Tortermpun")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isOnlineVariant("Name online")).toBe(true);
  });
});

describe("getBaseName", () => {
  it("removes Online suffix", () => {
    expect(getBaseName("Usanee (Aey) Tortermpun Online")).toBe(
      "Usanee (Aey) Tortermpun"
    );
  });

  it("leaves non-online name unchanged", () => {
    expect(getBaseName("Usanee (Aey) Tortermpun")).toBe(
      "Usanee (Aey) Tortermpun"
    );
  });
});

describe("resolveIdentities", () => {
  const makeTeacher = (id: string, name: string): WiseTeacher => ({
    _id: id,
    name,
  });

  const makeNestedTeacher = (id: string, userId: string, name: string): WiseTeacher => ({
    _id: id,
    userId: {
      _id: userId,
      name,
    },
  });

  it("groups teachers by extracted nickname", () => {
    const teachers = [
      makeTeacher("t1", "Usanee (Aey) Tortermpun"),
      makeTeacher("t2", "Ratthapon (Da) Punpo"),
    ];

    const result = resolveIdentities(teachers, []);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.find((g) => g.canonicalKey === "Aey")).toBeDefined();
    expect(result.groups.find((g) => g.canonicalKey === "Da")).toBeDefined();
  });

  it("merges online/offline pairs into one group", () => {
    const teachers = [
      makeTeacher("t1", "Usanee (Aey) Tortermpun"),
      makeTeacher("t2", "Usanee (Aey) Tortermpun Online"),
    ];

    const result = resolveIdentities(teachers, []);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toHaveLength(2);
    expect(result.groups[0].members.find((m) => m.isOnlineVariant)).toBeDefined();
  });

  it("applies alias overrides", () => {
    const teachers = [makeTeacher("t1", "Someone (Kev) Last")];
    const aliases = [{ fromKey: "Kev", toKey: "Kevin" }];

    const result = resolveIdentities(teachers, aliases);
    expect(result.groups[0].canonicalKey).toBe("Kevin");
  });

  it("creates data issue for teachers without nickname", () => {
    const teachers = [makeTeacher("t1", "John Smith")];

    const result = resolveIdentities(teachers, []);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("alias");
    // Still creates a group for Needs Review
    expect(result.groups).toHaveLength(1);
  });

  it("handles all known alias mappings", () => {
    const teachers = [
      makeTeacher("t1", "X (Kev) Y"),
      makeTeacher("t2", "X (Paoju) Y"),
      makeTeacher("t3", "X (Poi) Y"),
      makeTeacher("t4", "X (Sam) Y"),
    ];
    const aliases = [
      { fromKey: "Kev", toKey: "Kevin" },
      { fromKey: "Paoju", toKey: "Paojuu" },
      { fromKey: "Poi", toKey: "Nacha (Poi)" },
      { fromKey: "Sam", toKey: "Samantha" },
    ];

    const result = resolveIdentities(teachers, aliases);
    const keys = result.groups.map((g) => g.canonicalKey);
    expect(keys).toContain("Kevin");
    expect(keys).toContain("Paojuu");
    expect(keys).toContain("Nacha (Poi)");
    expect(keys).toContain("Samantha");
  });

  it("resolution order: exact → nickname → alias → unresolved", () => {
    const teachers = [
      makeTeacher("t1", "Person (Nick) Name"), // nickname extracted
      makeTeacher("t2", "Plain Name"), // no nickname → issue
    ];

    const result = resolveIdentities(teachers, []);
    expect(result.groups).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].entityId).toBe("t2");
  });

  it("uses nested Wise user identity fields when present", () => {
    const teachers = [
      makeNestedTeacher("t1", "u1", "Usanee (Aey) Tortermpun"),
      makeNestedTeacher("t2", "u2", "Usanee (Aey) Tortermpun Online"),
    ];

    const result = resolveIdentities(teachers, []);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toEqual([
      expect.objectContaining({
        wiseTeacherId: "t1",
        wiseUserId: "u1",
        wiseDisplayName: "Usanee (Aey) Tortermpun",
      }),
      expect.objectContaining({
        wiseTeacherId: "t2",
        wiseUserId: "u2",
        wiseDisplayName: "Usanee (Aey) Tortermpun Online",
      }),
    ]);
  });
});

describe("resolveIdentities — REL-03 identity collision detection", () => {
  const teacher = (id: string, name: string): WiseTeacher => ({
    _id: id,
    name,
  });

  it("emits identity_collision issue when 3 teachers share a nickname (none online)", () => {
    const teachers = [
      teacher("t1", "Alice (Kev) Smith"),
      teacher("t2", "Bob (Kev) Jones"),
      teacher("t3", "Carol (Kev) Lee"),
    ];
    const { issues } = resolveIdentities(teachers, []);
    const collisions = issues.filter((i) =>
      i.message.startsWith("identity_collision:")
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0].type).toBe("alias");
    expect(collisions[0].message).toContain("Kev");
    expect(collisions[0].message).toContain("3 teachers");
  });

  it("does NOT emit collision for legitimate online/offline pair (1 online + 1 offline)", () => {
    const teachers = [
      teacher("t1", "Alice (Kev) Smith"),
      teacher("t2", "Alice (Kev) Smith Online"),
    ];
    const { issues } = resolveIdentities(teachers, []);
    const collisions = issues.filter((i) =>
      i.message.startsWith("identity_collision:")
    );
    expect(collisions).toHaveLength(0);
  });

  it("does NOT emit collision for a solo teacher", () => {
    const teachers = [teacher("t1", "Alice (Kev) Smith")];
    const { issues } = resolveIdentities(teachers, []);
    const collisions = issues.filter((i) =>
      i.message.startsWith("identity_collision:")
    );
    expect(collisions).toHaveLength(0);
  });

  it("emits collision when 3 teachers share nickname with mixed online/offline (not a legitimate pair)", () => {
    const teachers = [
      teacher("t1", "Alice (Kev) Smith"),
      teacher("t2", "Bob (Kev) Jones Online"),
      teacher("t3", "Carol (Kev) Lee Online"),
    ];
    const { issues } = resolveIdentities(teachers, []);
    const collisions = issues.filter((i) =>
      i.message.startsWith("identity_collision:")
    );
    expect(collisions).toHaveLength(1);
  });

  it("emits collision for 2 teachers with same nickname that are NOT online/offline pair (e.g. both offline)", () => {
    const teachers = [
      teacher("t1", "Alice (Kev) Smith"),
      teacher("t2", "Bob (Kev) Jones"),
    ];
    const { issues } = resolveIdentities(teachers, []);
    const collisions = issues.filter((i) =>
      i.message.startsWith("identity_collision:")
    );
    expect(collisions).toHaveLength(1);
  });
});
