import { pdfRuntimeAsset } from "@/lib/pdf-runtime";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";

/** Runtime assets only. No caller-controlled paths or source documents. */
export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    await requireWorkspace();
    const response = await pdfRuntimeAsset((await context.params).asset);
    if (!response) throw new WorkspaceError(404, "Runtime asset not found.");
    return response;
  } catch (error) { return workspaceError(error); }
}
