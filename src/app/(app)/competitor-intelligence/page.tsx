import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  CompetitorIntelligenceDashboard,
  CompetitorIntelligenceSkeleton,
} from "@/components/competitor-intelligence/competitor-intelligence-dashboard";
import {
  COMPETITOR_INTELLIGENCE_ROUTE,
  hasCompetitorIntelligenceAccess,
} from "@/lib/competitor-intelligence/access";
import { auth } from "@/lib/auth";

async function CompetitorIntelligenceBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }
  if (!hasCompetitorIntelligenceAccess(session.user.allowedPages, session.user.role)) {
    redirect("/");
  }

  return <CompetitorIntelligenceDashboard />;
}

export default function CompetitorIntelligencePage() {
  return (
    <Suspense fallback={<CompetitorIntelligenceSkeleton />}>
      <CompetitorIntelligenceBody />
    </Suspense>
  );
}

export const metadata = {
  title: `Competitor Intelligence | ${COMPETITOR_INTELLIGENCE_ROUTE}`,
};
