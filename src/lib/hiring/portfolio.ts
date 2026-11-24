import { get, list } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { HiringError, MAX_PORTFOLIO_BYTES, PORTFOLIO_TYPES, portfolioPath } from "./model";

/**
 * The Art & Design portfolio that a candidate uploads on the booking page (Kevin, 24 Nov 2026). One file for each
 * candidate, in private storage. A new upload replaces it. Staff open it at /api/hiring/portfolio/{candidateId}.
 */

/**
 * A short-lived browser token for that one path, because a portfolio is larger than a function request allows.
 * The caller has already checked the candidate's booking link.
 */
export function portfolioUploadHandler(request: Request, body: HandleUploadBody, candidateId: string) {
  return handleUpload({
    request,
    body,
    onBeforeGenerateToken: async (pathname) => {
      if (pathname !== portfolioPath(candidateId)) throw new HiringError(400, "Invalid upload.");
      return {
        allowedContentTypes: [...PORTFOLIO_TYPES],
        maximumSizeInBytes: MAX_PORTFOLIO_BYTES,
        addRandomSuffix: false,
        allowOverwrite: true,
        // Short, so a token taken just before the answers are sent cannot replace the file long after.
        validUntil: Date.now() + 2 * 60_000,
      };
    },
  });
}

export async function portfolioUploaded(candidateId: string) {
  const { blobs } = await list({ prefix: portfolioPath(candidateId) });
  return blobs.some((blob) => blob.pathname === portfolioPath(candidateId));
}

export async function readPortfolio(candidateId: string) {
  const blob = await get(portfolioPath(candidateId), { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new HiringError(404, "This candidate has no uploaded portfolio.");
  // Only the types the upload allows are served as themselves. Anything else downloads as plain bytes.
  const known = (PORTFOLIO_TYPES as readonly string[]).includes(blob.blob.contentType);
  const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[blob.blob.contentType] ?? "bin";
  return { stream: blob.stream, size: blob.blob.size, contentType: known ? blob.blob.contentType : "application/octet-stream", extension };
}
