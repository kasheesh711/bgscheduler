import { describe, expect, it } from "vitest";
import { resolvePostClassParticipantName } from "../participant-name";

describe("participant name evidence", () => {
  const known = { wiseStudentId: "student-1", studentName: "Pongsagorn (Johannes.Kh) Khwanphuk " };
  it("expands a first name using the same stable Wise student ID", () => {
    expect(resolvePostClassParticipantName({ wiseStudentId: "student-1", studentName: "Pongsagorn" }, known))
      .toBe("Pongsagorn (Johannes.Kh) Khwanphuk");
  });
  it("never infers identity from a matching first name", () => {
    expect(resolvePostClassParticipantName({ wiseStudentId: "student-2", studentName: "Pongsagorn" }, known))
      .toBe("Pongsagorn");
  });
  it("preserves a conflicting first-hand detail name", () => {
    expect(resolvePostClassParticipantName({ wiseStudentId: "student-1", studentName: "A different full name" }, known))
      .toBe("A different full name");
  });
  it("retains explicit fallback behaviour for unnamed participants", () => {
    expect(resolvePostClassParticipantName({ wiseStudentId: "student-1", studentName: null }, known))
      .toBe("Pongsagorn (Johannes.Kh) Khwanphuk");
    expect(resolvePostClassParticipantName({ wiseStudentId: "student-2", studentName: null }, known))
      .toBe("student-2");
  });
});
