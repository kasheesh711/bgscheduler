import { Suspense } from "react";
import { ClassAssignmentsWorkspace } from "@/components/class-assignments/class-assignments-workspace";
import { auth } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/admin-users/policy";
import { isClassroomOperationsOwner, wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";

async function ClassAssignmentsWithAccess() {
  const session = await auth();
  const canOperate = session?.user?.role === "admin"
    && isSuperAdminEmail(session.user.email) && isClassroomOperationsOwner(session.user.email);
  return <ClassAssignmentsWorkspace canOperate={canOperate} automationPaused={!wiseClassroomAutomationEnabled()} />;
}

export default function ClassAssignmentsPage() {
  return <Suspense fallback={<div className="p-6" role="status">Loading class assignments…</div>}>
    <ClassAssignmentsWithAccess />
  </Suspense>;
}
