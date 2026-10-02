import { describe, expect, it } from "vitest";
import { AUTOWRITER_JUDGE_EFFORTS } from "../config";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_PROMPT_VERSION,
  StoredJudgeVerdictSchema,
  buildJudgeMessages,
  combineJudgeVerdicts,
  judgeProblems,
  parseJudgeOutput,
  passingStoredVerdict,
} from "../judge";
import { speakerLabelNote } from "../prompt";

const CLEAN = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
const verdict = (patch: Record<string, unknown>) => JSON.stringify({ ...CLEAN, ...patch });

const FIELDS = {
  topics: "We read two poems and compared their imagery.",
  performance: "[STUDENT_1] found three similes in the first poem.",
  improvement: "Practise explaining the effect of each image in one sentence.",
  homework: "",
};

describe("judge output (the v4 verdict each level returns)", () => {
  it("parses a complete four-field verdict", () => {
    expect(JUDGE_JSON_SCHEMA.required).toEqual(["faithful", "unsupported", "misattributed", "homeworkNotSet"]);
    expect(parseJudgeOutput(JSON.stringify(CLEAN))).toEqual(CLEAN);
    expect(parseJudgeOutput(`\`\`\`json\n${JSON.stringify(CLEAN)}\n\`\`\``)).toEqual(CLEAN);
  });

  it("fails closed on a verdict missing a list (a v3-shaped reply), an extra key, or no JSON", () => {
    expect(parseJudgeOutput(JSON.stringify({ faithful: true, unsupported: [] }))).toBeNull();
    expect(parseJudgeOutput(JSON.stringify({ faithful: true, unsupported: [], misattributed: [] }))).toBeNull();
    expect(parseJudgeOutput(verdict({ notes: "fine" }))).toBeNull();
    expect(parseJudgeOutput(verdict({ misattributed: "none" }))).toBeNull();
    expect(parseJudgeOutput("nope")).toBeNull();
  });

  it("treats a self-contradicting verdict as unfaithful, whichever list is non-empty", () => {
    expect(parseJudgeOutput(verdict({ unsupported: ["x"] }))).toEqual({ ...CLEAN, faithful: false, unsupported: ["x"] });
    expect(parseJudgeOutput(verdict({ misattributed: ["y"] }))).toEqual({ ...CLEAN, faithful: false, misattributed: ["y"] });
    expect(parseJudgeOutput(verdict({ homeworkNotSet: ["z"] }))).toEqual({ ...CLEAN, faithful: false, homeworkNotSet: ["z"] });
  });

  it("lists every problem, wrong-person ones first, then homework ones, then unsupported claims", () => {
    // First, so a hold reason cut to three problems or an alert cut to 200 characters still names them.
    expect(judgeProblems({
      unsupported: ["scored 95%", "read chapter four aloud", "used a timer"],
      misattributed: ["[STUDENT_1] said 8 of the 10 pages have been covered"],
      homeworkNotSet: ["finish the three remaining problems"],
    })).toEqual([
      "wrong person: [STUDENT_1] said 8 of the 10 pages have been covered",
      "homework not set: finish the three remaining problems",
      "scored 95%",
      "read chapter four aloud",
      "used a timer",
    ]);
    // A stored v3 verdict read with empty new lists keeps its unsupported quotes as they were.
    expect(judgeProblems({ unsupported: ["scored 95%", "used a timer"], misattributed: [], homeworkNotSet: [] }))
      .toEqual(["scored 95%", "used a timer"]);
  });

  it("describes the lists by the lesson record, not the summary: transcript mode sends the same schema", () => {
    expect(JUDGE_JSON_SCHEMA.properties.unsupported.description)
      .toBe("Short quotes of claims about this lesson that the lesson record does not support.");
    expect(JSON.stringify(JUDGE_JSON_SCHEMA)).not.toContain("summary");
  });
});

