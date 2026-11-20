import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { OnboardingWorkspace } from "@/components/hiring/onboarding-workspace";
import { getDb } from "@/lib/db";
import { requireHiringHr } from "@/lib/hiring/access";
import { expertsRoster } from "@/lib/hiring/experts";
import { HiringError } from "@/lib/hiring/model";
import { onboardingRoster } from "@/lib/hiring/onboarding";
import { onboardingEnabled, tutorGroupTemplate } from "@/lib/hiring/onboarding-config";

export const metadata = { title: "Tutor onboarding | BeGifted Ops", robots: { index: false, follow: false } };

async function Body() {
  try {
    await requireHiringHr();
  } catch (error) {
    if (error instanceof HiringError && error.status === 401) redirect("/login?callbackUrl=%2Fhiring%2Fonboarding");
    return <p role="alert">Hiring HR access is required.</p>;
  }
  const db = getDb();
  const [hires, experts] = await Promise.all([onboardingRoster(db), expertsRoster(db)]);
  return <OnboardingWorkspace hires={hires} experts={experts}
    template={tutorGroupTemplate()} formEnabled={onboardingEnabled()} />;
}

export default function Page() {
  return <main className="mx-auto grid max-w-5xl gap-5 p-5 sm:p-8">
    <div><Link className="text-sm underline underline-offset-4" href="/hiring">Back to Hiring</Link>
      <h1 className="mt-2 text-2xl font-semibold">Tutor onboarding</h1>
    </div>
    <Suspense fallback={<p role="status">Loading onboarding…</p>}><Body /></Suspense>
  </main>;
}
