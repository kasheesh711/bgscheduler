import { redirect } from "next/navigation";
import { Suspense } from "react";
import { HiringReportNav } from "@/components/hiring/hiring-report-nav";
import { AtsOutcomes } from "@/components/hiring/ats-outcomes";
import { OwnerSelections } from "@/components/hiring/owner-selections";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { atsOutcomes } from "@/lib/hiring/ats-outcomes";
import { HiringError } from "@/lib/hiring/model";

export const metadata = { title: "ATS outcomes | BeGifted Ops", robots: { index: false, follow: false } };

async function Body() {
  try {
    await requireHiringAdmin();
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    if (error.status === 401) redirect("/login?callbackUrl=%2Fhiring%2Fats-outcomes");
    return <p role="alert">Hiring access is required.</p>;
  }
  const db = getDb();
  return <>
    <AtsOutcomes report={await atsOutcomes(db)} />
    <OwnerSelections db={db} />
  </>;
}

export default function Page() {
  return <section aria-labelledby="ats-title" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto scroll-pt-24 sm:scroll-pt-14">
    <div className="mx-auto grid max-w-5xl gap-5 px-1 py-3 sm:px-6 sm:py-6">
    <Suspense><HiringReportNav active="ats-outcomes" /></Suspense>
    <header>
      <h1 id="ats-title" className="mt-3 text-3xl font-semibold tracking-tight">ATS scoring review</h1>
      <p className="mt-2 text-muted-foreground">Check the invitation rule against subject papers, mock teaching and final hiring decisions.</p>
      <a href="#owner-selections" className="mt-2 inline-block text-sm underline underline-offset-4">View Kevin’s candidate selections</a>
    </header>
    <Suspense fallback={<p role="status">Loading hiring outcomes…</p>}><Body /></Suspense>
  </div>
  </section>;
}
