import { and, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getDb } from "@/lib/db";
import { hiringPaperResults as papers } from "@/lib/db/schema";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { paperScore } from "@/lib/hiring/assessment-view";
import { HiringError, SUBJECTS, type Subject } from "@/lib/hiring/model";
import { paperChecks } from "@/lib/hiring/paper-check";
import { paperDistribution } from "@/lib/hiring/paper-distribution";
import { settings } from "@/lib/hiring/service";

import { CambridgeThresholds } from "./cambridge-thresholds";

export const metadata = { title: "Paper results by subject | BeGifted Ops", robots: { index: false, follow: false } };

type Distribution = NonNullable<ReturnType<typeof paperDistribution>>;
const format = (value: number) => value.toFixed(1);
const subjectId = (subject: string) => subject.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function Chart({ subject, data, cutoffs }: { subject: string; data: Distribution; cutoffs: number[] }) {
  const { scores, mean, sd } = data;
  const x = (score: number) => 18 + 3.64 * score;
  const baseline = 88;
  // Sample around the mean so even a very narrow fitted curve includes its peak.
  const curveScores = [0, ...Array.from({ length: 129 }, (_, i) => mean + sd * (i - 64) / 12)
    .filter(score => score > 0 && score < 100), 100];
  const curve = sd > 0 ? curveScores.map(score =>
    `${x(score)},${baseline - 65 * Math.exp(-0.5 * ((score - mean) / sd) ** 2)}`).join(" ") : "";
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
  return <figure>
    <svg viewBox="0 0 400 120" className="block w-full" role="img" aria-label={`${subject} score distribution. ${scores.length} papers. Pass marks: ${cutoffs.join(", ")} percent.`}>
      <line x1={x(0)} x2={x(100)} y1={baseline} y2={baseline} stroke="currentColor" opacity=".25" />
      {curve && <>
        <polygon points={`${x(0)},${baseline} ${curve} ${x(100)},${baseline}`} fill="var(--primary)" opacity=".1" />
        <polyline points={curve} fill="none" stroke="var(--primary)" strokeWidth="2" />
      </>}
      {cutoffs.map(cutoff => <line key={cutoff} x1={x(cutoff)} x2={x(cutoff)} y1="9" y2={baseline + 6}
        stroke="currentColor" strokeDasharray="4 3" strokeWidth="1.5"><title>Pass mark {cutoff}%</title></line>)}
      {[...counts].map(([score, count]) => <circle key={score} cx={x(score)} cy={baseline} r={Math.min(8, 3 * Math.sqrt(count))} fill="var(--primary)">
        <title>{format(score)}% · {count} {count === 1 ? "paper" : "papers"}</title>
      </circle>)}
      {[0, 25, 50, 75, 100].map(tick => <text key={tick} x={x(tick)} y="112" textAnchor="middle" fill="currentColor" opacity=".75" fontSize="11">{tick}%</text>)}
    </svg>
    <figcaption className="text-xs text-muted-foreground">
      {sd === 0 && (scores.length === 1 ? "One paper. " : "All scores are equal. ")}
      {cutoffs.length ? `Pass line${cutoffs.length > 1 ? "s" : ""} at ${cutoffs.map(v => v + "%").join(", ")}.` : "No pass mark configured."}
    </figcaption>
    <details className="mt-2 text-sm"><summary className="cursor-pointer">Individual scores</summary>
      <p className="mt-1 tabular-nums">{scores.map(score => format(score) + "%").join(" · ")}</p>
    </details>
  </figure>;
}

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
  const bySubject = new Map<Subject, number[]>();
  const checkById = new Map(checks.map(check => [check.resultId, check]));
  for (const paper of rows) {
    const result = paperScore(paper, config, checkById.get(paper.id));
    if ((result.verdict !== "pass" && result.verdict !== "fail") || result.percent === null || !result.max) continue;
    const scores = bySubject.get(paper.subject) ?? [];
    scores.push(result.percent);
    bySubject.set(paper.subject, scores);
  }
  const subjects = [...SUBJECTS].sort();
  const summary = subjects.flatMap(subject => {
    const data = paperDistribution(bySubject.get(subject) ?? []);
    const cutoffs = [...new Set(config.paperPassRules.filter(rule => rule.subject === subject).map(rule => rule.percent))].sort((a, b) => a - b);
    return data ? [{ subject, data, cutoffs }] : [];
  });
  const empty = subjects.filter(subject => !bySubject.has(subject));
  const n = summary.reduce((total, row) => total + row.data.scores.length, 0);
  return <>
    <section aria-labelledby="summary-title">
      <h2 id="summary-title" className="text-xl font-semibold">Subject comparison</h2>
      <p className="my-2 text-sm text-muted-foreground">{n} final {n === 1 ? "paper" : "papers"} across {summary.length} {summary.length === 1 ? "subject" : "subjects"}. Standard deviation uses the full population and is shown in percentage points.</p>
      {summary.length > 0 && <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-left text-sm tabular-nums">
          <thead className="bg-muted text-xs"><tr>{["Subject", "Papers", "Mean", "Median", "Std. dev."].map((label, i) =>
            <th key={label} scope="col" className={`px-3 py-3 ${i ? "text-right" : ""}`}>{label}</th>)}</tr></thead>
          <tbody>{summary.map(({ subject, data }) => <tr key={subject} className="border-t">
            <th scope="row" className="px-3 py-2 font-medium"><a className="underline underline-offset-4" href={`#${subjectId(subject)}`}>{subject}</a></th>
            <td className="px-3 text-right">{data.scores.length}</td><td className="px-3 text-right">{format(data.mean)}%</td>
            <td className="px-3 text-right">{format(data.median)}%</td><td className="px-3 text-right">{format(data.sd)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {empty.length > 0 && <p className="mt-3 text-sm text-muted-foreground"><strong>No final numeric results yet.</strong> {empty.join(", ")}.</p>}
    </section>
    {summary.length > 0 && <section aria-labelledby="charts-title">
      <h2 id="charts-title" className="text-xl font-semibold">Score distributions</h2>
      <p className="my-2 text-sm text-muted-foreground">Dots show observed scores. The dashed line shows the current pass mark. The bell curve is a fitted normal distribution and requires at least two distinct scores.</p>
      <div className="grid gap-3 sm:grid-cols-2">{summary.map(({ subject, data, cutoffs }) =>
        <article key={subject} id={subjectId(subject)} className="scroll-mt-4 rounded-lg border bg-card p-4">
          <header className="flex items-baseline justify-between gap-2"><h3 className="font-semibold">{subject}</h3>
            <span className="text-xs text-muted-foreground">{data.scores.length} {data.scores.length === 1 ? "paper" : "papers"}</span></header>
          <Chart subject={subject} data={data} cutoffs={cutoffs} />
        </article>)}</div>
    </section>}
    <CambridgeThresholds />
  </>;
}

export default function Page() {
  return <section aria-labelledby="paper-title" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto grid max-w-5xl gap-6 px-2 py-3 sm:px-6 sm:py-6">
      <header><Link href="/hiring?view=assessment" className="text-sm underline underline-offset-4">Back to Paper test</Link>
        <h1 id="paper-title" className="mt-3 text-3xl font-semibold tracking-tight">Paper results by subject</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">All-time final scores from Hiring, one result per candidate and subject. For a multi-level paper, Hiring reports the highest level passed, or the best level attempted if none passed. Papers awaiting review and historical outcomes without marks are excluded.</p>
        <a href="#cambridge-thresholds" className="mt-2 inline-block text-sm underline underline-offset-4">Jump to Cambridge grade thresholds</a>
      </header>
      <Suspense fallback={<p role="status">Loading paper results…</p>}><Report /></Suspense>
    </div>
  </section>;
}
