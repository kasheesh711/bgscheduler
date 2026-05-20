import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAiSchedulerConfigured } from "@/lib/ai/scheduler";
import { getTutorList } from "@/lib/data/tutors";
import { SchedulerWorkspace } from "@/components/scheduler/scheduler-workspace";

async function SchedulerBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  const tutorList = await getTutorList();

  return (
    <SchedulerWorkspace
      sessionUser={{
        email: session.user.email,
        name: session.user.name ?? session.user.email,
      }}
      aiSchedulerEnabled={isAiSchedulerConfigured()}
      tutorList={tutorList}
    />
  );
}

export default function SchedulerPage() {
  return (
    <Suspense fallback={null}>
      <SchedulerBody />
    </Suspense>
  );
}
