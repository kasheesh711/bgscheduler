import { describe, expect, it } from "vitest";
import {
  buildFeedbackMessages,
  chooseStudentDisplayName,
  parseStudentName,
  redactForModel,
  restoreStudentName,
} from "../prompt";
import { STUDENT_NAME } from "./fixtures";

const tutorNames = ["Kevin Hsieh", "Kev"];

describe("student names", () => {
  it("parses the Wise first name and bracketed nickname", () => {
    expect(parseStudentName(STUDENT_NAME)).toEqual({ firstName: "Somchai", nicknameCode: "Tom.Ja", nickname: "Tom" });
    expect(parseStudentName("Plain Name")).toEqual({ firstName: "Plain", nicknameCode: null, nickname: null });
  });

  it("uses whichever name the summary uses more", () => {
    expect(chooseStudentDisplayName("Somchai worked hard. Somchai asked questions. Tom smiled.", STUDENT_NAME)).toBe("Somchai");
    expect(chooseStudentDisplayName("Tom worked hard and Tom asked questions.", STUDENT_NAME)).toBe("Tom");
  });
});

describe("redactForModel", () => {
  it("removes every student and tutor name variant, including the nickname", () => {
    const text = "Kevin helped Somchai Jaidee (Tom.Ja). Tom did well; Kev praised Jaidee and Mr Hsieh agreed.";
    const redacted = redactForModel(text, { studentFullName: STUDENT_NAME, tutorNames });
    for (const name of ["Kevin", "Somchai", "Jaidee", "Tom", "Kev", "Hsieh"]) expect(redacted).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect(redacted).toContain("[STUDENT_1]");
    expect(redacted).toContain("[TUTOR]");
  });

  it("keeps ordinary words like 'online' and substrings of names", () => {
    const redacted = redactForModel("The online lesson covered tomatoes.", { studentFullName: STUDENT_NAME, tutorNames });
    expect(redacted).toBe("The online lesson covered tomatoes.");
  });

  it("restores the placeholder to the chosen display name", () => {
    expect(restoreStudentName("[STUDENT_1] improved; [STUDENT_1] should practise.", "Tom")).toBe("Tom improved; Tom should practise.");
  });
});

describe("buildFeedbackMessages", () => {
  it("sends only redacted summary text", () => {
    const [system, user] = buildFeedbackMessages({
      studentFullName: STUDENT_NAME,
      tutorNames,
      subject: "Mathematics",
      scheduledMinutes: 60,
      summary: { text: "Overview: Kevin and Somchai practised fractions.", meetingUUIDs: [] },
    });
    expect(system.role).toBe("system");
    expect(user.content).toContain("[TUTOR] and [STUDENT_1] practised fractions");
    expect(user.content).toContain("Scheduled length: 60 minutes");
    expect(`${system.content}${user.content}`).not.toMatch(/Somchai|Kevin/u);
  });
});
