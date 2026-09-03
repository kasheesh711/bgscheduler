import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { UnearnedRevenueDashboard } from "@/components/unearned-revenue/unearned-revenue-dashboard";
import { auth } from "@/lib/auth";
import { requireUnearnedRevenueCapability } from "@/lib/unearned-revenue/access";

async function UnearnedRevenueBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  try {
    await requireUnearnedRevenueCapability("viewer");
  } catch {
    redirect("/");
  }
  return <UnearnedRevenueDashboard />;
}

export const metadata: Metadata = {
  title: "Unearned Revenue | BeGifted Ops",
  description: "Formula-backed student and package drilldown for unearned revenue.",
  robots: { index: false, follow: false },
};

export default function UnearnedRevenuePage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading finance dashboard…</div>}>
      <UnearnedRevenueBody />
    </Suspense>
  );
}
