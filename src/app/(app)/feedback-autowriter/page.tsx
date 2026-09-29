import { Suspense } from "react";
import { redirect } from "next/navigation";
import { FeedbackAutowriterDashboard } from "@/components/feedback-autowriter/feedback-autowriter-dashboard";
import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import { auth } from "@/lib/auth";
import { isClassroomOperationsOwner } from "@/lib/classrooms/operations-policy";
import { getDb } from "@/lib/db";
import { loadAutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";

export const metadata = { title: "Feedback Autowriter | BeGifted Ops" };

async function FeedbackAutowriterBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  const canControl = session.user.role === "admin"
    && isSuperAdminEmail(session.user.email) && isClassroomOperationsOwner(session.user.email);
  const initialData = await loadAutowriterDashboard(getDb(), { windowDays: 7 });
  return <FeedbackAutowriterDashboard initialData={initialData} canControl={canControl} />;
}

function FeedbackAutowriterSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden pb-8" role="status" aria-label="Loading feedback autowriter">
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />)}
      </div>
      <div className="h-64 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

export default function FeedbackAutowriterPage() {
  return (
    <Suspense fallback={<FeedbackAutowriterSkeleton />}>
      <FeedbackAutowriterBody />
    </Suspense>
  );
}
