import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { pdfRuntimeAsset } from "@/lib/pdf-runtime";

/** The pdf.js files that draw a résumé in the browser. Runtime assets only, never a candidate's file. */
export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  try {
    await requireHiringAdmin();
    const response = await pdfRuntimeAsset((await context.params).asset);
    if (!response) throw new HiringError(404, "Runtime asset not found.");
    return response;
  } catch (error) {
    return hiringError(error);
  }
}
