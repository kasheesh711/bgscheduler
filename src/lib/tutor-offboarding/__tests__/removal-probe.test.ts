import { describe, expect, it, vi } from "vitest";
import type { WiseSession, WiseTeacher } from "@/lib/wise/types";
import { findRemovalProbeTarget, runRemovalProbe, type RemovalProbeDependencies } from "../removal-probe";

const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const input = { teacherId: id, confirmation: "remove-probe-teacher" };
const target: WiseTeacher = { _id: id, userId: { _id: userId, name: "ZZ BGS Removal Probe One" }, relation: "TEACHER", classes: [] };
const other: WiseTeacher = { _id: "cccccccccccccccccccccccc", userId: "dddddddddddddddddddddddd", name: "Teacher Example", relation: "TEACHER", classes: [] };
const session = (ref: Partial<WiseSession>): WiseSession => ({ _id: "session-example", scheduledStartTime: "2026-01-01T01:00:00Z", scheduledEndTime: "2026-01-01T02:00:00Z", ...ref });
const dependencies = (): RemovalProbeDependencies => ({
  readBefore: vi.fn().mockResolvedValue({ roster: [target, other], sessions: [] }),
  removeOnce: vi.fn().mockResolvedValue({ status: "sent" }), readAfter: vi.fn().mockResolvedValue([other]),
});

describe("owner-operated teacher removal probe", () => {
  it("requires explicit ID and typed confirmation before any network read", async () => {
    const deps = dependencies();
    await expect(runRemovalProbe({ ...input, confirmation: "yes" }, deps)).rejects.toMatchObject({ code: "typed_confirmation_required" });
    await expect(runRemovalProbe({ ...input, teacherId: "" }, deps)).rejects.toMatchObject({ code: "explicit_teacher_id_required" });
    expect(deps.readBefore).not.toHaveBeenCalled();
    expect(deps.removeOnce).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...target, userId: { _id: userId, name: "Teacher Example" } }, "probe_name_required"],
    [{ ...target, name: "Different Name" }, "probe_name_required"],
    [{ ...target, relation: "ADMIN" }, "probe_must_be_teacher"],
    [{ ...target, relation: undefined }, "probe_must_be_teacher"],
    [{ ...target, classes: undefined }, "probe_must_have_no_courses"],
    [{ ...target, classes: ["course-example"] }, "probe_must_have_no_courses"],
  ] satisfies Array<[WiseTeacher, string]>)("blocks unsafe target %#", (candidate, code) => {
    expect(() => findRemovalProbeTarget(input, [candidate, other], [])).toThrow(code);
  });

  it("blocks ambiguous roster and missing session identities", () => {
    expect(() => findRemovalProbeTarget(input, [], [])).toThrow("complete_nonempty_roster_required");
    expect(() => findRemovalProbeTarget(input, [target, { ...other, userId }], [])).toThrow("probe_user_must_be_unique");
    expect(() => findRemovalProbeTarget(input, [target, other], [session({})])).toThrow("session_teacher_unknown");
  });

  it.each([{ userId }, { teacherId: id }, { userId: other.userId, teacherId: id }])("blocks even past sessions linked by either ID: %j", ref => {
    expect(() => findRemovalProbeTarget(input, [target, other], [session(ref)])).toThrow("probe_must_have_no_sessions");
  });

  it("sends the user ID exactly once and requires absence by both identifiers", async () => {
    const deps = dependencies();
    expect(await runRemovalProbe(input, deps)).toMatchObject({ endpointVerified: true, readback: "absent", requestOutcome: "sent" });
    expect(deps.removeOnce).toHaveBeenCalledExactlyOnceWith(userId);
    deps.readAfter = vi.fn().mockResolvedValue([other, { ...target, _id: "eeeeeeeeeeeeeeeeeeeeeeee" }]);
    expect(await runRemovalProbe(input, deps)).toMatchObject({ endpointVerified: false, readback: "present" });
  });

  it.each([400, 500, null])("never retries failure %s or logs its body", async status => {
    const deps = dependencies();
    deps.removeOnce = vi.fn().mockRejectedValue(Object.assign(new Error("PRIVATE RESPONSE"), { status }));
    const result = await runRemovalProbe(input, deps);
    expect(result).toMatchObject({ requestOutcome: status === 400 ? "rejected" : "unknown", endpointVerified: false });
    expect(deps.removeOnce).toHaveBeenCalledExactlyOnceWith(userId);
    expect(deps.readAfter).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("PRIVATE RESPONSE");
  });

  it("keeps failed or empty readback unknown and sends no second request", async () => {
    for (const readAfter of [vi.fn().mockRejectedValue(new Error("read failed")), vi.fn().mockResolvedValue([])]) {
      const deps = { ...dependencies(), readAfter };
      expect(await runRemovalProbe(input, deps)).toMatchObject({ readback: "unknown", endpointVerified: false });
      expect(deps.removeOnce).toHaveBeenCalledOnce();
    }
  });

  it.each(["rejected", "unknown"] as const)("preserves a returned %s outcome even when readback is absent", async status => {
    const deps = dependencies();
    deps.removeOnce = vi.fn().mockResolvedValue({ status });
    expect(await runRemovalProbe(input, deps)).toMatchObject({ requestOutcome: status, readback: "absent", endpointVerified: false });
    expect(deps.removeOnce).toHaveBeenCalledOnce();
  });
});
