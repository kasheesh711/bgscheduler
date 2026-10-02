import { describe, expect, it } from "vitest";
import { AGENT_CORRECTION_FLAG_ACTOR, AGENT_FLAG_ACTOR, agentCorrectionFlagKey, agentFlagKey, correctionFlagItem, planAgentFlags } from "../flags";
import type { ClassReport } from "../report";

function report(sid: string, patch: Partial<ClassReport> = {}): ClassReport {
  return {
    wiseSessionId: sid, fieldsSha256: "f".repeat(64), tutorKey: "Kevin", className: "Somsri (Pim.Ta) Testwong", postedEvidenceKind: "transcript",
    grade: "rebuilt", lateFrom: null, improvable: false, auditVerdict: "major", auditFailure: null, auditSummaryLine: "x", severity: "major", modes: ["M06"],
    findings: [{
      source: "audit", code: "i1", mode: "M06", severity: "major", confidence: "medium", criticalCategory: null, field: "performance",
      quote: "She confidently mastered fractions", detail: "Judgement not in the evidence", minimalFix: null, evidence: [], confirmed: null,
    }],
    ownerVerdict: "approve", judgePassed: true, wiseTextEdited: false, costUsd: 0.4, criticalHighConfidence: false, criticalCategory: null,
    ...patch,
  };
}

describe("planAgentFlags", () => {
  it("flags major and critical classes, criticals first, with codes only in the note", () => {
    const critical = report("6a0000000000000000000a02", {
      severity: "critical", modes: ["M01"], criticalHighConfidence: true, criticalCategory: "wrong_person",
      findings: [{ ...report("x").findings[0], code: "i1", mode: "M01", severity: "critical", confidence: "high", criticalCategory: "wrong_person" }],
    });
    const { items, overCap } = planAgentFlags([
      report("6a0000000000000000000a01"),
      critical,
      report("6a0000000000000000000a03", { severity: "cosmetic", modes: ["M17"] }),
      report("6a0000000000000000000a04", { severity: null, modes: [] }),
    ], { auditVersion: 1, maxFlags: 10 });
    expect(items.map((item) => item.wiseSessionId)).toEqual(["6a0000000000000000000a02", "6a0000000000000000000a01"]);
    expect(items[0]).toMatchObject({
      severity: "critical", suggestedSeverity: "critical", suggestedCategory: "wrong_person", incident: true,
      idempotencyKey: agentFlagKey({ wiseSessionId: "6a0000000000000000000a02", fieldsSha256: "f".repeat(64), auditVersion: 1 }),
    });
    expect(items[1]).toMatchObject({ severity: "major", suggestedSeverity: "factual", suggestedCategory: null, incident: false });
    expect(items[1].note).toBe("Nightly Opus audit (v1): major M06. Details in the local nightly report.");
    for (const item of items) expect(item.note).not.toMatch(/fractions|Pim|Testwong|Kevin|evidence/u);
    expect(overCap).toEqual([]);
  });

  it("raises an incident only for a high-confidence critical, and caps the night", () => {
    const lowConfidence = report("6a0000000000000000000a05", { severity: "critical", criticalHighConfidence: false, criticalCategory: "invented_content" });
    expect(planAgentFlags([lowConfidence], { auditVersion: 1, maxFlags: 10 }).items[0]).toMatchObject({ incident: false, suggestedCategory: "invented_content" });
    const many = Array.from({ length: 12 }, (_, index) => report(`6a0000000000000000000b${String(index).padStart(2, "0")}`));
    const capped = planAgentFlags(many, { auditVersion: 1, maxFlags: 10 });
    expect(capped.items).toHaveLength(10);
    expect(capped.overCap).toHaveLength(2);
  });

  it("keys a flag by class, text and audit version", () => {
    expect(agentFlagKey({ wiseSessionId: "6a0000000000000000000a01", fieldsSha256: "abc", auditVersion: 2 })).toBe("agent-audit:6a0000000000000000000a01:abc:2");
  });
});

describe("correctionFlagItem", () => {
  it("asks for a re-review of a corrected class: keyed per class, the original severity, mode codes only", () => {
    const item = correctionFlagItem({ wiseSessionId: "6a0000000000000000000a01", fieldsSha256: "e".repeat(64), modes: ["M03", "M06", "M03"], severity: "major", criticalCategory: null });
    expect(item).toEqual({
      wiseSessionId: "6a0000000000000000000a01", fieldsSha256: "e".repeat(64), idempotencyKey: "agent-correction:6a0000000000000000000a01",
      severity: "major", suggestedSeverity: "factual", suggestedCategory: null, note: "corrected by the nightly agent: M03, M06",
      incident: false, modes: ["M03", "M06", "M03"], createdBy: AGENT_CORRECTION_FLAG_ACTOR,
    });
    // Raised by the correction's own actor: the audit's nightly flag cap (`countAgentFlags`) never counts it.
    expect(AGENT_CORRECTION_FLAG_ACTOR).not.toBe(AGENT_FLAG_ACTOR);
    expect(agentCorrectionFlagKey("6a0000000000000000000a01")).toBe(item.idempotencyKey);
    expect(correctionFlagItem({ wiseSessionId: "6a0000000000000000000a01", fieldsSha256: "e", modes: ["M01"], severity: "critical", criticalCategory: "wrong_person" }))
      .toMatchObject({ suggestedSeverity: "critical", suggestedCategory: "wrong_person", incident: false });
    expect(correctionFlagItem({ wiseSessionId: "6a0000000000000000000a01", fieldsSha256: "e", modes: ["M01"], severity: "critical", criticalCategory: "not_a_category" }).suggestedCategory).toBeNull();
  });
});
