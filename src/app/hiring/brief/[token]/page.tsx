import { Suspense } from "react";
import { BriefGone, BriefLoading, BriefShell, InterviewerBrief, ScheduleLink } from "@/components/hiring/brief";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { finalReviewerKey } from "@/lib/hiring/access";
import { finalReviewAccess } from "@/lib/hiring/final-review";
import { HiringError } from "@/lib/hiring/model";
import { briefView } from "@/lib/hiring/service";

// Public: the interviewer opens this from a LINE notice, with no session. Access is the token in the path and nothing
// else (briefView). Reachability needs the `/hiring/brief/` entry in src/proxy.ts.
export const metadata = {
  title: "Interview candidate | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ embed?: string }> };

async function Body({ params, searchParams }: Props) {
  const [{ token }, { embed }] = await Promise.all([params, searchParams]);
  let brief: Awaited<ReturnType<typeof briefView>>;
  try {
    brief = await briefView(token);
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return <>{embed !== "1" && <ScheduleLink />}<BriefGone /></>;
  }
  // Gift's own mock ends in her hiring decision and an offer, not a recommendation (Kevin, 25 Nov 2026).
  const owner = !brief.paperWaived && !!brief.interviewer && brief.interviewer === await finalReviewerKey(getDb());
  // The offer also needs her sign-in. From the LINE link she may have none, so the page links to sign-in first.
  const email = owner ? (await auth())?.user?.email?.trim().toLowerCase() : undefined;
  const signIn = owner && !(email && finalReviewAccess(email).gift) ? `/login?callbackUrl=${encodeURIComponent(`/hiring/brief/${token}`)}` : undefined;
  // The page is a client component: send only the answers it shows, not the sheet row or submit time.
  const answers = brief.answers && { ...brief.answers, sourceRow: 0, submittedAt: "" };
  return <>{embed !== "1" && <ScheduleLink />}<InterviewerBrief compact={embed === "1"} owner={owner} signIn={signIn} brief={{ ...brief, answers }} resumeUrl={`/api/hiring/brief/${token}/resume`} rubricUrl={`/api/hiring/brief/${token}/rubric`} decisionUrl={`/api/hiring/brief/${token}/decision`} /></>;
}

// The head's Hiring screen opens this page inside itself with embed=1, with no gutter or second background.
async function Shell(props: Props) {
  const { embed } = await props.searchParams;
  return (
    <BriefShell bare={embed === "1"}>
      <Suspense fallback={<BriefLoading />}>
        <Body {...props} />
      </Suspense>
    </BriefShell>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<BriefShell><BriefLoading /></BriefShell>}>
      <Shell {...props} />
    </Suspense>
  );
}
