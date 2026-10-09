import { describe, expect, it } from "vitest";
import {
  AUDIT_JSON_SCHEMA,
  SYNTHESIS_JSON_SCHEMA,
  containsAnyName,
  copiedRun,
  normaliseModeRef,
  normaliseForQuote,
  parseAuditResult,
  parseSynthesisResult,
  worstSeverity,
  type AuditResult,
} from "../audit-schema";
import { FAILURE_MODES, FAILURE_MODE_IDS, failureMode, maxSeverity, postAuditModes } from "../modes";

// Invented lesson: no real student, tutor or class appears in this file.
const POST = {
  topics: "1. Fractions: adding unlike denominators\n2. Word problems",
  performance: "Pim added fractions with unlike denominators correctly after one reminder. She confidently mastered word problems.",
  improvement: "1. Finding common denominators quickly",
  homework: "Complete page 12 by Friday.",
};
const EVIDENCE = [
  "[03:10] TUTOR: Let's add one third and one quarter.",
  "[03:40] STUDENT: Twelve is the common one, so seven twelfths.",
  "[20:15] TUTOR: We can finish page 12 next time.",
].join("\n");

function baseResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    verdict: "accurate",
    claims: [],
    issues: [],
    omissions: [],
    homework: { feedbackStatesHomework: false, tutorSetHomework: "no", evidence: [] },
    names: { studentCalled: ["Pim"], otherPeopleNamed: [] },
    candidateReview: [],
    evidenceQuality: { transcript: "full", speakerLabels: "verified", summaryVsTranscript: "no_summary", notes: [] },
    priorIssueReview: null,
    summaryLine: "no issues",
    ...overrides,
  };
}

const quote = (text: string) => ({ source: "transcript" as const, locator: "03:40", speaker: "STUDENT" as const, quote: text, gloss: null });
const ctx = { postFields: POST, evidenceText: EVIDENCE, grade: "rebuilt" as const };

describe("failure modes", () => {
  it("has unique ids and slugs, a category for every critical default, and an example for each", () => {
    expect(new Set(FAILURE_MODES.map((m) => m.id)).size).toBe(FAILURE_MODES.length);
    expect(new Set(FAILURE_MODES.map((m) => m.slug)).size).toBe(FAILURE_MODES.length);
    expect(FAILURE_MODES.map((m) => m.id)).toEqual([...FAILURE_MODE_IDS]);
    for (const mode of FAILURE_MODES) {
      expect(mode.example.length).toBeGreaterThan(20);
      if (mode.defaultSeverity === "critical") expect(mode.criticalCategory).toBeTruthy();
    }
  });

  it("keeps the owner's precedents: P1 critical wrong person, P2 major homework", () => {
    expect(failureMode("M01")).toMatchObject({ defaultSeverity: "critical", criticalCategory: "wrong_person", precedent: "P1" });
    expect(failureMode("M03")).toMatchObject({ defaultSeverity: "major", precedent: "P2" });
  });

  it("never lets a post audit assign the hold or spend modes, and never text-fixes billing or scope", () => {
    expect(postAuditModes().map((m) => m.id)).not.toContain("M15");
    expect(postAuditModes().map((m) => m.id)).not.toContain("M16");
    expect(failureMode("M13")?.textFixable).toBe(false);
    expect(failureMode("M14")?.textFixable).toBe(false);
    expect(maxSeverity("major", "critical")).toBe("critical");
    expect(maxSeverity("cosmetic", "major")).toBe("major");
  });
});

