import { describe, expect, it } from "vitest";
import {
  FEEDBACK_JSON_SCHEMA,
  PROMPT_VERSION,
  buildFeedbackMessages,
  chooseStudentDisplayName,
  describeClass,
  otherPeopleNamed,
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
    expect(chooseStudentDisplayName("Narong (Tae.Sr) Srisuk")).toBe("Tae");
    expect(chooseStudentDisplayName("Kanya (Kan.Su) Suksai")).toBe("Kan");
    expect(chooseStudentDisplayName("Siriporn (Nicky.Wo) Wongsa")).toBe("Nicky");
    // No nickname in the Wise name, or odd bracket contents: the first name.
    expect(chooseStudentDisplayName("Somchai Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (.Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (Tom Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Somchai (K.Ja) Jaidee")).toBe("Somchai");
    expect(chooseStudentDisplayName("Kanokwan (Namwan.Ja) Jaidee")).toBe("Namwan");
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

  it("hides the first word of an odd bracket code as well, only where it is written as a name", () => {
    // "(Tom Ja)" is not a usable nickname, but a summary still calls the student "Tom".
    const odd = { studentFullName: "Somchai (Tom Ja) Jaidee", tutorNames };
    expect(redactForModel("Tom read the poem; a tom cat is in it. Tom Ja answered, and Tom's notes were tidy.", odd))
      .toBe("[STUDENT_1] read the poem; a tom cat is in it. [STUDENT_1] answered, and [STUDENT_1]'s notes were tidy.");
    // A code written in lower case is still hidden where the summary capitalises it.
    expect(redactForModel("Tom said hi.", { ...odd, studentFullName: "Somchai (tom ja) Jaidee" })).toBe("[STUDENT_1] said hi.");
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
    const names = { studentFullName: "Wichai (Krit.Ka) Kaewmanee", studentAliases: ["Krit Kaewmanee"], tutorNames: [] };
    expect(redactForModel("Krit Kaewmanee joined late. Kaewmanee answered well; Krit asked about ratios.", names))
      .toBe("[STUDENT_1] joined late. [STUDENT_1] answered well; [STUDENT_1] asked about ratios.");
    // A guest name unrelated to the Wise name is the same student too — never [STUDENT_2].
    const sibling = redactForModel("Mali Jaidee answered, and Mali checked the ratio.",
      { studentFullName: "Wichai (Krit.Ka) Kaewmanee", studentAliases: ["Mali Jaidee"], tutorNames: [] });
    expect(sibling).toBe("[STUDENT_1] answered, and [STUDENT_1] checked the ratio.");
    // Device words and one-letter words in a guest name leave the lesson text alone.
    expect(redactForModel("We used a Zoom whiteboard on the iPad.", { ...names, studentAliases: ["Zoom user", "A"] }))
      .toBe("We used a Zoom whiteboard on the iPad.");
    // Words of a guest name match only where written as a name.
    expect(redactForModel("May said she may need practice; it was a win for Win.", { ...names, studentAliases: ["May Win"] }))
      .toBe("[STUDENT_1] said she may need practice; it was a win for [STUDENT_1].");
  });

  it("hides the bare name of a possessive guest name, and keeps the possessive natural", () => {
    const names = { studentFullName: STUDENT_NAME, tutorNames, studentAliases: ["Nathan\u2019s iPad"] };
    const redacted = redactForModel("Nathan\u2019s iPad joined. Nathan answered well; Nathan\u2019s notes and Nathan's diagram were tidy.", names);
    expect(redacted).toBe("[STUDENT_1] joined. [STUDENT_1] answered well; [STUDENT_1]\u2019s notes and [STUDENT_1]'s diagram were tidy.");
    expect(restoreStudentName(redacted, "Tom")).toBe("Tom joined. Tom answered well; Tom\u2019s notes and Tom's diagram were tidy.");
    // A straight apostrophe in the guest name works the same, as do a bare trailing apostrophe and one inside a name.
    expect(redactForModel("Nathan answered well.", { ...names, studentAliases: ["Nathan's iPad"] })).toBe("[STUDENT_1] answered well.");
    expect(redactForModel("James answered, then O\u2019Brien.", { ...names, studentAliases: ["James\u2019 iPad", "Ann O\u2019Brien"] }))
      .toBe("[STUDENT_1] answered, then [STUDENT_1].");
  });

  it("never takes the family member or place a device belongs to for the student", () => {
    // The student joined on someone else's device: the whole guest name is them, its owner is not.
    const names = { studentFullName: STUDENT_NAME, tutorNames };
    expect(redactForModel("Mom asked about the exam.", { ...names, studentAliases: ["Mom's iPad"] })).toBe("Mom asked about the exam.");
    expect(redactForModel("Mom's iPad answered first.", { ...names, studentAliases: ["Mom's iPad"] })).toBe("[STUDENT_1] answered first.");
    expect(redactForModel("Mae asked about the exam, and Dad listened from the Office.",
      { ...names, studentAliases: ["Mae iPad", "Dad\u2019s Phone", "Office PC"] }))
      .toBe("Mae asked about the exam, and Dad listened from the Office.");
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

describe("v4 rules (30 Sep)", () => {
  const messages = (evidence: "summary" | "transcript", text: string) => buildFeedbackMessages({
    studentFullName: STUDENT_NAME,
    tutorNames,
    classDetails: ["Programme: Y9-11 / G8-10 (Int.)", "Class subject: English"],
    scheduledMinutes: 60,
    summary: { text, meetingUUIDs: [] },
    evidence,
  });

  it("is prompt version 4 and asks for homework only when the tutor clearly set it", () => {
    expect(PROMPT_VERSION).toBe(4);
    expect(FEEDBACK_JSON_SCHEMA.properties.homework.description)
      .toBe("Only homework the tutor clearly set for after this lesson, with timing; empty string if none or unclear.");
  });

  it("keeps improvement to suggestions and homework to what the tutor set, in both modes; a summary's Next steps are not homework", () => {
    for (const [evidence, record] of [["summary", "the summary"], ["transcript", "the transcript"]] as const) {
      const [system] = messages(evidence, "[00:00] TUTOR: we read chapter two");
      expect(system.content).toContain(
        "6. improvement: the specific weak areas and two or three concrete next steps or strategies to practise before the next lesson, " +
        "written as suggestions — never as homework the tutor set, and never repeating the homework.",
      );
      // Owner decision (30 Sep): Wise's "Next steps: …" summary line is not homework the tutor set. A transcript has
      // no such line, so its rule 7 is unchanged.
      const nextSteps = evidence === "summary"
        ? "A \"Next steps\" line in the summary is the summary's own suggestion, not homework the tutor set. "
        : "";
      expect(system.content.split("\n").find((line) => line.startsWith("7. "))).toBe(
        `7. homework: only work ${record} shows the tutor clearly setting [STUDENT_1] to do after this lesson, with its timing if stated. ` +
        "Work only described as remaining, unfinished, left over or still to complete is not homework unless the tutor set it. " +
        nextSteps +
        `If ${record} does not clearly show the tutor setting homework, return an empty string. ` +
        "Never repeat or restate the homework in topics, performance or improvement.",
      );
      if (evidence === "transcript") expect(system.content).not.toContain("Next steps");
      // Rules 1-5 and 8-10 are unchanged.
      for (const rule of [
        `1. Use only facts stated or clearly implied by ${record}. Never invent scores, topics, materials, homework, dates or events.`,
        "2. Never mention attendance, absence, lateness, cancellation, rescheduling, technical problems, recordings, transcripts, Zoom, AI or the summary itself.",
        "3. Warm, clear, professional English that a parent can read.",
        "4. topics: the specific skills, sub-topics, question types, texts or papers covered.",
        "5. performance: concrete observations of what [STUDENT_1] did well and found difficult, with examples from this lesson.",
        "8. Length: topics, performance and improvement are each between 120 and 600 characters, and together at least 450 characters.",
        `9. studentAttended is true only if ${record} shows the student actively took part; lessonHappened is true only if a real lesson took place.`,
        "10. The class details come from the school's system and are accurate. Use them only to name the programme and subject correctly;",
      ]) expect(system.content).toContain(rule);
    }
  });

  it("tells the writer who did what: from the summary, any other name is someone else", () => {
    const [system] = messages("summary", "Overview: [TUTOR] and [STUDENT_1] read a poem.");
    expect(system.content).toContain(
      "11. Who did what: in the summary the student is always [STUDENT_1] and the tutor [TUTOR]. " +
      "Any other name belongs to someone else — another student, a family member, a friend, or a person or character in the lesson material — " +
      "never to [STUDENT_1], even when the summary seems to be about them. " +
      "Never give [STUDENT_1] anything the summary says [TUTOR] or another named person did, said, finished or did not finish.",
    );
    expect(system.content).not.toContain("12.");
  });

  it("tells the writer who did what in a transcript, then keeps the covered-not-mastered and Thai-name rules as 12 and 13", () => {
    const [system] = messages("transcript", "[00:00] TUTOR: we read chapter two");
    expect(system.content).toContain(
      "11. Who did what: only the lines labelled STUDENT are [STUDENT_1]'s own words and work; the lines labelled TUTOR are the tutor's. " +
      "Anyone named in the lesson who is clearly not the student — another student, a family member, a friend, or a person or character in the lesson material — " +
      "is never [STUDENT_1]: never give [STUDENT_1] what is said about them.",
    );
    expect(system.content).toContain("12. Something the tutor explained was covered, not mastered:");
    expect(system.content).toContain("13. Names in the transcript may be written in Thai script;");
  });

  it("names the other people in the summary on a line before it, only when there are any", () => {
    // Shaped like the 29 Sep summary: the only name left after redaction was another student's.
    const [, user] = messages("summary",
      "Kevin expressed concerns about incomplete exam preparation, noting that Nathan mentioned only 8 pages when there were 10 pages total.");
    const line = "Other people named in the summary (never [STUDENT_1]): Nathan";
    expect(user.content).toContain(`${line}\n\nLesson summary:\n[TUTOR] expressed concerns`);
    expect(user.content.indexOf(line)).toBeGreaterThan(user.content.indexOf("Scheduled length: 60 minutes"));

    const [, plain] = messages("summary", "Overview: Kevin and Somchai practised fractions; Somchai said he found it easy.");
    expect(plain.content).not.toContain("Other people named");

    // Transcript mode never gets the line.
    const [, transcript] = messages("transcript", "[00:00] TUTOR: Nathan said he finished 8 pages\n[00:05] STUDENT: I finished 6");
    expect(transcript.content).not.toContain("Other people named");
  });

  it("uses the list it is given instead of working it out again", () => {
    const [, user] = buildFeedbackMessages({
      studentFullName: STUDENT_NAME,
      tutorNames,
      classDetails: [],
      scheduledMinutes: 60,
      summary: { text: "Nathan mentioned only 8 pages.", meetingUUIDs: [] },
      otherPeople: [],
    });
    expect(user.content).not.toContain("Other people named");
  });
});

describe("otherPeopleNamed", () => {
  const redact = (text: string, studentFullName = STUDENT_NAME) => redactForModel(text, { studentFullName, tutorNames });

  it("finds the other student a summary names next to ours", () => {
    const summary = redact("Kevin expressed concerns about incomplete exam preparation, noting that Nathan mentioned only 8 pages " +
      "when there were 10 pages total. Somchai said he had finished the first section.");
    expect(otherPeopleNamed(summary, STUDENT_NAME)).toEqual(["Nathan"]);
  });

  it("finds a name written in quotes", () => {
    expect(otherPeopleNamed("[TUTOR] wrote: 'Nathan mentioned only 8 pages', and \u2018Ploy said 9\u2019.", STUDENT_NAME)).toEqual(["Nathan", "Ploy"]);
  });

  it("finds nobody when the summary only has the placeholders", () => {
    expect(otherPeopleNamed("[TUTOR] said [STUDENT_1] did well. [STUDENT_1] also finished the quiz and [TUTOR] explained ratios.", STUDENT_NAME))
      .toEqual([]);
  });

  it("never lists a placeholder, even next to a character from the lesson material", () => {
    const people = otherPeopleNamed(
      "[STUDENT_1] read the scene where Lady Macbeth says her hands will never be clean, and [TUTOR] asked what [STUDENT_1] noted.",
      STUDENT_NAME,
    );
    // A character in the text is a harmless extra; a placeholder never is.
    for (const person of people) expect(person).not.toMatch(/STUDENT|TUTOR|\[/u);
    expect(people).toEqual(["Macbeth"]);
  });

  it("leaves out names that start with the student's nickname or first name", () => {
    const student = "Anan (Tim.Wo) Wongsa";
    const summary = redact("Kevin checked the essay. Timothy said he had not finished the conclusion. Ananda asked about commas. " +
      "Nathan asked about the deadline.", student);
    expect(summary).toContain("Timothy said");
    expect(otherPeopleNamed(summary, student)).toEqual(["Nathan"]);
    // An odd bracket code gives its first word: "(Tom Ja)" means "Tom". Redaction now hides it, and the hint would
    // still leave it out if it slipped through.
    const odd = "Somchai (Tom Ja) Jaidee";
    expect(redact("Tom said he finished. Nathan said he did not.", odd)).toBe("[STUDENT_1] said he finished. Nathan said he did not.");
    expect(otherPeopleNamed("Tom said he finished. Nathan said he did not.", odd)).toEqual(["Nathan"]);
  });

  it("leaves out a two-letter nickname only as itself: a longer name starting with it is someone else", () => {
    // Shaped like the 29 Sep summary, for a student called "Ma" and another student whose name starts with "Ma".
    const student = "Chai (Ma.Pr) Jaidee";
    const summary = redact("Kevin expressed concerns about incomplete exam preparation, noting that Marco mentioned only 8 pages " +
      "when there were 10 pages total.", student);
    expect(otherPeopleNamed(summary, student)).toEqual(["Marco"]);
    expect(otherPeopleNamed("Ma said she finished. Marco said he did not.", student)).toEqual(["Marco"]);
  });

  it("leaves out Thai forms of address, and lists a name once however it is written", () => {
    expect(otherPeopleNamed("Nong said the passage was hard. Kru explained it again, and Khun asked about the test.", STUDENT_NAME)).toEqual([]);
    // "Zoë said" ranks before "Nathan's was" (a speech verb before a state verb).
    expect(otherPeopleNamed("Nathan's was the longest answer. Zoe\u0308 said yes. Zo\u00eb also said no.", STUDENT_NAME))
      .toEqual(["Zo\u00eb", "Nathan"]);
  });

  it("keeps a day or month that reports speech — May, June and April are nicknames too — and still leaves out dates", () => {
    expect(otherPeopleNamed("[TUTOR] noted that May mentioned only 8 pages.", STUDENT_NAME)).toEqual(["May"]);
    expect(otherPeopleNamed("June also asked about the test, and April\u2019s answer was short.", STUDENT_NAME)).toEqual(["June"]);
    expect(otherPeopleNamed("May is exam month. April was busy, Monday had two lessons and June finished early.", STUDENT_NAME)).toEqual([]);
  });

  it("knows reporting verbs and n't forms, with either apostrophe", () => {
    expect(otherPeopleNamed("Anya reported 9. Bram shared his notes. Cleo stated it. Dara indicated yes. Emil confirmed.", STUDENT_NAME))
      .toEqual(["Anya", "Bram", "Cleo", "Dara", "Emil"]);
    expect(otherPeopleNamed("Nathan didn\u2019t finish. Ploy didn't start. Faye hadn't read it. Gino hasn\u2019t begun. Hana wasn't there.", STUDENT_NAME))
      .toEqual(["Nathan", "Ploy", "Faye", "Gino", "Hana"]);
  });

  it("ranks names before speech and action verbs ahead of sentence-initial nouns, then caps the list", () => {
    const nouns = ["Progress was steady.", "Accuracy has improved.", "Timing was better.", "Vocabulary was stronger.",
      "Grammar has improved.", "Spelling was careful.", "Handwriting was neat.", "Reading was fluent.", "Focus was good."];
    const people = otherPeopleNamed(`${nouns.join(" ")} [TUTOR] noted that Nathan mentioned only 8 pages.`, STUDENT_NAME);
    expect(people).toEqual(["Nathan", "Progress", "Accuracy", "Timing", "Vocabulary", "Grammar", "Spelling", "Handwriting"]);
    // Each name once, in its best rank, and in first-seen order within a rank.
    expect(otherPeopleNamed("Nathan was there. Ploy said hi. Nathan said bye. Anya had a question.", STUDENT_NAME))
      .toEqual(["Ploy", "Nathan", "Anya"]);
  });

  it("leaves out the name words of the student's guest names, but not the family member whose device it was", () => {
    // A guest name written in lower case is not redacted where the summary capitalises it; it is still the student.
    const names = { studentFullName: STUDENT_NAME, tutorNames, studentAliases: ["nathan ipad", "Mae iPad"] };
    const text = "Nathan said he finished. Mae asked about the test.";
    expect(redactForModel(text, names)).toBe(text);
    expect(otherPeopleNamed(text, STUDENT_NAME, [], names.studentAliases)).toEqual(["Mae"]);
    // The writer works the list out the same way when it is not given one.
    const [, user] = buildFeedbackMessages({ ...names, classDetails: [], scheduledMinutes: 60, summary: { text, meetingUUIDs: [] } });
    expect(user.content).toContain("Other people named in the summary (never [STUDENT_1]): Mae\n");
  });

  it("leaves out common words, days and months, the class details and our terms", () => {
    const summary = "The student said the essay was hard. Homework was set on Monday. Chemistry was the focus. " +
      "Reasoning is improving, Non-Verbal was new and NVR was reviewed. Teacher said April is exam month. Nathan was there too.";
    expect(otherPeopleNamed(summary, STUDENT_NAME, ["Class subject: Chemistry"])).toEqual(["Nathan"]);
    // Without the class details, the subject looks like a name: the hint is only ever a hint.
    expect(otherPeopleNamed(summary, STUDENT_NAME)).toEqual(["Chemistry", "Nathan"]);
  });

  it("allows also/only/just/then/still before the verb, lists each name once and at most 8", () => {
    expect(otherPeopleNamed("Nathan also said yes. Nathan still had one page. Ploy just finished.", STUDENT_NAME)).toEqual(["Nathan", "Ploy"]);
    const ten = ["Anya", "Bram", "Cleo", "Dara", "Emil", "Faye", "Gino", "Hana", "Ivo", "Juno"];
    expect(otherPeopleNamed(ten.map((name) => `${name} said hello.`).join(" "), STUDENT_NAME)).toEqual(ten.slice(0, 8));
  });
});
