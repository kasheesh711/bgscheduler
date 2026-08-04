import { describe, expect, it } from "vitest";

import { WiseCreditSessionSchema, creditSessionTeacher } from "@/lib/credit-control/wise";

function base() {
  return {
    _id: "ses_1",
    classId: { _id: "cls_1", name: "Maths", subject: "Mathematics" },
    scheduledStartTime: "2026-08-04T03:00:00Z",
    scheduledEndTime: "2026-08-04T04:30:00Z",
    meetingStatus: "SCHEDULED",
    duration: 5_400_000,
    students: ["stu_1"],
  };
}

describe("WiseCreditSessionSchema teacher widening", () => {
  it("still parses a payload with no teacher fields at all", () => {
    const parsed = WiseCreditSessionSchema.safeParse(base());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.teacherName).toBeUndefined();
    expect(parsed.data.userId).toBeUndefined();
  });

  it("accepts userId as a bare id string", () => {
    const parsed = WiseCreditSessionSchema.safeParse({ ...base(), userId: "usr_1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.userId).toBe("usr_1");
  });

  it("accepts userId as an expanded reference", () => {
    const parsed = WiseCreditSessionSchema.safeParse({
      ...base(),
      userId: { _id: "usr_1", name: "Kru Nok" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.userId).toMatchObject({ _id: "usr_1" });
  });
});

describe("creditSessionTeacher", () => {
  function parse(raw: Record<string, unknown>) {
    const parsed = WiseCreditSessionSchema.parse({ ...base(), ...raw });
    return creditSessionTeacher(parsed);
  }

  it("prefers the explicit teacherName", () => {
    expect(parse({ teacherName: "Kru Nok", userId: { _id: "u1", name: "Other" } }))
      .toMatchObject({ teacherName: "Kru Nok", wiseTeacherUserId: "u1" });
  });

  it("falls back to the expanded userId name", () => {
    expect(parse({ userId: { _id: "u1", name: "Kru Ploy" } }))
      .toMatchObject({ teacherName: "Kru Ploy", wiseTeacherUserId: "u1" });
  });

  it("returns nulls rather than guessing when Wise reports no teacher", () => {
    expect(parse({})).toEqual({
      wiseTeacherUserId: null,
      wiseTeacherId: null,
      teacherName: null,
    });
  });

  it("normalises blank and whitespace-only values to null", () => {
    expect(parse({ teacherName: "   ", teacherId: "  ", userId: "  " })).toEqual({
      wiseTeacherUserId: null,
      wiseTeacherId: null,
      teacherName: null,
    });
  });

  it("keeps a bare-string userId as the teacher user id", () => {
    expect(parse({ userId: "usr_9", teacherId: "t_9", teacherName: "Kru A" })).toEqual({
      wiseTeacherUserId: "usr_9",
      wiseTeacherId: "t_9",
      teacherName: "Kru A",
    });
  });
});
