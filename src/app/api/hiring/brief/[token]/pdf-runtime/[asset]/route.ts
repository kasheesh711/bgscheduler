import { getDb } from "@/lib/db";
import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { briefMock } from "@/lib/hiring/service";
import { pdfRuntimeAsset } from "@/lib/pdf-runtime";

/**
 * Public: the pdf.js files that draw the résumé and the graded paper on the interviewer's page. The interviewer has no
 * session, so the link's token is the access check, as for the files themselves. Runtime assets only, never a candidate's file.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string; asset: string }> }) {
  try {
    const { token, asset } = await context.params;
    await briefMock(token, getDb(), new Date());
    const response = await pdfRuntimeAsset(asset);
    if (!response) throw new HiringError(404, "Runtime asset not found.");
    return response;
  } catch (error) {
    return hiringError(error);
  }
}
