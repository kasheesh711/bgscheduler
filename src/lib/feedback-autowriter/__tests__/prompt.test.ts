import { describe, expect, it } from "vitest";
import {
  buildFeedbackMessages,
  chooseStudentDisplayName,
  describeClass,
  parseStudentName,
  redactForModel,
  restoreStudentName,
  speakerLabelNote,
} from "../prompt";
import { STUDENT_NAME } from "./fixtures";

const tutorNames = ["Kevin Hsieh", "Kev"];

describe("student names", () => {
  it("parses the Wise first name and bracketed nickname", () => {
    expect(parseStudentName(STUDENT_NAME)).toEqual({ firstName: "Somchai", nicknameCode: "Tom.Ja", nickname: "Tom" });
    expect(parseStudentName("Plain Name")).toEqual({ firstName: "Plain", nicknameCode: null, nickname: null });
  });

  it("calls the student by their nickname", () => {
    // Always the nickname (before the dot in the brackets), however the summary names the student.
    expect(chooseStudentDisplayName(STUDENT_NAME)).toBe("Tom");
    expect(chooseStudentDisplayName("Worawut (Bas.Ho) Horburapa")).toBe("Bas");
    expect(chooseStudentDisplayName("Avarin (Ava.Si) Sirithienthong")).toBe("Ava");
    expect(chooseStudentDisplayName("Prannatee (Keene.Ka) Karnchanapoo")).toBe("Keene");
    // No nickname in the Wise name, or odd bracket contents: the first name.
    expect(chooseStudentDisplayName("Somchai Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (.Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (Tom Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (K.Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Thanyapat (Baikao.Na) Natarue")).toBe("Baikao");
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
      classDetails: describeClass({ programme: "11+/13+", title: "Live Session - NVR" }),
      scheduledMinutes: 60,
      summary: { text: "Overview: Kevin and Somchai practised fractions.", meetingUUIDs: [] },
    });
    expect(system.role).toBe("system");
    expect(user.content).toContain("[TUTOR] and [STUDENT_1] practised fractions");
    expect(user.content).toContain("Scheduled length: 60 minutes");
    expect(user.content).toContain("- Programme: 11+/13+");
    expect(user.content).toContain("- Class subject: NVR");
    expect(system.content).toContain("Use them only to name the programme and subject correctly");
    // Today's live drafts were rejected for unsupported praise ("engaged well", "handled confidently").
    expect(system.content).toContain("Every judgement of how well [STUDENT_1] did");
    expect(`${system.content}${user.content}`).not.toMatch(/Somchai|Kevin/u);
  });
});

describe("redacting a guest name that stood in for the student", () => {
  it("hides the guest name as the same student, [STUDENT_1]", () => {
    const names = { studentFullName: "Pawin (Pete.Th) Thanasatitkul", studentAliases: ["Pete Thanasatitkul"], tutorNames: [] };
    expect(redactForModel("Pete Thanasatitkul joined late. Thanasatitkul answered well; Pete asked about ratios.", names))
      .toBe("[STUDENT_1] joined late. [STUDENT_1] answered well; [STUDENT_1] asked about ratios.");
    // A guest name unrelated to the Wise name is the same student too — never [STUDENT_2].
    const sibling = redactForModel("Mali Jaidee answered, and Mali checked the ratio.",
      { studentFullName: "Pawin (Pete.Th) Thanasatitkul", studentAliases: ["Mali Jaidee"], tutorNames: [] });
    expect(sibling).toBe("[STUDENT_1] answered, and [STUDENT_1] checked the ratio.");
    // Device words and one-letter words in a guest name leave the lesson text alone.
    expect(redactForModel("We used a Zoom whiteboard on the iPad.", { ...names, studentAliases: ["Zoom user", "A"] }))
      .toBe("We used a Zoom whiteboard on the iPad.");
    // Words of a guest name match only where written as a name.
    expect(redactForModel("May said she may need practice; it was a win for Win.", { ...names, studentAliases: ["May Win"] }))
      .toBe("[STUDENT_1] said she may need practice; it was a win for [STUDENT_1].");
  });
});

