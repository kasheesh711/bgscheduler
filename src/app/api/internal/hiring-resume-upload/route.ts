import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hiringCandidates as c } from "@/lib/db/schema";
import { resumeUploadRequestSchema, verifyResumeUploadAuthorization } from "@/lib/hiring/dispatch";
import { hiringError } from "@/lib/hiring/http";
import { HiringError, RESUME_TYPES } from "@/lib/hiring/model";
import { RESUME_MAX_BYTES, resumePath } from "@/lib/hiring/resume-files";

/** Gives the Mac worker, which holds no Blob key, a token for one exact path. */
export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (!verifyResumeUploadAuthorization(body, request.headers.get("authorization")))
      throw new HiringError(401, "Hiring worker authentication failed.");
    if (process.env.VERCEL_ENV !== "production" || process.env.PREVIEW_SANDBOX_ENABLED === "true")
      throw new HiringError(503, "Résumé upload is available only in production.");
    const input = resumeUploadRequestSchema.parse(JSON.parse(body));
    const [row] = await getDb().select({ id: c.id }).from(c).where(eq(c.id, input.candidateId));
    if (!row) throw new HiringError(404, "Candidate not found.");
    const token = await generateClientTokenFromReadWriteToken({
      pathname: resumePath(input.candidateId, input.sha256, input.extension),
      maximumSizeInBytes: RESUME_MAX_BYTES,
      allowedContentTypes: [RESUME_TYPES[input.extension]],
      validUntil: Date.now() + 5 * 60000,
      addRandomSuffix: false,
      // The path holds the sha, so a retry writes the same bytes. Refusing it would strand a file whose column write failed.
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
    return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
