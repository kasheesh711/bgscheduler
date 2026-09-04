import { Suspense } from "react";

import { FootTrafficDashboard } from "@/components/onsite-foot-traffic/foot-traffic-dashboard";

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

export default function OnsiteFootTrafficPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <FootTrafficDashboard />
    </Suspense>
  );
}
