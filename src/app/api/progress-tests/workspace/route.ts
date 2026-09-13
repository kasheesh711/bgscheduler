import { after } from "next/server";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { workspaceOverview, executeCommand } from "@/lib/progress-tests/workspace/data";
import { commandSchema } from "@/lib/progress-tests/workspace/commands";
import { processJobs } from "@/lib/progress-tests/workspace/jobs";
import { privateJson, requestJson, workspaceError } from "@/lib/progress-tests/workspace/http";

export const maxDuration = 300;
export async function GET() {
  try { return privateJson(await workspaceOverview(await requireWorkspace())); }
  catch (error) { return workspaceError(error); }
}
export async function POST(request: Request) {
  try {
    const scope = await requireWorkspace();
    const command = commandSchema.parse(await requestJson(request));
    const result = await executeCommand(scope, command);
    if ("jobId" in result) after(async () => { await processJobs().catch(() => undefined); });
    return privateJson(result, "jobId" in result ? 202 : 200);
  } catch (error) { return workspaceError(error); }
}
