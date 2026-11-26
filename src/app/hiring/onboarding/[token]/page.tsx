import { Suspense } from "react";
import { BookingShell } from "@/components/hiring/booking";
import { OnboardingForm } from "@/components/hiring/onboarding-form";
import { getDb } from "@/lib/db";
import { HiringError } from "@/lib/hiring/model";
import { onboardingView } from "@/lib/hiring/onboarding";

export const metadata = {
  title: "Tutor onboarding | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ line?: string }> };

async function Body({ params, searchParams }: Props) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  let view: Awaited<ReturnType<typeof onboardingView>>;
  try {
    view = await onboardingView(getDb(), token);
  } catch (error) {
    return <p role="alert">{error instanceof HiringError ? error.message : "Tutor onboarding is temporarily unavailable. Contact BeGifted."}</p>;
  }
  return <OnboardingForm key={token} token={token} {...view} lineIssue={query.line === "review"} />;
}

export default function Page(props: Props) {
  return <BookingShell kind="onboarding"><Suspense fallback={<p role="status">Loading tutor onboarding…</p>}><Body {...props} /></Suspense></BookingShell>;
}
