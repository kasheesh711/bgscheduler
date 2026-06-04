import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDataHealthDashboardPayload } from "@/lib/data-health/dashboard";
import { DataHealthDashboard } from "@/components/data-health/data-health-dashboard";

async function DataHealthBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const payload = await getDataHealthDashboardPayload();
  return <DataHealthDashboard initialData={payload} />;
}

function DataHealthSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-8 w-44 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="h-28 animate-pulse rounded-lg border bg-card" />
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-80 animate-pulse rounded-lg border bg-card" />
        <div className="h-80 animate-pulse rounded-lg border bg-card" />
      </div>
      <div className="min-h-0 flex-1 animate-pulse rounded-lg border bg-card" />
    </div>
  );
}

export default function DataHealthPage() {
  return (
    <Suspense fallback={<DataHealthSkeleton />}>
      <DataHealthBody />
    </Suspense>
  );
}
