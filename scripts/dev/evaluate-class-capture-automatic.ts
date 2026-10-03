/** Explicit synthetic provider evaluation. No database, student data, or Wise writes. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readWorksheet, synthesizeFeedback } from "../../src/lib/class-capture/synthesis";

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Use --live for a deliberate paid synthetic provider check.");
  const envIndex = process.argv.indexOf("--env-file");
  if (envIndex !== -1) process.loadEnvFile(process.argv[envIndex + 1]);
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OpenRouter access is unavailable.");
  const out = path.resolve("docs/assets/class-capture/automatic"); mkdirSync(out, { recursive: true });
  const images = [
    { name: "blank", body: "1. 2 + 2 = ____     2. 3/4 + 1/4 = ____" },
    { name: "marked", body: "1. 2 + 2 = 5    [red cross]     2. 3/4 + 1/4 = 1    [tick]" },
  ];
  const findings = [];
  for (const item of images) {
    const bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="white"/><text x="60" y="100" font-size="42">Synthetic maths worksheet</text><text x="60" y="220" font-size="34">${item.body}</text></svg>`)).jpeg().toBuffer();
    findings.push({ name: item.name, findings: await readWorksheet(bytes, "image/jpeg") });
  }
  const cases = [
    { name: "ambiguous-speakers-and-homework", transcript: "Let's discuss faces, edges and vertices. I think I mixed up the edge and corner. Do you know what a cross-section is? No. Your homework is to finish decimals and one positive paper.", segments: undefined, photos: [] },
    { name: "spoken-answer-and-marked-work", transcript: "Teacher: What is one half plus one half? Student: หนึ่ง. It is one whole because the two halves make a whole. Teacher: Explain two plus two. Student: Five. Teacher: Count the counters again. Student: Four. Teacher: Finish the decimal questions for homework.", segments: undefined, photos: [findings[1].findings] },
    { name: "blank-worksheet-only", transcript: null, segments: undefined, photos: [findings[0].findings] },
  ];
  const results = [];
  for (const item of cases) {
    const result = await synthesizeFeedback({ topic: "Maths", tutorNotes: "", prior: [], assets: [
      ...(item.transcript ? [{ id: "synthetic-audio", kind: "recording", transcript: item.transcript }] : []),
      ...item.photos.map((photoFindings, i) => ({ id: `synthetic-photo-${i}`, kind: "worksheet", transcript: null, photoFindings })),
    ] });
    results.push({ name: item.name, ...result });
    writeFileSync(path.join(out, "provider-evaluation.json"), JSON.stringify({ syntheticOnly: true, imageCalls: findings.length, synthesisCalls: results.length, findings, results }, null, 2) + "\n");
  }
  console.log(`Saved ${findings.length} image and ${results.length} synthesis results for human review.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; });
