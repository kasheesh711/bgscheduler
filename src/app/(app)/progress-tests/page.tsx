import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireProgressTestsSession } from "@/lib/progress-tests/api";
import { ProgressTestsDashboard } from "@/components/progress-tests/progress-tests-dashboard";

async function ProgressTestsBody() {
  let user;
  try {
    user = await requireProgressTestsSession();
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }
    throw error;
  }

  return <ProgressTestsDashboard sessionUser={user} />;
}

export function ProgressTestsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-8 w-44 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-72 max-w-full animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
      </div>
      <div className="h-10 animate-pulse rounded-lg border bg-card" />
      <div className="min-h-0 flex-1 animate-pulse rounded-lg border bg-card" />
    </div>
  );
}

export default function ProgressTestsPage() {
  return (
    <Suspense fallback={<ProgressTestsSkeleton />}>
      <ProgressTestsBody />
    </Suspense>
  );
}
