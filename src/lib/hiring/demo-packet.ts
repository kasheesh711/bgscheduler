import { DEMO_NAME } from "./demo";
import type { ReviewPacket } from "./final-review";
import { computeSheet, rubricTotals, type MockRubric } from "./marking-sheet";
import { DEFAULT_WEIGHTS, type PaperLevel } from "./model";
import { reviewDocument } from "./review-document";

const question = (level: PaperLevel, marks: number, index: number) =>
  ({ id: `${level[0]}${index + 1}`, level, marks, max: 10, reason: "Correct method", attempted: true, readable: true });
const criterion = (id: string, result: "met" | "partial", evidence: string) => ({ id, result, evidence, reason: "Seen in the résumé", brief: "Clear evidence" });

/**
 * The demo candidate's packet in the real packet design (Kevin, 24 Nov 2026: the demo must look like the real one).
 * Every value is made up and agrees with the demo screens: ATS 88, paper 53 / 60. Nothing is read or saved.
 */
export function demoReviewDocument(input: { draft: boolean; behavioral: string; offer: string; rubric: MockRubric }, origin: string) {
  const marks = { questions: [...[9, 10, 9].map((m, i) => question("IGCSE / GCSE", m, i)), ...[8, 9, 8].map((m, i) => question("AS / A-Level", m, i))] };
  const packet = {
    id: input.draft ? "draft" : "demo-packet", author: "hr@example.test", at: new Date(), fingerprint: "demo",
    behavioral: input.behavioral, offer: input.offer,
    evidence: {
      name: DEMO_NAME, email: "demo@example.test", subject: "Mathematics", resumeSha256: "demo", call: null,
      ats: {
        score: 88, weights: DEFAULT_WEIGHTS, prestige: 0.9, penalty: 0,
        criteria: [
          criterion("degree", "met", "BSc Mathematics, Chulalongkorn University"),
          criterion("subject", "met", "Degree subject is Mathematics"),
          criterion("curriculum", "met", "Taught IGCSE and A-Level for 3 years"),
          criterion("teaching", "met", "3 years as a tutor"),
          criterion("english", "partial", "IELTS 7.5"),
        ],
      },
      paper: { id: "demo-paper", fileId: "demo-file", updatedAt: new Date().toISOString(), ...computeSheet(marks, new Map([["IGCSE / GCSE", 80], ["AS / A-Level", 80]])) },
      mock: { id: "demo-mock", rubric: input.rubric, total: rubricTotals(input.rubric).total },
      recommendation: { id: "demo-recommendation", head: "Kru Peat", reason: "Clear and well-paced lesson." },
    },
  } as unknown as ReviewPacket;
  // Full addresses, because the demo opens HR's packet link from a blob page, where a path has no site.
  return reviewDocument(packet, `${origin}/api/hiring/review/demo-packet?file=resume`, `${origin}/api/hiring/review/demo-packet?file=paper`);
}
