import { describe, expect, it } from "vitest";
import type { ReviewPacket } from "../final-review";
import { computeSheet } from "../marking-sheet";
import { reviewDocument } from "../review-document";
// The weights before the high-school part (24 Nov 2026). These tests pin scores made with them.
const DEFAULT_WEIGHTS = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20, school: 0 };

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
        id, result: id === "english" ? "partial" : "met",
        evidence: id === "subject" ? "" : `Used <slides> & "notes" 'well'`, reason: "Source checked.",
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
    expect(ats.match(/<svg class="stack"/g)).toHaveLength(1);
    expect(ats).toContain('<div class="stack-ends" aria-hidden="true"><span>0</span><span>100</span></div>');
    expect(ats).not.toContain('<svg class="radar"');
    const disclosures = [...ats.matchAll(/<details><summary>(.*?)<\/summary><p class="copy">(.*?)<\/p><\/details>/g)];
    expect(disclosures.map((match) => match[1].match(/<span>([^<]+)<\/span>/)?.[1])).toEqual([
      "Degree · Met", "Curriculum · Met", "Teaching · Met", "English · Partly",
    ]);
    expect(disclosures[0][1]).toMatch(/<span class="num">[\d.]+ \/ [\d.]+<\/span>/);
    expect(disclosures[0][2]).toBe("Used &lt;slides&gt; &amp; &quot;notes&quot; &#39;well&#39;");
    expect(ats).toContain("<span>Subject · Met</span>");
    expect(ats).not.toContain('class="evidence-list"');
    expect(ats).toContain('fill="url(#lost-points)"');
    expect(ats).toContain('<path class="penalty-marker"');
  });

  it("shows the stored pass result and each level's pass mark", async () => {
    const ats = { ...packet.evidence.ats, score: 79.5 };
    const html = await reviewDocument({ ...packet, evidence: { ...packet.evidence, ats } }, "resume.pdf", "marked-exam.pdf");
    const summary = html.split("<h2>Assessment summary</h2>")[1].split("</section>")[0];
    const levels = html.split("<h2>Paper by level</h2>")[1].split("</section>")[0];
    expect(summary).toContain("<strong>45%</strong>");
    expect(summary).toContain('<span>36 / 80</span><span class="chip pass">Level passed</span>');
    expect(summary).toContain("<strong>84%</strong>");
    expect(summary).not.toContain("84 / 100");
    expect(summary).toMatch(/<h3>ATS<\/h3>[^]*?<strong>79\.5<\/strong> \/ 100<\/p>\s*<\/div><p class="band">Fair<\/p>/);
    expect(summary.match(/<path [^>]*class="gauge-track"/g)).toHaveLength(3);
    expect(summary).not.toContain('class="target"');
    expect(summary).toContain("Score guide");
    expect(levels).toContain("18 / 20 · 90%");
    expect(levels).toContain("Pass mark 80%");
    expect(levels).toContain(">Below pass</span>");
    const rows = levels.split('<div class="metric">');
    expect(rows.find((row) => row.includes(">Key Stage 3<"))).toContain('class="target" x1="317.6"');
    const noPassMark = rows.find((row) => row.includes(">IB SL / HL<"));
    expect(noPassMark).toContain(">No pass mark</span>");
    expect(noPassMark).not.toContain('class="target"');
    const notDone = rows.find((row) => row.includes(">AP<"));
    expect(notDone).toContain(">Not done</span>");
    expect(notDone).not.toContain('class="bullet-score"');
  });

  it("puts equal pass marks on the level charts only", async () => {
    const paper = { ...packet.evidence.paper!,
      levels: packet.evidence.paper!.levels.map((level) => ({ ...level, passPercent: 80 })) };
    const html = await reviewDocument({ ...packet, evidence: { ...packet.evidence, paper } }, "resume.pdf", "marked-exam.pdf");
    const summary = html.split("<h2>Assessment summary</h2>")[1].split("</section>")[0];
    const levels = html.split("<h2>Paper by level</h2>")[1].split("</section>")[0];
    expect(summary).not.toContain('class="target"');
    expect(summary).not.toContain("Pass mark 80%");
    expect(levels.match(/class="target"/g)).toHaveLength(4);
  });

  it("uses the displayed ATS score to select the band", async () => {
    const ats = { ...packet.evidence.ats, score: 59.99999999999999 };
    const html = await reviewDocument({ ...packet, evidence: { ...packet.evidence, ats } }, "resume.pdf", "marked-exam.pdf");
    const summary = html.split("<h2>Assessment summary</h2>")[1].split("</section>")[0];
    expect(summary).toMatch(/<h3>ATS<\/h3>[^]*?<strong>60\.0<\/strong> \/ 100<\/p>\s*<\/div><p class="band">Fair<\/p>/);
  });

  it("shows the radar and folded evidence for an old packet without weighted points", async () => {
    const { score, criteria } = packet.evidence.ats;
    const html = await reviewDocument({ ...packet, evidence: { ...packet.evidence, ats: { score, criteria } } }, "resume.pdf", "marked-exam.pdf");
    const ats = html.split("<h2>Initial ATS assessment</h2>")[1].split("</section>")[0];
    expect([...ats.matchAll(/<summary>([^<]+)<\/summary>/g)].map((match) => match[1])).toEqual([
      "Degree evidence", "Curriculum evidence", "Teaching evidence", "English evidence",
    ]);
    expect(ats).toContain('<svg class="radar"');
    expect(ats).not.toContain('<svg class="stack"');
  });

  it("plots all mock items and prints the scores and averages", async () => {
    const html = await reviewDocument(packet, "resume.pdf", "marked-exam.pdf");
    const mock = html.split("<h2>Mock teaching rubric</h2>")[1].split("</section>")[0];
    expect(mock.match(/<svg class="dot-plot"/g)).toHaveLength(10);
    expect(mock.match(/<path class="dot"/g)).toHaveLength(10);
    expect(mock.match(/<h3>/g)).toHaveLength(4);
    expect(mock).toContain("Average 9 / 10");
    expect(mock).toMatch(/Feedback Quality[^]*?<span class="num">9 \/ 10<\/span>/);
    expect(mock).toContain("Clear explanations.");
  });

  it("escapes the name and criterion evidence", async () => {
    const html = await reviewDocument(packet, "resume.pdf", "marked-exam.pdf");
    expect(html).toContain("A &lt;B&gt; &amp; &quot;C&quot; &#39;D&#39;");
    expect(html).toContain("Used &lt;slides&gt; &amp; &quot;notes&quot; &#39;well&#39;");
    expect(html).not.toContain("<slides>");
  });
});
