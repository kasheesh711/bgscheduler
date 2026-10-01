import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFeedbackMessages } from "../prompt";
import { activeStyleGuide, matchingStoredStyle, MIMI_STYLE_GUIDE, styleGuideStamp, validateStyleFormat } from "../style";
import { rosterAccountIds, rosterTutor } from "../roster";
import { finalizeFields, validateFeedbackDraft } from "../validate";
import examples from "../style-examples/mimi-v1.json";
import { GOOD_FIELDS, STUDENT_NAME } from "./fixtures";

const fields = { topics: "1. Adding fractions\n2. Mixed numbers", performance: GOOD_FIELDS.performance + " We reviewed the errors together and practised checking each denominator before combining terms. The next step is to keep the same careful checking routine when working independently.", improvement: "1. Check simplification", homework: "" };
const lessonRecord = "We practised adding fractions and mixed numbers, then worked through worksheets.";
const output = { ...fields, performance: fields.performance.replaceAll("Somchai", "[STUDENT_1]"), studentAttended: true, lessonHappened: true };
const enabled = { FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED: "true" };

describe("Mimi's frozen guide", () => {
  it("is disabled by default and scoped to both Mimi accounts, with exact true activation", () => {
    expect(activeStyleGuide("Mimi", {})).toBeNull();
    expect(activeStyleGuide("Mimi", { FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED: "TRUE" })).toBeNull();
    expect(activeStyleGuide("Gift", enabled)).toBeNull();
    expect(rosterAccountIds("Mimi")).toHaveLength(2);
    for (const id of rosterAccountIds("Mimi")) expect(activeStyleGuide(rosterTutor(id)!.canonicalKey, enabled)).toBe(MIMI_STYLE_GUIDE);
  });
  it("freezes three anonymised examples with verification notes and hashes, without publishing source identifiers", () => {
    expect(examples.examples).toHaveLength(3);
    expect(MIMI_STYLE_GUIDE.id).toBe(examples.profileId);
    expect(MIMI_STYLE_GUIDE.version).toBe(examples.version);
    expect(JSON.stringify(examples)).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/u);
    for (const example of examples.examples) {
      expect(example.authorship.canonicalTutorKey).toBe("Mimi");
      expect(example.authorship.beforeAutowriter).toBe(true);
      expect(example.authorship.provenance).not.toBe("auto");
      expect(example).not.toHaveProperty("source");
      expect(example.sha256).toBe(createHash("sha256").update(JSON.stringify(example.fields)).digest("hex"));
      expect(example.fields.performance).toContain("[STUDENT_1]");
    }
  });
  it("leaves the shared prompt intact, and overrides only Mimi's layout and lengths", () => {
    const context = { studentFullName: STUDENT_NAME, tutorNames: ["Mimi"], classDetails: [], scheduledMinutes: 60, summary: { text: lessonRecord, meetingUUIDs: [] } };
    expect(buildFeedbackMessages(context)[0].content).toContain("between 120 and 600");
    const guided = buildFeedbackMessages({ ...context, styleGuide: MIMI_STYLE_GUIDE })[0].content;
    expect(guided).not.toContain("between 120 and 600");
    expect(guided).not.toContain("two or three concrete next steps");
    expect(guided).toContain("Historical presentation example 3");
    expect(guided).toContain("presentation only");
  });
});

describe("format validation", () => {
  it("allows short numbered lists and missing homework, without weakening overall content checks", () => {
    expect(validateStyleFormat(fields, lessonRecord)).toEqual([]);
    expect(validateFeedbackDraft({ output, fields, studentFullName: STUDENT_NAME, tutorNames: ["Mimi"], priorFeedback: [], styleGuide: MIMI_STYLE_GUIDE, lessonRecord })).toEqual({ ok: true });
    const sparse = { ...output, performance: "[STUDENT_1] practised fractions." };
    expect(validateFeedbackDraft({ output: sparse, fields: finalizeFields(sparse, "Tom"), studentFullName: STUDENT_NAME, tutorNames: ["Mimi"], priorFeedback: [], styleGuide: MIMI_STYLE_GUIDE, lessonRecord })).toMatchObject({ ok: false });
  });
  it.each([
    ["topics", "2. Fractions", "style:numbering:topics"],
    ["topics", "01. Fractions", "style:numbering:topics"],
    ["improvement", "Check simplification", "style:list_structure:improvement"],
    ["homework", "- Worksheet", "style:list_structure:homework"],
    ["topics", "Worksheets", "style:empty_material_group:topics"],
    ["performance", "1. Did well", "style:performance_prose"],
    ["performance", "Strengths: fractions", "style:performance_prose"],
    ["topics", "1. **Fractions**", "style:prohibited_format:topics"],
    ["improvement", "1. *Check simplification*", "style:prohibited_format:improvement"],
    ["performance", "> Did well", "style:prohibited_format:performance"],
    ["topics", "1. `Fractions`", "style:prohibited_format:topics"],
  ])("rejects %s format %s", (field, value, reason) => {
    expect(validateStyleFormat({ ...fields, [field]: value }, lessonRecord)).toContain(reason);
  });
  it("only permits material labels supported by current evidence, with sequential numbers in each group", () => {
    const labelled = { ...fields, topics: "Atom learning\n1. Fractions\nWorksheets\n1. Mixed numbers\n2. Simplification" };
    expect(validateStyleFormat(labelled, lessonRecord)).toContain("style:unsupported_material_label:topics");
    expect(validateStyleFormat(labelled, `Atom learning. ${lessonRecord}`)).toEqual([]);
    expect(validateStyleFormat({ ...fields, topics: "1. Fractions\n- Unlike denominators" }, lessonRecord)).toEqual([]);
    expect(validateStyleFormat({ ...fields, topics: "1. Worksheets: Fractions" }, "We completed a worksheet on fractions.")).toEqual([]);
    expect(validateStyleFormat({ ...fields, topics: "1. Worksheets: Fractions" }, "We practised fractions.")).toContain("style:unsupported_material_label:topics");
  });
  it("does not exempt historical examples from copy detection", () => {
    const historical = MIMI_STYLE_GUIDE.examples[0].fields;
    const copy = { ...historical, studentAttended: true, lessonHappened: true };
    const restored = finalizeFields(copy, "Tom");
    const result = validateFeedbackDraft({ output: copy, fields: restored, studentFullName: STUDENT_NAME, tutorNames: ["Mimi"], priorFeedback: [{ key: "older", fields: restored, studentNames: [STUDENT_NAME] }], styleGuide: MIMI_STYLE_GUIDE, lessonRecord });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.some(reason => reason.startsWith("ai_suspect:"))).toBe(true);
  });
});

describe("stored guide versions", () => {
  it("requires the current guide and invalidates drafts when the guide is disabled, stale or absent", () => {
    expect(matchingStoredStyle(undefined, null)).toBe(true);
    expect(matchingStoredStyle(null, null)).toBe(true);
    expect(matchingStoredStyle(undefined, MIMI_STYLE_GUIDE)).toBe(false);
    expect(matchingStoredStyle({ id: "mimi", version: 0 }, MIMI_STYLE_GUIDE)).toBe(false);
    expect(matchingStoredStyle({ id: "other", version: 1 }, MIMI_STYLE_GUIDE)).toBe(false);
    expect(matchingStoredStyle(styleGuideStamp(MIMI_STYLE_GUIDE), MIMI_STYLE_GUIDE)).toBe(true);
    expect(matchingStoredStyle(styleGuideStamp(MIMI_STYLE_GUIDE), null)).toBe(false);
  });
});