describe("transcript mode", () => {
  it("writes from a transcript in English and credits only what the student did", () => {
    const [system, user] = buildFeedbackMessages({
      studentFullName: STUDENT_NAME,
      tutorNames,
      classDetails: ["Programme: Y9-11 / G8-10 (Int.)", "Class subject: Math"],
      scheduledMinutes: 60,
      summary: { text: "[00:00] TUTOR: Somchai, let's try question 3\n[00:05] STUDENT: x equals 4", meetingUUIDs: [] },
      evidence: "transcript",
    });
    expect(system.content).toContain("automatic transcript of the lesson");
    expect(system.content).toContain("always write in English");
    expect(system.content).toContain("covered, not mastered");
    expect(user.content).toContain("Lesson transcript:");
    expect(user.content).not.toContain("Somchai");
    // Labels are only called reliable when Zoom confirmed them.
    expect(system.content).toContain("were inferred from who talked most");
  });

  it("tells the writer the speaker labels are reliable only when Zoom confirmed them", () => {
    const [system] = buildFeedbackMessages({
      studentFullName: STUDENT_NAME,
      tutorNames,
      classDetails: [],
      scheduledMinutes: 60,
      summary: { text: "[00:00] TUTOR: let's try question 3", meetingUUIDs: [] },
      evidence: "transcript",
      speakerLabels: "verified",
    });
    expect(system.content).not.toContain("were inferred from who talked most");
    expect(system.content).toContain(speakerLabelNote("verified"));
  });
});

describe("describeClass", () => {
  it("takes the programme from the Wise subject and the subject from the session title", () => {
    expect(describeClass({ programme: "11+/13+", title: "Live Session - NVR" })).toEqual([
      "Programme: 11+/13+",
      "Class subject: NVR",
      "Terms: 11+/13+ = the ISEB 11+/13+ entrance tests; NVR (Non VR) = Non-Verbal Reasoning",
    ]);
    expect(describeClass({ programme: "Y9-11 / G8-10 (Int.)", title: "Online Session - Chemistry (Cancelled)" })).toEqual([
      "Programme: Y9-11 / G8-10 (Int.)",
      "Class subject: Chemistry",
    ]);
  });

  it("expands only confirmed terms, as whole words", () => {
    expect(describeClass({ programme: "11+/13+", title: "Live Session-Non VR" }).at(-1))
      .toBe("Terms: 11+/13+ = the ISEB 11+/13+ entrance tests; NVR (Non VR) = Non-Verbal Reasoning");
    expect(describeClass({ programme: "11+/13+", title: "Live Session - Math VR" }).at(-1))
      .toBe("Terms: 11+/13+ = the ISEB 11+/13+ entrance tests; VR = Verbal Reasoning");
    expect(describeClass({ programme: "11+/13+ Master", title: "Live Session - NVR+Math" }).at(-1))
      .toBe("Terms: 11+/13+ = the ISEB 11+/13+ entrance tests; NVR (Non VR) = Non-Verbal Reasoning");
    expect(describeClass({ programme: "Y9-11 / G8-10 (Int.)", title: "Live Session-Sci" }).at(-1)).toBe("Terms: Sci = Science");
    expect(describeClass({ programme: "University", title: "Live Session - Scientific Writing" }))
      .toEqual(["Programme: University", "Class subject: Scientific Writing"]);
  });

  it("drops empty or bare titles and passes unknown wording through", () => {
    expect(describeClass({ programme: "Y2-8 / G1-7 (Int.)", title: "Live Session" })).toEqual(["Programme: Y2-8 / G1-7 (Int.)"]);
    expect(describeClass({ programme: null, title: undefined })).toEqual([]);
    expect(describeClass({ programme: null, title: "Mock test ISEB" })).toEqual(["Class subject: Mock test ISEB"]);
  });
});
