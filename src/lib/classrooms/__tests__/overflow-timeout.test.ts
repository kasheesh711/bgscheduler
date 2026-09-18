import { describe, expect, it, vi } from "vitest";
vi.mock("highs", async importOriginal => {
  const original = await importOriginal<typeof import("highs")>();
  return { ...original, default: async (...args: Parameters<typeof original.default>) => {
    const highs = await original.default(...args);
    const create = highs.createModel.bind(highs);
    highs.createModel = (...params) => {
      const model = create(...params), run = model.run.bind(model);
      model.run = () => { const result = run(); return { ...result, modelStatus: 13 }; };
      return model;
    };
    return highs;
  } };
});
import { assignClassrooms } from "../assignment-engine";
import { planClassroomOverflow } from "../overflow-planner";

describe("limited integer search", () => {
  it("retains a verified feasible incumbent without claiming minimality or impossibility", async () => {
    const rooms = [{ name: "A", active: true, hasTv: true, capacity: 2, category: "standard" as const, sortOrder: 0 }];
    const sessions = ["a", "b"].map(id => ({ groupId: id, wiseTeacherId: id, tutorDisplayName: id, wiseSessionId: id,
      wiseClassId: `class-${id}`, studentCount: 1, studentIds: [id], classType: "ONE_TO_ONE", sessionType: "OFFLINE",
      startTime: new Date("2099-09-19T09:00:00Z"), endTime: new Date("2099-09-19T10:00:00Z"), weekday: 6,
      startMinute: 540, endMinute: 600, wiseStatus: "CONFIRMED" }));
    const rows = assignClassrooms(sessions, rooms).rows;
    const result = await planClassroomOverflow({ rows, rooms, assignmentDate: "2099-09-19" });
    expect(result.plan).toMatchObject({ status: "best_found", minimumSwitches: null, rankingComplete: false, predictedRemainingOverflow: 0 });
    expect(result.actualRows.some(row => row.status === "no_room")).toBe(true);
  });
});
