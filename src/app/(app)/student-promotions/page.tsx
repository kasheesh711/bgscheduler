import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getLatestStudentPromotionRunDetail } from "@/lib/student-promotions/data";
import { StudentPromotionsWorkspace } from "@/components/student-promotions/student-promotions-workspace";

async function StudentPromotionsBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const detail = await getLatestStudentPromotionRunDetail();
  return <StudentPromotionsWorkspace initialDetail={detail} />;
}

function StudentPromotionsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-8 w-56 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-8 w-44 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-lg border bg-card" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="h-[520px] animate-pulse rounded-lg border bg-card" />
        <div className="h-[360px] animate-pulse rounded-lg border bg-card" />
      </div>
    </div>
  );
}

export default function StudentPromotionsPage() {
  return (
    <Suspense fallback={<StudentPromotionsSkeleton />}>
      <StudentPromotionsBody />
    </Suspense>
  );
}
