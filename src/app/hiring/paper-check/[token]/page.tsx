import { Suspense } from "react";
import { BookingShell } from "@/components/hiring/booking";
import { BriefGone, BriefLoading } from "@/components/hiring/brief";
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

async function Body({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let view: Awaited<ReturnType<typeof paperCheckView>>;
  try {
    view = await paperCheckView(token);
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return <BriefGone />;
  }
  return <PaperCheck view={view} token={token} />;
}

export default function Page(props: { params: Promise<{ token: string }> }) {
  return (
    <BookingShell kind="paper-check">
      <Suspense fallback={<BriefLoading />}>
        <Body {...props} />
      </Suspense>
    </BookingShell>
  );
}
