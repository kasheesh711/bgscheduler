import { hiringError } from "@/lib/hiring/http";
import { HiringError } from "@/lib/hiring/model";
import { resumeResponse } from "@/lib/hiring/resume-files";
import { briefCandidateId } from "@/lib/hiring/service";

export const maxDuration = 60;

/**
 * Public: the interviewer's link is the only access check. It opens the résumé of one confirmed mock's candidate.
 * Every refusal is one plain 404, so the answer does not tell a link holder why (a cancel, an expiry, a deleted file).
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    return await resumeResponse(await briefCandidateId((await context.params).token));
  } catch (error) {
    if (!(error instanceof HiringError)) return hiringError(error);
    return new Response("This résumé is not available. Ask BeGifted admin for the candidate's details.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
