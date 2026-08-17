import { Suspense } from "react";
import { redirect } from "next/navigation";

import { StudentReportWorkspace } from "@/components/student-report/student-report-workspace";
import { auth } from "@/lib/auth";

async function StudentReportBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  return <StudentReportWorkspace />;
}

function StudentReportPageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <div>
        <div className="h-7 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-5 w-96 max-w-full animate-pulse rounded bg-muted/70" />
      </div>
      <div className="h-80 animate-pulse rounded-xl border bg-card" />
    </div>
  );
}

export default function StudentReportPage() {
  return (
    <Suspense fallback={<StudentReportPageSkeleton />}>
      <StudentReportBody />
    </Suspense>
  );
}
