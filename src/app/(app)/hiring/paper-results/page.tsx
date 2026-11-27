import { and, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
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

// The same question paper and scheme are registered under three teaching subjects.
const englishSubjects = ["EFL/ESL", "English Language", "English Literature"];
const englishQuestions = ["1a", "1b", "1c", "1d", "1e", "1f", "1g(i)", "1g(ii)", "writing 1", "writing 2"];

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
  const observedSubjects = new Set<string>();
  const checkById = new Map(checks.map(check => [check.resultId, check]));
  for (const paper of rows) {
    const result = paperScore(paper, config, checkById.get(paper.id));
    if ((result.verdict !== "pass" && result.verdict !== "fail") || result.percent === null || !result.max) continue;
    const labels = new Set(paper.marks?.questions.map(q => q.id.trim().toLowerCase()));
    const isSharedEnglish = englishSubjects.includes(paper.subject) && labels.size === englishQuestions.length && englishQuestions.every(label => labels.has(label));
    const group = isSharedEnglish ? "English" : paper.subject;
    const observations = groups.get(group) ?? [];
    observations.push({ score: result.percent, subject: paper.subject, maximum: result.max });
    groups.set(group, observations);
    observedSubjects.add(paper.subject);
  }
  const summary = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([subject, observations]) => {
    const subjects = new Set(observations.map(o => o.subject));
    const cutoffs = [...new Set(config.paperPassRules.filter(rule => subjects.has(rule.subject)).map(rule => rule.percent))].sort((a, b) => a - b);
    const data = paperDistribution(observations.map(o => o.score))!;
    return { subject, data, cutoffs, observations };
  });
  const empty = SUBJECTS.filter(subject => !observedSubjects.has(subject)).sort();
  const n = summary.reduce((total, row) => total + row.data.scores.length, 0);
  return <>
    {summary.length > 0 && <ScoreExplorer rows={summary} />}
    <p className="text-sm text-muted-foreground">{n} final papers across {summary.length} test groups.{empty.length > 0 && <> Awaiting final scores for {empty.join(", ")}.</>}</p>
    <CambridgeThresholds />
  </>;
}

export default function Page() {
  return <section aria-labelledby="paper-title" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto grid max-w-5xl gap-6 px-2 py-3 sm:px-6 sm:py-6">
      <header><Link href="/hiring?view=assessment" className="text-sm underline underline-offset-4">Back to Paper test</Link>
        <h1 id="paper-title" className="mt-3 text-3xl font-semibold tracking-tight">Paper results by subject</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">All-time final hiring scores grouped by test. EFL/ESL, English Language and English Literature share one reading and writing paper. For a multi-level paper, Hiring reports the highest level passed, or the best level attempted if none passed. Papers awaiting review and historical outcomes without marks are excluded.</p>
        <a href="#cambridge-thresholds" className="mt-2 inline-block text-sm underline underline-offset-4">Jump to Cambridge grade thresholds</a>
      </header>
      <Suspense fallback={<p role="status">Loading paper results…</p>}><Report /></Suspense>
    </div>
  </section>;
}
