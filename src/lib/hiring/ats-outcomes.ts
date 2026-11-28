import { and, count, desc, sql, eq, exists, inArray, ne, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { hiringAudit, hiringCandidates as candidates, hiringDecisions as decisions, hiringPaperResults as papers, hiringMockResults as mocks } from "@/lib/db/schema";
import { DECIDED_STAGES } from "./model";
import { paperScore } from "./assessment-view";
import { checkRubric, rubricTotals } from "./marking-sheet";
import { paperChecks } from "./paper-check";
import { resumeAts, settings } from "./service";
import { highSchoolFraction, profileParts, PROFILE_CRITERIA } from "./scoring";
import { readTrackerResults } from "./result-history";
import { mockBacktest, type MockPair } from "./ats-mock-backtest";
import { summarizeScores } from "./ats-trial";

async function ownerPicks(db: Database) {
  return db.select({
    id: hiringAudit.id,
    name: candidates.name,
    date: sql<string>`${hiringAudit.detail}->>'selectedDate'`,
    decision: sql<string>`${hiringAudit.detail}->>'decision'`,
    university: sql<string | null>`${hiringAudit.detail}->>'university'`,
    priorScore: sql<string | null>`${hiringAudit.detail}->>'priorScore'`,
    priorScoreDate: sql<string | null>`${hiringAudit.detail}->>'priorScoreDate'`,
    cutoff: sql<string | null>`${hiringAudit.detail}->>'decisionCutoff'`,
    snapshotScore: sql<string | null>`${hiringAudit.detail}->>'snapshotScore'`,
    snapshotDate: sql<string>`${hiringAudit.detail}->>'snapshotDate'`,
  }).from(hiringAudit)
    .innerJoin(candidates, eq(candidates.id, hiringAudit.candidateId))
    .where(eq(hiringAudit.action, "owner-selection"))
    .orderBy(desc(sql`${hiringAudit.detail}->>'selectedDate'`), candidates.name);
}

export async function atsOutcomes(db: Database) {
  const { config } = await settings(db);
  const tracker = await readTrackerResults(config).catch(() => null);
  return assembleAtsReport(db, config, tracker);
}

export async function assembleAtsReport(db: Database, config: Awaited<ReturnType<typeof settings>>["config"],
  tracker: Awaited<ReturnType<typeof readTrackerResults>> | null) {
  const trackerMarks = tracker?.mocks.filter(m => m.history.score !== null && Number.isFinite(m.history.score)) ?? [];
  const ids = [...new Set(trackerMarks.map(m => m.applicantId))];
  const emails = ids.flatMap(id => tracker?.emails.get(id) || []);
  const [rows, [soft], paperRows, mockRows, checks, picks] = await Promise.all([
    db.select({
      id: candidates.id, name: candidates.name, stage: candidates.stage, applicantId: candidates.applicantId, email: candidates.email,
      profileAssessment: candidates.profileAssessment,
      universityAssessment: candidates.universityAssessment,
      workRightsAnswer: candidates.workRightsAnswer,
      confirmed: exists(db.select({ id: decisions.id }).from(decisions).where(and(
        eq(decisions.candidateId, candidates.id), eq(decisions.status, "sent"),
        or(and(eq(candidates.stage, "hired"), eq(decisions.decision, "hire")),
          and(eq(candidates.stage, "rejected"), eq(decisions.decision, "reject"))),
      ))),
    }).from(candidates).where(or(inArray(candidates.stage, [...DECIDED_STAGES]), inArray(candidates.applicantId, ids), inArray(candidates.email, emails),
      exists(db.select({ id: papers.id }).from(papers).where(and(eq(papers.candidateId, candidates.id), ne(papers.source, "tracker")))),
      exists(db.select({ id: mocks.id }).from(mocks).where(and(eq(mocks.candidateId, candidates.id), ne(mocks.source, "tracker")))),
    )),

    db.select({ total: count() }).from(candidates).where(eq(candidates.stage, "soft_rejected")),
    db.select({ id: papers.id, candidateId: papers.candidateId, subject: papers.subject, status: papers.status,
      marks: papers.marks, updatedAt: papers.updatedAt }).from(papers).where(ne(papers.source, "tracker")),
    db.select({ candidateId: mocks.candidateId, subject: mocks.subject, rubric: mocks.rubric })
      .from(mocks).where(and(ne(mocks.source, "tracker"), eq(mocks.status, "done"))),
    paperChecks(db, new Date()), ownerPicks(db),
  ]);
  const dimensions = [...Object.entries(PROFILE_CRITERIA), ["prestige", "University"], ["school", "High school"]]
    .map(([key, name]) => ({ name, weight: config.profileWeights[key as keyof typeof config.profileWeights] ?? 0 }));
  const historyByCandidate = new Map<string, { sat: boolean; marks: { subject: string; score: number }[] }>();
  let unmatchedMarks = 0;
  for (const id of ids) {
    const email = tracker?.emails.get(id);
    const matched = rows.filter(r => r.applicantId === id || (email && r.email === email));
    const marks = trackerMarks.filter(m => m.applicantId === id).map(m => ({ subject: m.subject, score: m.history.score! }));
    if (matched.length !== 1) { unmatchedMarks += marks.length; continue; }
    const entry = historyByCandidate.get(matched[0].id) ?? { sat: false, marks: [] };
    entry.marks.push(...marks);
    historyByCandidate.set(matched[0].id, entry);
  }
  for (const id of tracker?.paperSitters ?? []) {
    const email = tracker?.emails.get(id);
    const matched = rows.filter(r => r.applicantId === id || (email && r.email === email));
    if (matched.length === 1) {
      const entry = historyByCandidate.get(matched[0].id) ?? { sat:false, marks:[] };
      entry.sat = true;
      historyByCandidate.set(matched[0].id, entry);
    }
  }
  const cases = rows.map(row => {
    const results = paperRows.filter(paper => paper.candidateId === row.id).map(paper => {
      const result = paperScore(paper, config, checks.find(check => check.resultId === paper.id));
      const attempted = paper.marks?.questions.some(question => question.attempted);
      const verdict = attempted && (result.verdict === "pass" || result.verdict === "fail") ? result.verdict : null;
      return { subject: paper.subject, attempted: !!attempted, verdict, percent: verdict ? result.percent : null };
    });
    // A candidate can qualify in one subject. A fail requires a settled result for every subject tested.
    const paper = results.some(r => r.verdict === "pass") ? "pass" as const
      : results.length && results.every(r => r.verdict === "fail") ? "fail" as const : null;
    const mock = mockRows.filter(m => m.candidateId === row.id && m.rubric).flatMap(m => {
      const totals = rubricTotals(m.rubric!);
      return totals.complete && !checkRubric(m.rubric!).length ? [{ subject: m.subject, percent: totals.percent }] : [];
    });
    const decision = row.confirmed ? row.stage === "hired" ? "Accepted" as const : "Rejected" as const : null;
    const ratings = (row.profileAssessment?.criteria ?? []).filter(c => c.id === "teaching" || c.id === "english")
      .map(({ id, result, evidence, reason }) => ({ id, result, evidence, reason }));
    const fractions = row.profileAssessment ? profileParts(row.profileAssessment,
      { degree: 1, subject: 1, curriculum: 1, teaching: 1, english: 1, prestige: 1, school: 1 },
      row.universityAssessment?.fraction ?? 0, highSchoolFraction(row.profileAssessment, config)).map(p => p.earned) : null;
    return { fractions, id: row.id, ratings, name: row.name, ats: resumeAts(row, config), paper, results, mock, decision };
  })
    .sort((a, b) => (b.ats?.score ?? -1) - (a.ats?.score ?? -1) || a.name.localeCompare(b.name));
  const cohort = (stage: "hired" | "rejected") => summarizeScores(
    rows.filter((row) => row.stage === stage && row.confirmed).map((row) => resumeAts(row, config)),
    config.profileThreshold,
  );
  const backtests = (["tracker", "website"] as const).map(source => {
    const pairs: MockPair[] = [];
    let missingAts = 0, noPaper = 0, people = 0, marks = 0;
    for (const c of cases) {
      const history = historyByCandidate.get(c.id);
      const observed = source === "tracker" ? history?.marks ?? [] : c.mock.map(m => ({ subject:m.subject, score:m.percent }));
      if (!observed.length) continue;
      people++; marks += observed.length;
      if (!(history?.sat || c.results.some(r => r.attempted))) { noPaper++; continue; }
      if (!c.ats || !c.fractions) { missingAts++; continue; }
      pairs.push({ id:c.id, name:c.name, fractions:c.fractions, penalty:c.ats.penalty, saved:c.ats.score,
        mark:observed.reduce((sum,m)=>sum+m.score,0)/observed.length, subjects:observed.map(m=>m.subject) });
    }
    return { source, marks, people, noPaper, missingAts, pairs, fit:mockBacktest(pairs, dimensions.map(d=>d.weight)) };
  });
  return {
    backtests, trackerAvailable: tracker !== null, unmatchedMarks,
    accepted: cohort("hired"), rejected: cohort("rejected"),
    cases, dimensions, picks, checkedAt: new Date().toISOString(), threshold: config.profileThreshold, softRejected: soft.total,
    stageOnly: rows.filter((row) => (row.stage === "hired" || row.stage === "rejected") && !row.confirmed).length,
  };
}
