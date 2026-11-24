import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import { hiringMockResults, hiringPaperResults } from "@/lib/db/schema";
import { headRecommendation } from "../decisions";
import { reviewPacketValid, type ReviewPacket } from "../final-review";
import { computeSheet, passRulesFor } from "../marking-sheet";
import { configSchema, HiringError } from "../model";
import { candidateById, settings } from "../service";
// The weights a packet stored before the high-school part (24 Nov 2026). Such a packet must stay valid while the school weight is 0.
const DEFAULT_WEIGHTS = { degree: 10, subject: 10, curriculum: 20, teaching: 20, english: 20, prestige: 20 };

vi.mock("../decisions", () => ({ headRecommendation: vi.fn() }));
vi.mock("../service", () => ({ candidateById: vi.fn(), settings: vi.fn() }));

function reviewFixture() {
  const config = configSchema.parse({ profileWeights: { ...DEFAULT_WEIGHTS, school: 0 } });
  const at = new Date("2026-11-19T03:00:00Z");
  const criteria: ReviewPacket["evidence"]["ats"]["criteria"] = (["degree", "subject", "curriculum", "teaching", "english"] as const).map((id) => ({
    id, result: id === "degree" || id === "subject" ? "met" : "unknown", evidence: "", reason: "Source checked.",
  }));
  const candidate = {
    name: "Sample Tutor", email: "tutor@example.test", subjects: ["Mathematics"],
    resumeSha256: "resume-hash", resumePath: "resume.pdf", workRightsAnswer: null,
    profileAssessment: { criteria, subjects: [], universities: [], summary: "Degree in Mathematics." },
  } satisfies Partial<Awaited<ReturnType<typeof candidateById>>>;
  const recommendation = { id: "recommendation", candidateId: "candidate", actor: "head@example.test", action: "head-decision",
    createdAt: at, detail: { decision: "hire", head: "Kru Peat", reason: "Clear lesson." } };
  const settingsRow = { id: "default", config, revision: 0, updatedBy: "hr@example.test", updatedAt: at,
    workerAt: null, workerSummary: null, workerError: null };
  const marks = { questions: [{ id: "1", level: "Key Stage 3" as const, marks: 9, max: 10, reason: "Correct", attempted: true, readable: true }] };
  const paper = { id: "paper", fileId: "file", updatedAt: at, marks };
  const rubric = { items: { accuracy: 8, concepts: 8, clarity: 8, presentation: 8, interaction: 8,
    pace: 8, organization: 8, materials: 8, formative: 8, feedback: 8 }, comments: "Clear examples." };
  const mock = { id: "mock", source: "person", rubric };
  const legacyEvidence: ReviewPacket["evidence"] = {
    name: candidate.name, email: candidate.email, subject: "Mathematics", resumeSha256: candidate.resumeSha256,
    ats: { score: 20, criteria },
    paper: { id: paper.id, fileId: paper.fileId, updatedAt: paper.updatedAt.toISOString(), ...computeSheet(marks, passRulesFor(config, "Mathematics")) },
    mock: { id: mock.id, rubric, total: 80 },
    recommendation: { id: recommendation.id, head: recommendation.detail.head, reason: recommendation.detail.reason },
    call: null,
  };
  const packet: ReviewPacket = {
    id: "packet", author: "hr@example.test", at: paper.updatedAt, behavioral: "Clear answers.", offer: "Start in December.",
    fingerprint: createHash("sha256").update(JSON.stringify(legacyEvidence)).digest("hex"),
    evidence: { ...legacyEvidence, ats: { ...legacyEvidence.ats, weights: DEFAULT_WEIGHTS, prestige: 0, penalty: 0 } },
  };
  vi.mocked(candidateById, { partial: true }).mockResolvedValue(candidate);
  vi.mocked(headRecommendation).mockResolvedValue(recommendation);
  vi.mocked(settings).mockResolvedValue({ config, row: settingsRow });
  const rows = new Map<unknown, unknown[]>([[hiringPaperResults, [paper]], [hiringMockResults, [mock]]]);
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => rows.get(table) }) }) } as unknown as Database;
  return { db, legacyEvidence, packet, recommendation, settingsRow };
}

it("rejects a charted packet when the ATS weights change and the score stays the same", async () => {
  const { db, legacyEvidence, packet, settingsRow } = reviewFixture();
  await expect(reviewPacketValid(db, "candidate", packet)).resolves.toBe(true);

  const profileWeights = { ...DEFAULT_WEIGHTS, degree: 11, subject: 9, school: 0 };
  const config = { ...settingsRow.config, profileWeights };
  vi.mocked(settings).mockResolvedValue({ config, row: { ...settingsRow, config } });
  await expect(reviewPacketValid(db, "candidate", packet)).resolves.toBe(false);
  await expect(reviewPacketValid(db, "candidate", { ...packet, evidence: legacyEvidence })).resolves.toBe(true);
});

it("returns false when the head recommends No", async () => {
  const { db, packet, recommendation } = reviewFixture();
  vi.mocked(headRecommendation).mockResolvedValueOnce({ ...recommendation, detail: { ...recommendation.detail, decision: "reject" } });
  await expect(reviewPacketValid(db, "candidate", packet)).resolves.toBe(false);
});

it.each([new Error("Could not read the database."), new HiringError(404, "Candidate not found.")])(
  "reports an unexpected evidence error as unknown (null), not stale: %s",
  async (error) => {
    const { db, packet } = reviewFixture();
    vi.mocked(candidateById).mockRejectedValueOnce(error);
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await expect(reviewPacketValid(db, "candidate", packet)).resolves.toBeNull();
  },
);

