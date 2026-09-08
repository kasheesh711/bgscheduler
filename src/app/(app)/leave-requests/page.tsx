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
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg border border-border bg-card" />
        ))}
      </div>
    </div>
  );
}
