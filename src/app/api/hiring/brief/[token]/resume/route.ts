import { hiringError } from "@/lib/hiring/http";
import { resumeResponse } from "@/lib/hiring/resume-files";
import { briefCandidateId } from "@/lib/hiring/service";

export const maxDuration = 60;

/** Public: the interviewer's link is the only access check. It opens the résumé of one confirmed mock's candidate. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    return await resumeResponse(await briefCandidateId((await context.params).token));
  } catch (error) {
    return hiringError(error);
  }
}
