import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LeaveRequestsWorkspace } from "@/components/leave-requests/leave-requests-workspace";

async function LeaveRequestsBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  return <LeaveRequestsWorkspace />;
}

export default function LeaveRequestsPage() {
  return (
    <Suspense fallback={null}>
      <LeaveRequestsBody />
    </Suspense>
  );
}
