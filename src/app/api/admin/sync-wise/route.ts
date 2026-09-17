import { requireClassroomOperationsOwner, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";

export const maxDuration = 800; // Pro-plan headroom for full Wise syncs

export async function POST() {
  let actor;
  try { actor = await requireClassroomOperationsOwner(); }
  catch (error) { return classroomOperationsAccessError(error); }

  return withCronInvocationAudit(
    {
      jobKey: "wise_snapshot",
      triggerSource: "admin",
      actorEmail: actor.email,
      requestMethod: "POST",
    },
    () => runWiseSyncRequest({ manualOwner: actor.email }),
  );
}
