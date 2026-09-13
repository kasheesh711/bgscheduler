import type { NextRequest } from "next/server";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { requestJson, workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";

export const maxDuration = 300;
export async function POST(request: NextRequest) {
  try {
    const scope = await requireWorkspace();
    if (scope.keys !== null) throw new WorkspaceError(403, "Administrator access is required to synchronize attendance.");
    await requestJson(request);
    return await withCronInvocationAudit(
      { jobKey: "progress_tests", triggerSource: "admin", actorEmail: scope.user.email, requestMethod: "POST" },
      () => runProgressTestSyncRequest({ triggerType: "admin", actorEmail: scope.user.email }),
    );
  } catch (error) { return workspaceError(error); }
}
