import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HiringReportJump, HiringReportNav } from "@/components/hiring/hiring-report-nav";
import styles from "@/components/hiring/ats-analysis.module.css";
import { AtsOutcomes } from "@/components/hiring/ats-outcomes";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { atsOutcomes } from "@/lib/hiring/ats-outcomes";
import { HiringError } from "@/lib/hiring/model";

export const metadata = { title: "ATS outcomes | BeGifted Ops", robots: { index: false, follow: false } };

const reportSections = [
  { id: "mock-backtest", label: "Mock backtest" },
  { id: "analysis", label: "Score analysis" },
  { id: "factors", label: "Score factors" },
  { id: "ats-trial", label: "Trial" },
  { id: "candidate-evidence", label: "Candidate evidence" },
  { id: "owner-selections", label: "Owner selections" },
];

async function Body() {
  try {
    await requireHiringAdmin();
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    if (error.status === 401) redirect("/login?callbackUrl=%2Fhiring%2Fats-outcomes");
    return <p role="alert">Hiring access is required.</p>;
  }
  const db = getDb();
  return <AtsOutcomes initialReport={await atsOutcomes(db)} />;
}

export default function Page() {
  return <section aria-labelledby="ats-title" tabIndex={0} className={styles.pane+" min-h-0 flex-1 overflow-y-auto scroll-pt-24 sm:scroll-pt-14"}>
    <div className="mx-auto grid min-w-0 max-w-6xl grid-cols-1 gap-5 px-1 py-3 sm:px-6 sm:py-6">
    <Suspense><HiringReportNav active="ats-outcomes" fragments={reportSections.map(({ id }) => id)} /></Suspense>
    <header>
      <h1 id="ats-title" className="mt-3 text-3xl font-semibold tracking-tight">ATS scoring review</h1>
      <p className="mt-2 text-muted-foreground">Compare résumé scores with measured results and test the weights for next month.</p>
      <nav aria-label="ATS report sections" className="mt-2 flex flex-wrap gap-x-4 text-sm font-medium">
        {reportSections.map(({ id, label }) => <HiringReportJump key={id} fragment={id} className="inline-flex min-h-11 items-center underline underline-offset-4">{label}</HiringReportJump>)}
      </nav>
    </header>
    <Suspense fallback={<p role="status">Loading hiring outcomes…</p>}><Body /></Suspense>
  </div>
  </section>;
}
