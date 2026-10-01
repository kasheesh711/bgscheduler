import { Suspense } from "react";
import { redirect } from "next/navigation";
import { TutorOffboardingWorkspace } from "@/components/tutor-offboarding/tutor-offboarding-workspace";
import { auth } from "@/lib/auth";
import { viewerForEmail } from "@/lib/tutor-offboarding/access";
import { loadTutorOffboardingDashboard } from "@/lib/tutor-offboarding/service";
import type { OffboardingDashboard } from "@/lib/tutor-offboarding/types";

export const metadata = { title: "Tutor Offboarding | BeGifted Ops" };

/** Next's own signal that a render was abandoned: passed on, never turned into an "unavailable" payload. */
function isHangingPromiseRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION";
}

async function TutorOffboardingBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  const email = session.user.email.trim().toLowerCase();
  let initial: OffboardingDashboard;
  try {
    initial = await loadTutorOffboardingDashboard(await viewerForEmail(email));
  } catch (error) {
    if (isHangingPromiseRejection(error)) throw error;
    console.error("[tutor-offboarding] page could not load", { errorName: error instanceof Error ? error.name : "UnknownError" });
    initial = { available: false, reason: "load_failed", viewer: { email, isOwner: false, canRemove: false } };
  }
  return <TutorOffboardingWorkspace initial={initial} />;
}

/** The page's outline while it loads: title line, the review list beside the rail. */
function TutorOffboardingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="status" aria-label="Loading tutor offboarding">
      <div className="mx-auto w-full max-w-[1440px] pb-10 lg:px-6">
        <div className="border-b pt-1.5 pb-4">
          <div className="h-[30px] w-56 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-5 h-8 w-48 animate-pulse rounded-md bg-muted" />
        <div className="mt-4 grid gap-5 lg:grid-cols-3">
          <div className="h-[560px] animate-pulse rounded-[10px] bg-muted lg:col-span-2" />
          <div className="h-[560px] animate-pulse rounded-[10px] bg-muted" />
        </div>
      </div>
    </div>
  );
}

export default function TutorOffboardingPage() {
  return (
    <Suspense fallback={<TutorOffboardingSkeleton />}>
      <TutorOffboardingBody />
    </Suspense>
  );
}
