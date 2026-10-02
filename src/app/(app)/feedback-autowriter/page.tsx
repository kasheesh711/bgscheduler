import { Suspense } from "react";
import { redirect } from "next/navigation";
import { FeedbackAutowriterDashboard } from "@/components/feedback-autowriter/feedback-autowriter-dashboard";
import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import { auth } from "@/lib/auth";
import { isClassroomOperationsOwner } from "@/lib/classrooms/operations-policy";
import { getDb } from "@/lib/db";
import { loadAutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { loadAutowriterReview, reviewLoadErrorSummary, type AutowriterReviewUnavailable } from "@/lib/feedback-autowriter/review-data";
import { ALL_TUTORS, loadAutowriterTrends } from "@/lib/feedback-autowriter/trends";

export const metadata = { title: "Feedback Autowriter | BeGifted Ops" };

/** Next's own signal that a render was abandoned: passed on, never turned into an "unavailable" payload. */
function isHangingPromiseRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION";
}

async function FeedbackAutowriterBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  const canControl = session.user.role === "admin"
    && isSuperAdminEmail(session.user.email) && isClassroomOperationsOwner(session.user.email);
  const db = getDb();
  const [initialData, initialReview, initialTrends] = await Promise.all([
    loadAutowriterDashboard(db, { windowDays: 7 }),
    // The page must render whatever happens to the review data. Missing tables (migration 0101 not applied
    // yet) come back as a typed payload; any other failure is logged (name and SQLSTATE only) and shown as such.
    loadAutowriterReview(db).catch((error: unknown): AutowriterReviewUnavailable => {
      if (isHangingPromiseRejection(error)) throw error;
      console.error("[feedback-autowriter] review data could not load", reviewLoadErrorSummary(error));
      return { available: false, reason: "load_failed" };
    }),
    // The trends read the same tables and throw on any failure, missing tables included: the charts then say so.
    loadAutowriterTrends(db, { days: 14, tutorKey: ALL_TUTORS }).catch((error: unknown) => {
      if (isHangingPromiseRejection(error)) throw error;
      console.error("[feedback-autowriter] trends could not load", reviewLoadErrorSummary(error));
      return null;
    }),
  ]);
  return <FeedbackAutowriterDashboard initialData={initialData} canControl={canControl} initialReview={initialReview} initialTrends={initialTrends} />;
}

/** The page's outline while it loads: the system line, the to-do list and four chart boxes beside the rail, the table. */
function FeedbackAutowriterSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="status" aria-label="Loading feedback autowriter">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <div className="flex items-center justify-between border-b pt-1.5 pb-4">
          <div className="h-[30px] w-56 animate-pulse rounded-lg bg-muted" />
          <div className="h-7 w-32 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="mt-7 mb-[23px] space-y-2">
          <div className="h-8 w-96 max-w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
        </div>
        <div className="grid items-start gap-5 lg:grid-cols-3">
          <div className="h-[260px] animate-pulse rounded-[10px] bg-muted lg:col-span-2" />
          <div className="h-[640px] animate-pulse rounded-[10px] bg-muted lg:col-start-3 lg:row-span-2 lg:row-start-1" />
          <div className="lg:col-span-2">
            <div className="mt-2 mb-[13px] h-5 w-64 animate-pulse rounded bg-muted" />
            <div className="grid gap-[18px] lg:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-[330px] animate-pulse rounded-[10px] bg-muted" />)}
            </div>
          </div>
        </div>
        <div className="mt-7 mb-[13px] h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-[10px] bg-muted" />
      </div>
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
