import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import {
  FootTrafficDashboard,
  FootTrafficDashboardLoadError,
} from "@/components/onsite-foot-traffic/foot-traffic-dashboard";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getFootTrafficDashboard, parseFootTrafficFilters } from "@/lib/onsite-foot-traffic/data";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function DashboardSkeleton() {
  return (
    <div className="begifted flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-xl bg-white p-4">
      <div className="h-24 animate-pulse rounded-xl bg-begifted-neutral-100" />
      <div className="grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl bg-begifted-neutral-100" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-xl bg-begifted-neutral-100" />
    </div>
  );
}

function toUrlSearchParams(values: Record<string, string | string[] | undefined>): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, item);
    } else if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  return searchParams;
}

async function DashboardContent({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const [session, values] = await Promise.all([auth(), searchParams]);
  if (!session?.user?.email) redirect("/login?callbackUrl=/onsite-foot-traffic");

  let data: Awaited<ReturnType<typeof getFootTrafficDashboard>> | undefined;
  let errorMessage: string | undefined;

  try {
    const filters = parseFootTrafficFilters(toUrlSearchParams(values));
    data = await getFootTrafficDashboard(getDb(), filters);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load onsite foot traffic";
    console.error(JSON.stringify({
      level: "error",
      event: "onsite_foot_traffic_page_failed",
      route: "/onsite-foot-traffic",
      error: errorMessage,
    }));
  }

  if (!data) return <FootTrafficDashboardLoadError error={errorMessage ?? "Failed to load onsite foot traffic"} />;
  return <FootTrafficDashboard data={data} />;
}

export default function OnsiteFootTrafficPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent searchParams={searchParams} />
    </Suspense>
  );
}
