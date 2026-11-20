import { describe, expect, it } from "vitest";
import type { ReviewPacket } from "../final-review";
import { computeSheet } from "../marking-sheet";
import { DEFAULT_WEIGHTS } from "../model";
import { reviewDocument } from "../review-document";

const paper = computeSheet({ questions: [
  { id: "1", level: "Key Stage 3", marks: 18, max: 20, reason: "Correct method", attempted: true, readable: true },
  { id: "2", level: "AS / A-Level", marks: 11, max: 20, reason: "Partial method", attempted: true, readable: true },
  { id: "3", level: "IB SL / HL", marks: 7, max: 20, reason: "Partial method", attempted: true, readable: true },
  { id: "4", level: "AP", marks: 0, max: 20, reason: "Blank", attempted: false, readable: true },
] }, new Map([["Key Stage 3", 80], ["AS / A-Level", 60]]));

const packet: ReviewPacket = {
  id: "packet", author: "hr@example.test", at: new Date("2026-11-19T03:00:00Z"), fingerprint: "synthetic",
  behavioral: "Adapted a lesson.", offer: "Start in December.",
  evidence: {
    name: `A <B> & "C" 'D'`, email: "candidate@example.test", subject: "Mathematics", resumeSha256: "synthetic", call: null,
    recommendation: { id: "head", head: "Kru Peat", reason: "Clear lesson." },
    ats: { score: 76.5, weights: DEFAULT_WEIGHTS, prestige: 0.525, penalty: 4,
      criteria: (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
        id, result: id === "english" ? "partial" : "met", evidence: `Used <slides> & "notes" 'well'`, reason: "Source checked.",
      })) },
    paper: { id: "paper", fileId: "file", updatedAt: "2026-11-19T03:00:00Z", ...paper },
    mock: { id: "mock", total: 84, rubric: { comments: "Clear explanations.",
      items: { accuracy: 10, concepts: 10, clarity: 7, presentation: 7, interaction: 10, pace: 7, organization: 10, materials: 7, formative: 7, feedback: 9 },
    } },
  },
};

describe("review document", () => {
  it("adds the ATS parts and subtracts the penalty to show the stored total", async () => {
    const html = await reviewDocument(packet, "resume.pdf", "marked-exam.pdf");
    const ats = html.split("<h2>ATS breakdown</h2>")[1].split("</section>")[0];
    const parts = [...ats.matchAll(/<span class="num">([\d.]+) \/ ([\d.]+)/g)];
    const penalty = Number(ats.match(/Work-rights penalty<\/span><span class="num">−([\d.]+)/)?.[1]);
    expect(parts).toHaveLength(6);
    expect(parts.reduce((sum, part) => sum + Number(part[2]), 0)).toBe(100);
    expect(parts.reduce((sum, part) => sum + Number(part[1]), 0) - penalty).toBe(packet.evidence.ats.score);
    expect(ats).toContain(`<strong>Total</strong><strong class="num">${packet.evidence.ats.score.toFixed(1)} / 100</strong>`);
  });

  it("shows the stored pass result and each level's pass mark", async () => {
    const html = await reviewDocument(packet, "resume.pdf", "marked-exam.pdf");
    const summary = html.split("<h2>Assessment summary</h2>")[1].split("</section>")[0];
    const levels = html.split("<h2>Paper by level</h2>")[1].split("</section>")[0];
    expect(summary).toContain("<strong>45%</strong>");
    expect(summary).toContain(">Pass</span>");
    expect(levels).toContain("18 / 20 · 90%");
    expect(levels).toContain("Pass mark 80%");
    expect(levels).toContain(">Below pass</span>");
    const rows = levels.split('<div class="metric">');
    expect(rows.find((row) => row.includes(">IB SL / HL<"))).toContain(">No pass mark</span>");
    expect(rows.find((row) => row.includes(">AP<"))).toContain(">Not done</span>");
  });

  it("shows the criteria without ATS bars for an old packet", async () => {
    const { score, criteria } = packet.evidence.ats;
    const html = await reviewDocument({ ...packet, evidence: { ...packet.evidence, ats: { score, criteria } } }, "resume.pdf", "marked-exam.pdf");
    const ats = html.split("<h2>Initial ATS assessment</h2>")[1].split("</section>")[0];
    expect(ats).toContain("Degree");
    expect(ats).toContain("<summary>Evidence</summary>");
    expect(ats).not.toContain('class="track"');
  });

  it("escapes the name and criterion evidence", async () => {
    const html = await reviewDocument(packet, "resume.pdf", "marked-exam.pdf");
    expect(html).toContain("A &lt;B&gt; &amp; &quot;C&quot; &#39;D&#39;");
    expect(html).toContain("Used &lt;slides&gt; &amp; &quot;notes&quot; &#39;well&#39;");
    expect(html).not.toContain("<slides>");
  });
});
