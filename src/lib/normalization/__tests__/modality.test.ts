import { describe, it, expect } from "vitest";
import { deriveModality } from "../modality";
import type { IdentityGroup } from "../identity";
import type { NormalizedSessionBlock } from "../sessions";

function makeGroup(overrides: Partial<IdentityGroup> = {}): IdentityGroup {
  return {
    canonicalKey: "Test",
    displayName: "Test",
    members: [
      { wiseTeacherId: "t1", wiseDisplayName: "Test Tutor", isOnlineVariant: false },
    ],
    ...overrides,
  };
}

describe("deriveModality", () => {
  it("returns 'both' for online/offline pair", () => {
    const group = makeGroup({
      members: [
        { wiseTeacherId: "t1", wiseDisplayName: "Aey", isOnlineVariant: false },
        { wiseTeacherId: "t2", wiseDisplayName: "Aey Online", isOnlineVariant: true },
      ],
    });

    const { modality, issue } = deriveModality(group, []);
    expect(modality).toBe("both");
    expect(issue).toBeNull();
  });

  it("returns 'online' for online-only group", () => {
    const group = makeGroup({
      members: [
        { wiseTeacherId: "t1", wiseDisplayName: "Aey Online", isOnlineVariant: true },
      ],
    });

    const { modality } = deriveModality(group, []);
    expect(modality).toBe("online");
  });

  it("derives from session type when no pair structure", () => {
    const group = makeGroup();
    const sessions: NormalizedSessionBlock[] = [
      {
        wiseSessionId: "s1",
        wiseTeacherId: "t1",
        startTime: new Date(),
        endTime: new Date(),
        weekday: 1,
        startMinute: 540,
        endMinute: 600,
        wiseStatus: "CONFIRMED",
        isBlocking: true,
        sessionType: "online",
      },
    ];

    const { modality } = deriveModality(group, sessions);
    expect(modality).toBe("online");
  });

  it("returns unresolved with issue for single offline member with no evidence", () => {
    const group = makeGroup();

    const { modality, issue } = deriveModality(group, []);
    expect(modality).toBe("unresolved");
    expect(issue).not.toBeNull();
    expect(issue!.type).toBe("modality");
  });
});
