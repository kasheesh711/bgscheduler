import { Suspense } from "react";
import { BookingShell } from "@/components/hiring/booking";
import { BriefGone, BriefLoading, InterviewerBrief } from "@/components/hiring/brief";
import { HiringError } from "@/lib/hiring/model";
import { briefView } from "@/lib/hiring/service";

// Public: the interviewer opens this from a LINE notice, with no session. Access is the token in the path and nothing
// else (briefView). Reachability needs the `/hiring/brief/` entry in src/proxy.ts.
export const metadata = {
  title: "Interview candidate | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

async function Body({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let brief: Awaited<ReturnType<typeof briefView>>;
  try {
    brief = await briefView(token);
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return <BriefGone />;
  }
  return <InterviewerBrief brief={brief} resumeUrl={`/api/hiring/brief/${token}/resume`} rubricUrl={`/api/hiring/brief/${token}/rubric`} />;
}

export default function Page(props: { params: Promise<{ token: string }> }) {
  return (
    <BookingShell kind="brief">
      <Suspense fallback={<BriefLoading />}>
        <Body {...props} />
      </Suspense>
    </BookingShell>
  );
}
