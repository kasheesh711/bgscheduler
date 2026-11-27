import { and, count, eq, exists, inArray, ne, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { hiringCandidates as candidates, hiringDecisions as decisions, hiringPaperResults as papers, hiringMockResults as mocks } from "@/lib/db/schema";
import { DECIDED_STAGES } from "./model";
import { paperScore } from "./assessment-view";
import { rubricTotals } from "./marking-sheet";
import { paperChecks } from "./paper-check";
import { resumeAts, settings } from "./service";

import { summarizeScores } from "./ats-trial";

export async function atsOutcomes(db: Database) {
  const [{ config }, rows, [soft], paperRows, mockRows, checks] = await Promise.all([
    settings(db),
    db.select({
      id: candidates.id, name: candidates.name, stage: candidates.stage,
      profileAssessment: candidates.profileAssessment,
      universityAssessment: candidates.universityAssessment,
      workRightsAnswer: candidates.workRightsAnswer,
      confirmed: exists(db.select({ id: decisions.id }).from(decisions).where(and(
        eq(decisions.candidateId, candidates.id), eq(decisions.status, "sent"),
        or(and(eq(candidates.stage, "hired"), eq(decisions.decision, "hire")),
          and(eq(candidates.stage, "rejected"), eq(decisions.decision, "reject"))),
      ))),
    }).from(candidates).where(or(inArray(candidates.stage, [...DECIDED_STAGES]),
      exists(db.select({ id: papers.id }).from(papers).where(and(eq(papers.candidateId, candidates.id), ne(papers.source, "tracker")))),
      exists(db.select({ id: mocks.id }).from(mocks).where(and(eq(mocks.candidateId, candidates.id), ne(mocks.source, "tracker")))),
    )),

    db.select({ total: count() }).from(candidates).where(eq(candidates.stage, "soft_rejected")),
    db.select({ id: papers.id, candidateId: papers.candidateId, subject: papers.subject, status: papers.status,
      marks: papers.marks, updatedAt: papers.updatedAt }).from(papers).where(ne(papers.source, "tracker")),
    db.select({ candidateId: mocks.candidateId, subject: mocks.subject, rubric: mocks.rubric })
      .from(mocks).where(and(ne(mocks.source, "tracker"), eq(mocks.status, "done"))),
    paperChecks(db, new Date()),
  ]);
  const cases = rows.map(row => {
    const results = paperRows.filter(paper => paper.candidateId === row.id).map(paper => {
      const result = paperScore(paper, config, checks.find(check => check.resultId === paper.id));
      const attempted = paper.marks?.questions.some(question => question.attempted);
      const verdict = attempted && (result.verdict === "pass" || result.verdict === "fail") ? result.verdict : null;
      return { subject: paper.subject, verdict, percent: verdict ? result.percent : null };
    });
    // A candidate can qualify in one subject. A fail requires a settled result for every subject tested.
    const paper = results.some(r => r.verdict === "pass") ? "pass" as const
      : results.length && results.every(r => r.verdict === "fail") ? "fail" as const : null;
    const mock = mockRows.filter(m => m.candidateId === row.id && m.rubric).flatMap(m => {
      const totals = rubricTotals(m.rubric!);
      return totals.complete ? [{ subject: m.subject, percent: totals.percent }] : [];
    });
    const decision = row.confirmed ? row.stage === "hired" ? "Accepted" as const : "Rejected" as const : null;
    const ratings = (row.profileAssessment?.criteria ?? []).filter(c => c.id === "teaching" || c.id === "english")
      .map(({ id, result, evidence, reason }) => ({ id, result, evidence, reason }));
    return { id: row.id, ratings, name: row.name, ats: resumeAts(row, config), paper, results, mock, decision };
  }).filter(row => row.results.length || row.mock.length || row.decision)
    .sort((a, b) => (b.ats?.score ?? -1) - (a.ats?.score ?? -1) || a.name.localeCompare(b.name));
  const cohort = (stage: "hired" | "rejected") => summarizeScores(
    rows.filter((row) => row.stage === stage && row.confirmed).map((row) => resumeAts(row, config)),
    config.profileThreshold,
  );
  return {
    accepted: cohort("hired"), rejected: cohort("rejected"),
    cases, threshold: config.profileThreshold, softRejected: soft.total,
    stageOnly: rows.filter((row) => (row.stage === "hired" || row.stage === "rejected") && !row.confirmed).length,
  };
}
