import { Suspense } from "react";
import { redirect } from "next/navigation";
import { HomeHub } from "@/components/home/home-hub";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getHomeSummaryPayload } from "@/lib/home/summary";

async function HomeBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  const allowedPages = session.user.allowedPages ?? null;
  if (allowedPages?.length === 1) redirect(allowedPages[0]);

  const summary = await getHomeSummaryPayload({
    allowedPages,
    email: session.user.email,
  }, getDb());

  return <HomeHub summary={summary} allowedPages={allowedPages} />;
}

function HomeSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-8 w-44 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg border bg-card" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-20 animate-pulse rounded-lg border bg-card" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-lg border bg-card" />
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeBody />
    </Suspense>
  );
}
