import { describe, expect, it } from "vitest";
import { assignModelArms } from "../ab";

describe("assignModelArms", () => {
  const sessions = [
    { sessionId: "s1", classId: "c1", scheduledStartAt: new Date("2026-09-01") },
    { sessionId: "s2", classId: "c1", scheduledStartAt: new Date("2026-09-08") },
    { sessionId: "s3", classId: "c2", scheduledStartAt: new Date("2026-09-02") },
    { sessionId: "s4", classId: "c3", scheduledStartAt: new Date("2026-09-03") },
    { sessionId: "s5", classId: "c3", scheduledStartAt: new Date("2026-09-10") },
  ];

  it("is deterministic and splits within one", () => {
    const first = assignModelArms(sessions);
    expect(assignModelArms([...sessions].reverse())).toEqual(first);
    const glm = [...first.values()].filter((arm) => arm === "glm").length;
    expect(Math.abs(glm - (sessions.length - glm))).toBeLessThanOrEqual(1);
  });

  it("alternates consecutive lessons of the same class", () => {
    const arms = assignModelArms(sessions);
    expect(arms.get("s1")).not.toBe(arms.get("s2"));
    expect(arms.get("s4")).not.toBe(arms.get("s5"));
  });
});
