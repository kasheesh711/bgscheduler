import type { HandleUploadBody } from "@vercel/blob/client";
import { uploadHandler } from "@/lib/progress-tests/workspace/files";
import { privateJson, workspaceError } from "@/lib/progress-tests/workspace/http";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const body = await request.json() as HandleUploadBody;
    // This public callback never issues client tokens. The SDK authenticates its signature.
    if (body.type !== "blob.upload-completed") return privateJson({ error: "Unauthorized" }, 401);
    return privateJson(await uploadHandler(request, body));
  } catch (error) { return workspaceError(error); }
}
