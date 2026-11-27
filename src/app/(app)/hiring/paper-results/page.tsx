import Link from "next/link";
import { and, eq, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HiringReportNav } from "@/components/hiring/hiring-report-nav";
import { getDb } from "@/lib/db";
import { hiringPaperResults as papers } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { paperScore } from "@/lib/hiring/assessment-view";
import { HiringError, SUBJECTS } from "@/lib/hiring/model";
import { paperChecks } from "@/lib/hiring/paper-check";
import { paperDistribution } from "@/lib/hiring/paper-distribution";
import { settings } from "@/lib/hiring/service";

import { ScoreExplorer } from "./score-explorer";
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
  const [{ config }, rows, checks] = await Promise.all([
    settings(db),
    db.select({ id: papers.id, subject: papers.subject, status: papers.status, marks: papers.marks, updatedAt: papers.updatedAt })
      .from(papers).where(and(eq(papers.status, "done"), isNotNull(papers.marks))),
    paperChecks(db, new Date()),
  ]);
  const groups = new Map<string, { score: number; subject: string; maximum: number }[]>();
  const checkById = new Map(checks.map(check => [check.resultId, check]));
  for (const paper of rows) {
    const result = paperScore(paper, config, checkById.get(paper.id));
    if ((result.verdict !== "pass" && result.verdict !== "fail") || result.percent === null || !result.max) continue;
    const group = paperGroup(paper.subject);
    const observations = groups.get(group) ?? [];
    observations.push({ score: result.percent, subject: paper.subject, maximum: result.max });
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
  return <>
    {summary.length > 0 && <ScoreExplorer rows={summary} />}
    <details className="-mt-3 text-sm text-muted-foreground">
      <summary className="cursor-pointer font-medium">How the {n} final papers are counted</summary>
      <p className="mt-2 max-w-3xl">Scores cover {summary.length} test groups. For a multi-level paper, Hiring reports the highest level passed, or the best level attempted if none passed. Papers awaiting review and historical outcomes without marks are excluded.</p>
      {empty.length > 0 && <p className="mt-1">Awaiting final scores for {empty.join(", ")}.</p>}
    </details>
    <CambridgeThresholds />
  </>;
}

export default function Page() {
  return <section aria-labelledby="paper-title" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto scroll-pt-24 sm:scroll-pt-14">
    <div className="mx-auto grid max-w-6xl gap-6 px-3 py-3 sm:px-6 sm:py-6">
      <Suspense><HiringReportNav active="paper-results" fragment="cambridge-thresholds" /></Suspense>
      <header className="border-b pb-5">
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
          <h1 id="paper-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Hiring paper results</h1>
          <Link prefetch={false} href="#cambridge-thresholds" className="text-sm font-medium text-primary hover:underline">Cambridge thresholds ↓</Link>
        </div>
      </header>
      <Suspense fallback={<p role="status">Loading paper results…</p>}><Report /></Suspense>
    </div>
  </section>;
}
