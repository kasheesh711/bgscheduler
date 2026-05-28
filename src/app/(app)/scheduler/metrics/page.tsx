import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SchedulerMetricsView } from "@/components/scheduler/metrics-view";

async function SchedulerMetricsBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  return <SchedulerMetricsView />;
}

export default function SchedulerMetricsPage() {
  return (
    <Suspense fallback={null}>
      <SchedulerMetricsBody />
    </Suspense>
  );
}
