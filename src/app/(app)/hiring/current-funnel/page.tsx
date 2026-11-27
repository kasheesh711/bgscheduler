import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { currentFunnel } from "@/lib/hiring/current-funnel";
import { HiringError } from "@/lib/hiring/model";
import { HiringReportNav } from "@/components/hiring/hiring-report-nav";
import { CurrentFunnelWorkspace } from "@/components/hiring/current-funnel";

export const metadata = {
  title: "Current hiring funnel | BeGifted Ops",
  robots: { index: false, follow: false },
};
async function Workspace() {
  try {
    await requireHiringAdmin();
  } catch (error) {
    if (error instanceof HiringError && error.status === 401)
      redirect("/login?callbackUrl=%2Fhiring%2Fcurrent-funnel");
    if (error instanceof HiringError) return <p role="alert">Hiring access is required.</p>;
    throw error;
  }
  const report = await currentFunnel(getDb());
  return <CurrentFunnelWorkspace initial={report} fullAccess={(await auth())?.user?.allowedPages === null} />;
}
export default function Page() {
  return (
    <section className="min-h-0 flex flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <Suspense>
          <HiringReportNav active="current-funnel" fragments={[]} />
        </Suspense>
        <Suspense fallback={<p role="status">Loading candidates…</p>}>
          <Workspace />
        </Suspense>
      </div>
    </section>
  );
}
