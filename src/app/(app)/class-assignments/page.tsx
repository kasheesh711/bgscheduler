import { Suspense } from "react";
import { ClassAssignmentsWorkspace } from "@/components/class-assignments/class-assignments-workspace";
import { auth } from "@/lib/auth";
import { isClassroomOperationsOwner, wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";

async function ClassAssignmentsWithAccess() {
  const session = await auth();
  const canPublishAndRun = session?.user?.role === "admin";
  const canForceReassign = isClassroomOperationsOwner(session?.user?.email);
  return <ClassAssignmentsWorkspace
    canPublishAndRun={canPublishAndRun}
    canForceReassign={canForceReassign}
    automationPaused={!wiseClassroomAutomationEnabled()}
  />;
}

export default function ClassAssignmentsPage() {
  return <Suspense fallback={<div className="p-6" role="status">Loading class assignments…</div>}>
    <ClassAssignmentsWithAccess />
  </Suspense>;
}