describe("judge v5: both levels must pass", () => {
  const flagged = (patch: Record<string, unknown>) => ({ ...CLEAN, faithful: false, ...patch });

  it("is version 5: the v4 prompt at medium and at high", () => {
    expect(JUDGE_PROMPT_VERSION).toBe(6);
    expect(AUTOWRITER_JUDGE_EFFORTS).toEqual(["medium", "high"]);
    // The stored verdict names exactly the levels that judge.
    expect(Object.keys(StoredJudgeVerdictSchema.shape.levels.shape)).toEqual([...AUTOWRITER_JUDGE_EFFORTS]);
  });

  it("passes a draft only when both levels do, and keeps each level's verdict", () => {
    expect(combineJudgeVerdicts({ medium: CLEAN, high: CLEAN })).toEqual({ ...CLEAN, levels: { medium: CLEAN, high: CLEAN } });
    const onlyHigh = flagged({ misattributed: ["[STUDENT_1] said 8 pages"] });
    expect(combineJudgeVerdicts({ medium: CLEAN, high: onlyHigh }))
      .toEqual({ ...onlyHigh, levels: { medium: CLEAN, high: onlyHigh } });
    const onlyMedium = flagged({ unsupported: ["scored 95%"] });
    expect(combineJudgeVerdicts({ medium: onlyMedium, high: CLEAN }))
      .toEqual({ ...onlyMedium, levels: { medium: onlyMedium, high: CLEAN } });
    // A level that says unfaithful without listing anything still fails the draft.
    expect(combineJudgeVerdicts({ medium: CLEAN, high: { ...CLEAN, faithful: false } }).faithful).toBe(false);
  });

  it("lists the union of both verdicts once each, wrong-person problems first", () => {
    const medium = flagged({ unsupported: ["scored 95%", "used a timer"], homeworkNotSet: ["three problems by Friday"] });
    const high = flagged({
      unsupported: ["used a timer", "  scored   95% ", "read chapter four"],
      misattributed: ["[STUDENT_1] said 8 pages"],
      homeworkNotSet: ["three problems by Friday"],
    });
    const combined = combineJudgeVerdicts({ medium, high });
    expect(combined).toMatchObject({
      faithful: false,
      unsupported: ["scored 95%", "used a timer", "read chapter four"],
      misattributed: ["[STUDENT_1] said 8 pages"],
      homeworkNotSet: ["three problems by Friday"],
    });
    expect(judgeProblems(combined)).toEqual([
      "wrong person: [STUDENT_1] said 8 pages",
      "homework not set: three problems by Friday",
      "scored 95%",
      "used a timer",
      "read chapter four",
    ]);
    // Each level's lists stay as returned.
    expect(combined.levels).toEqual({ medium, high });
  });

  it("reuses a stored verdict only when both levels passed it: a single-judge verdict never", () => {
    const passing = combineJudgeVerdicts({ medium: CLEAN, high: CLEAN });
    expect(passingStoredVerdict(passing)).toEqual(passing);
    // v4 and v3 verdicts were judged at one level: no `levels`.
    expect(passingStoredVerdict(CLEAN)).toBeNull();
    expect(passingStoredVerdict({ faithful: true, unsupported: [] })).toBeNull();
    // One level missing, incomplete or not passing.
    expect(passingStoredVerdict({ ...CLEAN, levels: { high: CLEAN } })).toBeNull();
    expect(passingStoredVerdict({ ...CLEAN, levels: { medium: { faithful: true, unsupported: [] }, high: CLEAN } })).toBeNull();
    expect(passingStoredVerdict({ ...CLEAN, levels: { medium: flagged({ unsupported: ["x"] }), high: CLEAN } })).toBeNull();
    expect(passingStoredVerdict({ ...CLEAN, levels: { medium: CLEAN, high: { ...CLEAN, faithful: false } } })).toBeNull();
    expect(passingStoredVerdict({ ...CLEAN, levels: { medium: CLEAN, high: { ...CLEAN, homeworkNotSet: ["y"] } } })).toBeNull();
    // A verdict that failed, or anything else.
    expect(passingStoredVerdict(combineJudgeVerdicts({ medium: CLEAN, high: flagged({ misattributed: ["z"] }) }))).toBeNull();
    expect(passingStoredVerdict({ ...passing, extra: true })).toBeNull();
    expect(passingStoredVerdict(null)).toBeNull();
    expect(passingStoredVerdict("faithful")).toBeNull();
  });
});

