import type { HandleUploadBody } from "@vercel/blob/client";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { uploadHandler } from "@/lib/progress-tests/workspace/files";
import { privateJson, requestJson, workspaceError } from "@/lib/progress-tests/workspace/http";
export async function POST(request: Request) {
  try { const scope = await requireWorkspace(); return privateJson(await uploadHandler(request, await requestJson(request) as HandleUploadBody, scope)); }
  catch (error) { return workspaceError(error); }
}
