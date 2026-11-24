import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { paperCheckView } from "@/lib/hiring/paper-check";
import { pdfRuntimeAsset } from "@/lib/pdf-runtime";

/**
 * Public: the pdf.js files that draw the marked paper on the head's check page. The head has no session, so the
 * head's link is the access check (paperCheckView), as for the paper itself. Runtime assets only.
 * Reachability needs the `/api/hiring/paper-check/{token}/runtime/{asset}` entry in src/proxy.ts.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string; asset: string }> }) {
  try {
    const { token, asset } = await context.params;
    await paperCheckView(token);
    const response = await pdfRuntimeAsset(asset);
    if (!response) throw new HiringError(404, "Runtime asset not found.");
    return response;
  } catch (error) {
    return hiringError(error);
  }
}