describe("buildJudgeMessages", () => {
  const build = (evidence: "summary" | "transcript", otherPeople: readonly string[] = []) => buildJudgeMessages({
    redactedSummary: evidence === "summary"
      ? "[TUTOR] noted that Nathan mentioned only 8 pages."
      : "[00:00] TUTOR: Nathan said he read 8 pages\n[00:05] STUDENT: I read all 10",
    classDetails: "- Programme: Y9-11 / G8-10 (Int.)",
    placeholderFields: FIELDS,
    evidence,
    otherPeople,
  });

  it("is exactly the approved v4 prompt for a summary", () => {
    expect(build("summary")[0].content).toBe([
      "You check a tutor's post-class feedback against an automatic summary of the same lesson.",
      "The student's and the tutor's names are replaced by [STUDENT_1] and [TUTOR]; that is expected. Any other name in the summary is someone else, never [STUDENT_1].",
      "The class details come from the school's system and are true: naming the programme, exam or subject they give is supported.",
      "List every problem of these three kinds, quoting the feedback's own words:",
      "- unsupported: a factual claim about THIS lesson — topics, what the student did or got wrong, scores, materials, dates — that the summary does not state or clearly imply.",
      "- misattributed: something the feedback says [STUDENT_1] did, said, finished, got wrong or did not finish, when the summary says it about [TUTOR] or about another person.",
      "- homeworkNotSet: homework, a task or a due date the feedback says was set — everything under \"Homework and due date\", and any such statement in another field — " +
        "unless the summary clearly shows the tutor setting it for [STUDENT_1] to do after this lesson. Work only described as remaining, unfinished or still to complete was not set. " +
        "A \"Next steps\" line in the summary is the summary's own suggestion, not homework the tutor set.",
      "General advice, encouragement and suggested practice (including practice before the next lesson) are fine and must not be listed, unless they are presented as homework the tutor set.",
      "faithful is true only when all three lists are empty.",
    ].join("\n"));
  });

  it("is the same prompt for a transcript, with the transcript's wording and sentences, and no absolute other-name or Next-steps rule", () => {
    expect(build("transcript")[0].content).toBe([
      `You check a tutor's post-class feedback against an automatic transcript of the same lesson (it may mix Thai and English). ${speakerLabelNote("inferred")}`,
      "The student's and the tutor's names are replaced by [STUDENT_1] and [TUTOR]; that is expected.",
      "Only lines labelled STUDENT are the student's own words; anyone named in the lesson who is clearly not the student is someone else, never [STUDENT_1].",
      "The class details come from the school's system and are true: naming the programme, exam or subject they give is supported.",
      "List every problem of these three kinds, quoting the feedback's own words:",
      "- unsupported: a factual claim about THIS lesson — topics, what the student did or got wrong, scores, materials, dates — that the transcript does not state or clearly imply. " +
        "Claiming the student understood or solved something the transcript only shows the tutor explaining is unsupported.",
      "- misattributed: something the feedback says [STUDENT_1] did, said, finished, got wrong or did not finish, when the transcript says it about [TUTOR] or about another person. " +
        "This includes an answer or value the feedback credits to [STUDENT_1] when the STUDENT line only repeats or confirms what the TUTOR line just before said.",
      "- homeworkNotSet: homework, a task or a due date the feedback says was set — everything under \"Homework and due date\", and any such statement in another field — " +
        "unless the transcript clearly shows the tutor setting it for [STUDENT_1] to do after this lesson. Work only described as remaining, unfinished or still to complete was not set.",
      "General advice, encouragement and suggested practice (including practice before the next lesson) are fine and must not be listed, unless they are presented as homework the tutor set.",
      "faithful is true only when all three lists are empty.",
    ].join("\n"));
  });

  it("asks for three lists against the summary, with the absolute other-name rule", () => {
    const [system, user] = build("summary");
    expect(system.content).toContain("against an automatic summary of the same lesson");
    expect(system.content).toContain(
      "The student's and the tutor's names are replaced by [STUDENT_1] and [TUTOR]; that is expected. " +
      "Any other name in the summary is someone else, never [STUDENT_1].",
    );
    expect(system.content).toContain("List every problem of these three kinds, quoting the feedback's own words:");
    expect(system.content).toContain("that the summary does not state or clearly imply.");
    expect(system.content).toContain(
      "- misattributed: something the feedback says [STUDENT_1] did, said, finished, got wrong or did not finish, " +
      "when the summary says it about [TUTOR] or about another person.",
    );
    expect(system.content).toContain(
      "unless the summary clearly shows the tutor setting it for [STUDENT_1] to do after this lesson. " +
      "Work only described as remaining, unfinished or still to complete was not set.",
    );
    // Owner decision (30 Sep): Wise's "Next steps: …" line is not homework the tutor set.
    expect(system.content).toContain("A \"Next steps\" line in the summary is the summary's own suggestion, not homework the tutor set.");
    expect(system.content).toContain("(including practice before the next lesson) are fine and must not be listed, unless they are presented as homework the tutor set.");
    expect(system.content).toContain("faithful is true only when all three lists are empty.");
    expect(system.content).not.toContain("Only lines labelled STUDENT");
    expect(system.content).not.toContain("only shows the tutor explaining");
    // The judge checks facts: it never gets the writer's style rules or examples.
    expect(system.content).not.toMatch(/Rules:|Length:|Warm, clear/u);
    expect(user.content).toContain("Homework and due date: (empty)");
  });

  it("asks the same of a transcript, with the STUDENT-label and tutor-explaining sentences", () => {
    const [system] = build("transcript");
    expect(system.content).toContain("against an automatic transcript of the same lesson (it may mix Thai and English).");
    expect(system.content).toContain(speakerLabelNote("inferred"));
    expect(system.content).toContain(
      "Only lines labelled STUDENT are the student's own words; anyone named in the lesson who is clearly not the student is someone else, never [STUDENT_1].",
    );
    expect(system.content).toContain("Claiming the student understood or solved something the transcript only shows the tutor explaining is unsupported.");
    expect(system.content).toContain("that the transcript does not state or clearly imply.");
    expect(system.content).toContain("when the transcript says it about [TUTOR] or about another person.");
    expect(system.content).toContain("unless the transcript clearly shows the tutor setting it for [STUDENT_1]");
    // A transcript can still hold the student's own name in Thai script: no absolute rule about other names.
    expect(system.content).not.toContain("Any other name in the");
    // A transcript has no Wise "Next steps" line.
    expect(system.content).not.toContain("Next steps");
  });

  it("gives the judge the other-people line before the summary, only in summary mode and only when there are any", () => {
    const line = "Other people named in the summary (never [STUDENT_1]): Nathan";
    const [, withPeople] = build("summary", ["Nathan"]);
    expect(withPeople.content).toContain(`${line}\n\nLesson summary:\n[TUTOR] noted`);
    expect(build("summary", [])[1].content).not.toContain("Other people named");
    expect(build("transcript", ["Nathan"])[1].content).not.toContain("Other people named");
  });
});

describe("judge v6: an echoed answer is misattributed (nightly audit 3 Oct, M07)", () => {
  const build = (evidence: "summary" | "transcript") => buildJudgeMessages({
    redactedSummary: evidence === "summary"
      ? "[TUTOR] read the actual size from the question."
      : "[16:15] TUTOR: The question gives the actual size, 5 mm, right?\n[16:58] STUDENT: 5 mm",
    classDetails: "- Programme: Y9-11 / G8-10 (Int.)",
    placeholderFields: FIELDS,
    evidence,
    otherPeople: [],
  });

  it("lists crediting a repeated tutor value to the student, in transcript mode only", () => {
    expect(JUDGE_PROMPT_VERSION).toBe(6);
    const clause = "This includes an answer or value the feedback credits to [STUDENT_1] when the STUDENT line only repeats or confirms what the TUTOR line just before said.";
    expect(build("transcript")[0].content).toContain(clause);
    expect(build("summary")[0].content).not.toContain(clause);
  });
});
