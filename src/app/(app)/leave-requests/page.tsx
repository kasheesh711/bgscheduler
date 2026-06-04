import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LeaveRequestsWorkspace } from "@/components/leave-requests/leave-requests-workspace";

async function LeaveRequestsBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  return <LeaveRequestsWorkspace />;
}

export default function LeaveRequestsPage() {
  return (
    <Suspense fallback={<LeaveRequestsPageSkeleton />}>
      <LeaveRequestsBody />
    </Suspense>
  );
}

function LeaveRequestsPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div>
        <div className="h-8 w-52 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-5 w-96 max-w-full animate-pulse rounded bg-muted/70" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg border border-border bg-card" />
        ))}
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 auto-rows-max items-start gap-4 overflow-x-hidden lg:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.05fr)] xl:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.05fr)_minmax(380px,0.95fr)]">
        <div className="animate-pulse rounded-lg border border-border bg-card" />
        <div className="grid min-w-0 gap-4">
          <div className="h-72 animate-pulse rounded-lg border border-border bg-card" />
          <div className="h-56 animate-pulse rounded-lg border border-border bg-card" />
        </div>
        <div className="min-h-[520px] min-w-0 animate-pulse rounded-lg border border-border bg-card lg:col-span-2 xl:col-span-1" />
      </div>
    </div>
  );
}
