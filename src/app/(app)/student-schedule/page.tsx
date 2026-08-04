import { Suspense } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { StudentScheduleWorkspace } from "@/components/student-schedule/student-schedule-workspace";

async function StudentScheduleBody() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");
  return <StudentScheduleWorkspace />;
}

export default function StudentSchedulePage() {
  return (
    <Suspense fallback={null}>
      <StudentScheduleBody />
    </Suspense>
  );
}
