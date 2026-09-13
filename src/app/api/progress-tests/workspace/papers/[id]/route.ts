import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { paperDetail } from "@/lib/progress-tests/workspace/data";
import { privateJson, uuidParam, workspaceError } from "@/lib/progress-tests/workspace/http";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const scope = await requireWorkspace(); return privateJson(await paperDetail(scope, uuidParam((await context.params).id))); }
  catch (error) { return workspaceError(error); }
}
