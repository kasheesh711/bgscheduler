import { and, count, eq, isNotNull, not, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HiringReportJump, HiringReportNav } from "@/components/hiring/hiring-report-nav";
import { getDb } from "@/lib/db";
import { hiringCandidates as candidates, hiringPaperResults as papers } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { paperScore } from "@/lib/hiring/assessment-view";
import { HiringError, SUBJECTS } from "@/lib/hiring/model";
import { paperChecks } from "@/lib/hiring/paper-check";
import { paperDistribution } from "@/lib/hiring/paper-distribution";
import { resumeAts, settings } from "@/lib/hiring/service";

import { ScoreExplorer, type PaperObservation } from "./score-explorer";
import { CambridgeThresholds } from "./cambridge-thresholds";

// Hiring uses the English Language paper for all three English teaching tracks.
const paperGroup = (subject: string) =>
  subject === "EFL/ESL" || subject === "English Literature" ? "English Language" : subject;

export const metadata = { title: "Paper results by subject | BeGifted Ops", robots: { index: false, follow: false } };

async function Report() {
  try {
    await requireHiringAdmin();
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    if (error.status === 401) redirect("/login?callbackUrl=%2Fhiring%2Fpaper-results");
    return <p role="alert">Hiring access is required.</p>;
  }
  const db = getDb();
  const markedAndDone = and(eq(papers.status, "done"), isNotNull(papers.marks))!;
  const excluded = db.select({
    id: sql<null>`null::uuid`, subject: papers.subject, status: papers.status, source: papers.source,
    marks: sql<null>`null::jsonb`, updatedAt: sql<null>`null::timestamptz`, records: count(),
    candidateId: sql<null>`null::uuid`, name: sql<null>`null::text`, profileAssessment: sql<null>`null::jsonb`,
    universityAssessment: sql<null>`null::jsonb`, workRightsAnswer: sql<null>`null::text`, experience: sql<null>`null::text`,
  }).from(papers).where(not(markedAndDone)).groupBy(papers.subject, papers.status, papers.source);
  const [{ config }, rows, checks] = await Promise.all([
    settings(db),
    db.select({
      id: sql<string | null>`${papers.id}`, subject: papers.subject, status: papers.status, source: papers.source,
      marks: papers.marks,
      updatedAt: sql<Date | null>`${papers.updatedAt}`.mapWith((value: string | Date | null) => typeof value === "string" ? new Date(value) : value),
      records: sql<number>`1`.mapWith(Number),
      candidateId: sql<string | null>`${candidates.id}`, name: sql<string | null>`${candidates.name}`,
      profileAssessment: candidates.profileAssessment, universityAssessment: candidates.universityAssessment,
      workRightsAnswer: candidates.workRightsAnswer, experience: sql<string | null>`${candidates.preScreen}->>'experience'`,
    }).from(papers).innerJoin(candidates, eq(candidates.id, papers.candidateId)).where(markedAndDone).unionAll(excluded),
    paperChecks(db, new Date()),
  ]);
  const groups = new Map<string, PaperObservation[]>();
  const checkById = new Map(checks.map(check => [check.resultId, check]));
  const exclusions = { unfinished: 0, review: 0, historical: 0, unscored: 0 };
  for (const paper of rows) {
    if (paper.id === null || paper.candidateId === null || paper.name === null) {
      if (paper.status === "needs_check") exclusions.review += paper.records;
      else if (paper.status !== "done") exclusions.unfinished += paper.records;
      else if (paper.source === "tracker") exclusions.historical += paper.records;
      else exclusions.unscored += paper.records;
      continue;
    }
    const result = paperScore({ ...paper, id: paper.id, updatedAt: paper.updatedAt ?? undefined }, config, checkById.get(paper.id));
    if ((result.verdict !== "pass" && result.verdict !== "fail") || result.percent === null || !result.max) {
      if (result.verdict === "checking" || result.verdict === "needs_check") exclusions.review++;
      else exclusions.unscored++;
      continue;
    }
    const group = paperGroup(paper.subject);
    const observations = groups.get(group) ?? [];
    const teaching = paper.profileAssessment?.criteria.find(criterion => criterion.id === "teaching");
    const experience = paper.experience?.trim() || teaching?.brief || teaching?.reason || null;
    observations.push({
      score: result.percent, subject: paper.subject, earned: result.scored, maximum: result.max,
      candidateId: paper.candidateId, name: paper.name, atsScore: resumeAts(paper, config)?.score ?? null,
      university: paper.universityAssessment?.name || paper.profileAssessment?.universities?.find(u => u.completedDegree)?.name || null,
      experience: experience && experience.length > 150 ? experience.slice(0, 149).trimEnd() + "…" : experience,
    });
    groups.set(group, observations);
  }
  const summary = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([subject, observations]) => {
    const subjects = new Set(observations.map(o => o.subject));
    const cutoffs = [...new Set(config.paperPassRules.filter(rule => subjects.has(rule.subject)).map(rule => rule.percent))].sort((a, b) => a - b);
    const data = paperDistribution(observations.map(o => o.score))!;
    return { subject, data, cutoffs, observations };
  });
  const empty = [...new Set(SUBJECTS.map(paperGroup))].filter(group => !groups.has(group)).sort();
  const n = summary.reduce((total, row) => total + row.data.scores.length, 0);
  const excludedCount = exclusions.unfinished + exclusions.review + exclusions.historical + exclusions.unscored;
  return <>
    {summary.length > 0 && <ScoreExplorer rows={summary} />}
    <details className="-mt-3 rounded-lg border bg-card p-3 text-sm">
      <summary className="min-h-10 cursor-pointer py-2 font-medium">Paper records across all groups · {n} counted · {excludedCount} excluded</summary>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums sm:grid-cols-4">
        {([["Unfinished or failed marking", exclusions.unfinished], ["Awaiting review", exclusions.review], ["Historical record without marks", exclusions.historical], ["Other record without a final score", exclusions.unscored]] as const).map(([label, number]) =>
          <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-semibold">{number}</dd></div>)}
      </dl>
      <p className="mt-3 max-w-3xl text-muted-foreground">A final score of 0% counts. For a paper with several levels, the score comes from the highest level passed or the best level attempted.</p>
      {empty.length > 0 && <p className="mt-1 text-muted-foreground">Awaiting final scores for {empty.join(", ")}.</p>}
    </details>
    <CambridgeThresholds />
  </>;
}

export default function Page() {
  return <section aria-labelledby="paper-title" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto scroll-pt-24 sm:scroll-pt-14">
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-3 py-3 sm:px-6 sm:py-6">
      <Suspense><HiringReportNav active="paper-results" fragments={["cambridge-thresholds"]} /></Suspense>
      <header className="border-b pb-5">
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
          <h1 id="paper-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Hiring paper results</h1>
          <HiringReportJump fragment="cambridge-thresholds" className="text-sm font-medium text-primary hover:underline">Cambridge thresholds ↓</HiringReportJump>
        </div>
      </header>
      <Suspense fallback={<p role="status">Loading paper results…</p>}><Report /></Suspense>
    </div>
  </section>;
}
