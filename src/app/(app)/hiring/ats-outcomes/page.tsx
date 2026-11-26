import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AtsOutcomes } from "@/components/hiring/ats-outcomes";
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
  return <AtsOutcomes report={await atsOutcomes(getDb())} />;
}

export default function Page() {
  return <main className="mx-auto grid max-w-5xl gap-6 px-4 py-7 sm:px-8">
    <header>
      <Link href="/hiring" className="text-sm underline underline-offset-4">Back to Hiring</Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">ATS score outcomes</h1>
      <p className="mt-2 text-muted-foreground">Compare résumé scores with BeGifted’s final hiring decisions.</p>
    </header>
    <Suspense fallback={<p role="status">Loading hiring outcomes…</p>}><Body /></Suspense>
  </main>;
}
