import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { privateJson, workspaceError } from "@/lib/progress-tests/workspace/http";
async function retired() {
  try { await requireWorkspace(); return privateJson({ error: "The practice guide has retired. Prepare papers directly in Progress Tests." }, 410); }
  catch (error) { return workspaceError(error); }
}
export const GET = retired;
export const PATCH = retired;