describe("parseAuditResult", () => {
  it("accepts a clean accurate result unchanged", () => {
    const out = parseAuditResult(baseResult(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.verdict).toBe("accurate");
    expect(out.result.postCheck).toEqual({ quoteMismatchIssues: [], unverifiedSupport: [], addedIssues: [], raisedIssues: [], verdictRaised: false });
    expect(worstSeverity(out.result)).toBeNull();
  });

  it("rejects output that does not match the schema", () => {
    expect(parseAuditResult({ verdict: "fine" }, ctx)).toMatchObject({ ok: false });
    expect(parseAuditResult({ ...baseResult(), extra: 1 }, ctx)).toMatchObject({ ok: false });
  });

  it("refuses insufficient_evidence when a real transcript was available", () => {
    expect(parseAuditResult(baseResult({ verdict: "insufficient_evidence" }), ctx)).toMatchObject({ ok: false });
    expect(parseAuditResult(baseResult({ verdict: "insufficient_evidence" }), { ...ctx, grade: "secondary_only" })).toMatchObject({ ok: true });
  });

  it("turns a 'supported' claim whose evidence is not really in the lesson into an unsupported one with its own issue", () => {
    const out = parseAuditResult(baseResult({
      claims: [{
        id: "c1", field: "performance", text: "She confidently mastered word problems.", kind: "judgement", verdict: "supported",
        evidence: [quote("She solved every word problem with ease.")],
      }],
    }), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.postCheck.unverifiedSupport).toEqual(["c1"]);
    expect(out.result.claims[0].verdict).toBe("unsupported");
    expect(out.result.issues).toHaveLength(1);
    expect(out.result.issues[0]).toMatchObject({ mode: "M06", severity: "major", claimIds: ["c1"], confidence: "low" });
    expect(out.result.verdict).toBe("major");
    expect(out.result.postCheck.verdictRaised).toBe(true);
  });

  it("accepts evidence quotes despite whitespace, case and curly-quote differences", () => {
    const out = parseAuditResult(baseResult({
      claims: [{
        id: "c1", field: "performance", text: "Pim added fractions with unlike denominators correctly after one reminder.",
        kind: "student_action", verdict: "supported", evidence: [quote("twelve is the  common one,\nso seven twelfths")],
      }],
    }), ctx);
    expect(out.ok && out.result.claims[0].verdict).toBe("supported");
  });

  it("adds a critical wrong-person issue for an uncovered misattributed claim", () => {
    const out = parseAuditResult(baseResult({
      claims: [{
        id: "c2", field: "performance", text: "She confidently mastered word problems.", kind: "student_result", verdict: "misattributed",
        evidence: [],
      }],
    }), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.issues[0]).toMatchObject({ mode: "M01", severity: "critical", criticalCategory: "wrong_person" });
    expect(out.result.verdict).toBe("critical");
  });

  it("raises a critical-by-definition mode to critical and fills its category", () => {
    const out = parseAuditResult(baseResult({
      verdict: "major",
      issues: [{
        id: "i1", claimIds: [], field: "homework", quote: "Complete page 12 by Friday.", mode: "M04", severity: "major",
        criticalCategory: null, rootStage: "writer", defense: "judge_list", mechanism: "Due date invented.", evidence: [],
        minimalFix: { action: "clear_field", from: "Complete page 12 by Friday.", to: null }, confidence: "high",
      }],
    }), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.issues[0]).toMatchObject({ severity: "critical", criticalCategory: "invented_content" });
    expect(out.result.postCheck.raisedIssues).toEqual(["i1"]);
    expect(out.result.verdict).toBe("critical");
  });

  it("keeps an issue whose quote is not in the post but drops its minimal fix", () => {
    const out = parseAuditResult(baseResult({
      verdict: "major",
      issues: [{
        id: "i1", claimIds: [], field: "homework", quote: "Finish page 13 by Monday.", mode: "M03", severity: "major",
        criticalCategory: null, rootStage: "evidence", defense: "judge_list", mechanism: "Remaining work written as homework.",
        evidence: [quote("We can finish page 12 next time.")],
        minimalFix: { action: "delete_span", from: "Finish page 13 by Monday.", to: null }, confidence: "high",
      }],
    }), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.issues).toHaveLength(1);
    expect(out.result.issues[0].minimalFix).toBeNull();
    expect(out.result.postCheck.quoteMismatchIssues).toEqual(["i1"]);
  });

  it("raises the verdict to the worst omission and clears a category on a non-critical issue", () => {
    const out = parseAuditResult(baseResult({
      issues: [{
        id: "i1", claimIds: [], field: "homework", quote: "Complete page 12 by Friday.", mode: "M03", severity: "major",
        criticalCategory: "invented_content", rootStage: "evidence", defense: "judge_list", mechanism: "Next time is not homework.",
        evidence: [quote("We can finish page 12 next time.")], minimalFix: null, confidence: "high",
      }],
      omissions: [{ what: "main_topic_missing", detail: "Most of the lesson was word problems.", evidence: [], severity: "major" }],
    }), ctx);
    expect(out.ok && out.result.verdict).toBe("major");
    expect(out.ok && out.result.issues[0].criticalCategory).toBeNull();
  });

  it("renumbers duplicate issue ids instead of failing", () => {
    const issue = {
      id: "i1", claimIds: [], field: "homework" as const, quote: "Complete page 12 by Friday.", mode: "M03" as const, severity: "major" as const,
      criticalCategory: null, rootStage: "writer" as const, defense: "none" as const, mechanism: "x", evidence: [], minimalFix: null,
      confidence: "high" as const,
    };
    const out = parseAuditResult(baseResult({ verdict: "major", issues: [issue, issue] }), ctx);
    expect(out.ok && out.result.issues.map((i) => i.id)).toEqual(["i1", "i2"]);
  });
});

describe("normaliseAuditOutput (v2: the CLI schema carries no lengths or id patterns)", () => {
  it("accepts the first live failure shape: free-form claim ids and a fifth evidence quote", () => {
    const evidence = [1, 2, 3, 4, 5].map(() => quote("Twelve is the common one, so seven twelfths."));
    const raw = baseResult({
      verdict: "major",
      claims: [
        { id: "claim_1", field: "performance", text: "Pim added fractions with unlike denominators correctly after one reminder.", kind: "student_action", verdict: "supported", evidence },
        { id: "claim_2", field: "performance", text: "She confidently mastered word problems.", kind: "judgement", verdict: "unsupported", evidence: [] },
      ],
      issues: [{
        id: "issue-A", claimIds: ["claim_2", "claim_9"], field: "performance", quote: "She confidently mastered word problems.", mode: "M06",
        severity: "major", criticalCategory: null, rootStage: "writer", defense: "prompt_rule", mechanism: "Padded praise.", evidence: [],
        minimalFix: { action: "delete_span", from: "She confidently mastered word problems.", to: null }, confidence: "high",
      }],
    }) as unknown as Record<string, unknown>;
    const out = parseAuditResult(raw, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.claims.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.result.claims[0].evidence).toHaveLength(4);
    expect(out.result.issues[0]).toMatchObject({ id: "i1", claimIds: ["c2"] });
    expect(out.result.postCheck.addedIssues).toEqual([]);
  });

  it("clips long strings, drops a fix that would need clipping, and fills missing nullable keys", () => {
    const longFrom = "x".repeat(700);
    const raw = baseResult({
      summaryLine: "y".repeat(400),
      issues: [{
        id: "1", claimIds: [], field: "homework", quote: "Complete page 12 by Friday.", mode: "M03", severity: "major", criticalCategory: null,
        rootStage: "writer", defense: "judge_list", mechanism: "m".repeat(900), evidence: [quote("q".repeat(900))],
        minimalFix: { action: "delete_span", from: longFrom, to: null }, confidence: "high",
      }],
    }) as unknown as Record<string, unknown>;
    delete raw.priorIssueReview;
    const out = parseAuditResult(raw, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summaryLine).toHaveLength(160);
    expect(out.result.summaryLine.endsWith("…")).toBe(true);
    expect(out.result.issues[0].mechanism).toHaveLength(500);
    expect(out.result.issues[0].evidence[0].quote).toHaveLength(400);
    expect(out.result.issues[0].minimalFix).toBeNull();
    expect(out.result.priorIssueReview).toBeNull();
  });

  it("still rejects structural problems", () => {
    expect(parseAuditResult(baseResult({ verdict: "fine" as never }), ctx)).toMatchObject({ ok: false });
    expect(parseAuditResult({ ...baseResult(), homework: null }, ctx)).toMatchObject({ ok: false });
  });

  it("normalises synthesis mode references", () => {
    expect(normaliseModeRef("M03")).toBe("M03");
    expect(normaliseModeRef("M03 homework_not_set")).toBe("M03");
    expect(normaliseModeRef("Brand new mode!")).toBe("NEW:brand_new_mode");
    expect(normaliseModeRef("NEW:Speaker Swap")).toBe("NEW:speaker_swap");
  });
});

describe("quote normalisation and leak checks", () => {
  it("normalises whitespace, case and punctuation variants", () => {
    expect(normaliseForQuote("It’s  “Fine”— ok")).toBe(normaliseForQuote("it's \"fine\"- ok"));
  });

  it("finds whole-word Latin names but not names inside other words, and any Thai occurrence", () => {
    expect(containsAnyName("Feedback for Pim today", ["Pim"])).toBe("Pim");
    expect(containsAnyName("A pimple-free page", ["Pim"])).toBeNull();
    expect(containsAnyName("นักเรียนชื่อนกมาเรียน", ["นก"])).toBe("นก");
    expect(containsAnyName("short a", ["a"])).toBeNull();
  });

  it("finds an 8-word run copied from a source", () => {
    const source = "we can finish the last three questions of the paper next time together";
    expect(copiedRun("Brief: we can finish the last three questions of the paper", [source], 8)).toBe("we can finish the last three questions of");
    expect(copiedRun("An invented lesson about volcanoes and rivers in a far land", [source], 8)).toBeNull();
  });
});

describe("parseSynthesisResult", () => {
  const synthesis = {
    failureModes: [{
      mode: "M03", title: "Homework from remaining work", severity: "major", sessions: ["s1"], mechanism: "Remaining work treated as set.",
      rootStage: "writer", proposedChange: "Add a rule.", proposedFiles: ["src/lib/feedback-autowriter/prompt.ts"], fixability: "auto_allowed",
      confidence: "high",
    }],
    fixPick: { mode: "M03", reason: "Most frequent major." },
    fixBrief: {
      mode: "M03", mechanism: "The writer treats work left for next time as homework.", targetFiles: ["src/lib/feedback-autowriter/prompt.ts"],
      syntheticFixture: {
        evidenceKind: "transcript", evidence: "[01:00] TUTOR: Tawan, we will finish the volcano map next week.",
        badFeedback: { topics: "1. Volcano maps", performance: "Tawan labelled two volcanoes.", improvement: "1. Map keys", homework: "Finish the volcano map." },
        expectedBehaviour: "Homework stays empty.",
      },
      acceptance: ["Homework empty on the invented lesson."],
    },
    longTermPlan: [],
    judgeMisses: { count: 1, modes: ["M03"] },
    summaryLine: "1 mode",
  };
  const sctx = { sessionIds: new Set(["s1"]), realNames: ["Somchai"], evidenceTexts: ["the tutor said we will finish the essay plan in our next lesson together"] };

  it("accepts a sanitised synthesis", () => {
    expect(parseSynthesisResult(synthesis, sctx)).toMatchObject({ ok: true });
  });

  it("rejects an unknown session, a real name in the fix brief, or copied evidence", () => {
    expect(parseSynthesisResult({ ...synthesis, failureModes: [{ ...synthesis.failureModes[0], sessions: ["s9"] }] }, sctx)).toMatchObject({ ok: false });
    expect(parseSynthesisResult({ ...synthesis, fixBrief: { ...synthesis.fixBrief, mechanism: "Somchai's lesson shows it." } }, sctx))
      .toMatchObject({ ok: false, reason: "fix brief contains a real name" });
    expect(parseSynthesisResult({
      ...synthesis,
      fixBrief: { ...synthesis.fixBrief, mechanism: "the tutor said we will finish the essay plan in our next lesson" },
    }, sctx)).toMatchObject({ ok: false });
  });
});

describe("JSON schemas for the CLI", () => {
  it("keep only the keywords structured output supports", () => {
    const text = JSON.stringify([AUDIT_JSON_SCHEMA, SYNTHESIS_JSON_SCHEMA]);
    for (const keyword of ["\"pattern\"", "\"maxLength\"", "\"minLength\"", "\"maxItems\"", "\"$schema\"", "\"minimum\""]) {
      expect(text).not.toContain(keyword);
    }
    expect(AUDIT_JSON_SCHEMA).toMatchObject({ type: "object", additionalProperties: false });
    expect((AUDIT_JSON_SCHEMA.required as string[])).toContain("issues");
  });
});

describe("normaliseAuditOutput: blank strings (3 Oct)", () => {
  it("keeps an issue with an empty quote as a placeholder and drops empty claims and evidence quotes", () => {
    const raw = baseResult({
      verdict: "major",
      claims: [
        { id: "c1", field: "performance", text: "", kind: "other", verdict: "advice_ok", evidence: [] },
        { id: "c2", field: "homework", text: "Complete page 12 by Friday.", kind: "homework", verdict: "unsupported", evidence: [quote(""), quote("We can finish page 12 next time.")] },
      ],
      issues: [{
        id: "i1", claimIds: ["c2"], field: "homework", quote: "", mode: "M03", severity: "major", criticalCategory: null,
        rootStage: "writer", defense: "judge_list", mechanism: "", evidence: [quote("  ")], minimalFix: null, confidence: "medium",
      }],
    }) as unknown as Record<string, unknown>;
    const out = parseAuditResult(raw, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.claims.map((c) => c.id)).toEqual(["c1"]);
    expect(out.result.claims[0].evidence).toHaveLength(1);
    expect(out.result.issues[0]).toMatchObject({ quote: "(no quote given)", mechanism: "(not given)", evidence: [], claimIds: ["c1"] });
    expect(out.result.postCheck.quoteMismatchIssues).toEqual(["i1"]);
    expect(out.result.verdict).toBe("major");
  });
});
