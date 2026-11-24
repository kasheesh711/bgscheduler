import { Suspense } from "react";
import { BookingShell } from "@/components/hiring/booking";
import { BriefGone, BriefLoading, ScheduleLink } from "@/components/hiring/brief";
import { PaperCheck } from "@/components/hiring/paper-check";
import { HiringError } from "@/lib/hiring/model";
import { paperCheckView } from "@/lib/hiring/paper-check";

// Public: the head opens this from a LINE notice, with no session. Access is the token in the path and nothing else
// (paperCheckView). Reachability needs the `/hiring/paper-check/` entry in src/proxy.ts.
export const metadata = {
  title: "Paper check | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ embed?: string }> };

async function Body({ params, searchParams }: Props) {
  const [{ token }, { embed }] = await Promise.all([params, searchParams]);
  let view: Awaited<ReturnType<typeof paperCheckView>>;
  try {
    view = await paperCheckView(token);
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return <>{embed !== "1" && <ScheduleLink />}<BriefGone /></>;
  }
  return <>{embed !== "1" && <ScheduleLink />}<PaperCheck view={view} token={token} /></>;
}

// The head's Hiring screen opens this page inside itself with embed=1, under its own header.
async function Shell(props: Props) {
  const { embed } = await props.searchParams;
  return (
    <BookingShell kind="paper-check" bare={embed === "1"}>
      <Suspense fallback={<BriefLoading />}>
        <Body {...props} />
      </Suspense>
    </BookingShell>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<BriefLoading />}>
      <Shell {...props} />
    </Suspense>
  );
}
