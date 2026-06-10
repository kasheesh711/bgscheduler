import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SalesDashboardShell } from "@/components/sales-dashboard/sales-dashboard-shell";
import { SalesDashboardSkeleton } from "@/components/skeletons/sales-dashboard-skeleton";
import { auth } from "@/lib/auth";

async function SalesDashboardBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  return <SalesDashboardShell />;
}

export default function SalesDashboardPage() {
  return (
    <Suspense fallback={<SalesDashboardSkeleton />}>
      <SalesDashboardBody />
    </Suspense>
  );
}
