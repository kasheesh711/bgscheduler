import { Suspense } from "react";
import { AppNav, AppNavSkeleton } from "@/components/layout/app-nav";
import { StaleSnapshotBanner } from "@/components/layout/stale-snapshot-banner";
import { auth } from "@/lib/auth";
import { getLearningPlansAccess } from "@/lib/learning-plans/access";
import { getPostClassCapabilities } from "@/lib/post-class-feedback/access";

// Resolves the signed-in user's page access for nav filtering. Kept in its own
// async component (wrapped in <Suspense> below) so the uncached auth() call does
// not block the whole (app) route group outside a Suspense boundary — required
// by Next 16 cacheComponents. Fallback is AppNavSkeleton (no usePathname call)
// so dynamic-param routes do not trigger a prerender error on the static shell.
async function AppNavWithAccess() {
  const session = await auth();
  const [capabilities, learningPlansAccess] = await Promise.all([
    session?.user?.email
      ? getPostClassCapabilities(session.user.email)
      : Promise.resolve([]),
    getLearningPlansAccess(),
  ]);
  return (
    <AppNav
      allowedPages={session?.user?.allowedPages ?? null}
      learningPlansAccess={learningPlansAccess}
      postClassFeedbackAccess={capabilities.includes("viewer")}
    />
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<AppNavSkeleton />}>
        <AppNavWithAccess />
      </Suspense>
      <Suspense fallback={null}>
        <StaleSnapshotBanner />
      </Suspense>
      <main className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">{children}</main>
    </>
  );
}
