import "server-only";

import { getGoogleDriveAccessToken } from "@/lib/sales-dashboard/google-oauth";

// ── Google Drive upload ─────────────────────────────────────────────────
//
// The only Drive contact in the codebase. Uses the per-file `drive.file`
// scope, which covers files this app creates — deliberately not the full
// `drive` scope, which is restricted and would require Google verification
// plus an annual security assessment on an External consent screen.

export interface DriveUploadResult {
  fileId: string;
  webViewLink: string | null;
  name: string;
}

interface DriveFileResponse {
  id?: string;
  name?: string;
  webViewLink?: string;
  error?: { message?: string };
}

/**
 * Create a CSV file inside an existing Drive folder.
 *
 * Multipart upload: a JSON metadata part naming the parent folder, then the
 * file body. `supportsAllDrives` is set so a folder living on a Shared Drive
 * works the same as one in My Drive.
 *
 * Note on `drive.file`: it grants access to files the app creates. Writing
 * *into* a pre-existing folder the app did not create is accepted by Drive
 * in the normal case, but a folder the connected account cannot edit fails
 * with 404 rather than 403 — Drive hides what you cannot see. The caller
 * should surface that as a setup problem, not a transient error.
 */
export async function uploadCsvToDrive(input: {
  email: string;
  folderId: string;
  filename: string;
  csv: string;
}): Promise<DriveUploadResult> {
  const accessToken = await getGoogleDriveAccessToken(input.email);
  const boundary = `bgscheduler-${crypto.randomUUID()}`;
  const metadata = {
    name: input.filename,
    mimeType: "text/csv",
    parents: [input.folderId],
  };

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/csv; charset=UTF-8",
    "",
    input.csv,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,webViewLink");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const parsed = (await response.json()) as DriveFileResponse;
  if (!response.ok || !parsed.id) {
    const detail = parsed.error?.message || `Drive upload failed (${response.status})`;
    if (response.status === 404) {
      throw new Error(
        `${detail} — the connected Google account cannot see folder ${input.folderId}. Share the folder with it as an Editor.`,
      );
    }
    throw new Error(detail);
  }
  return {
    fileId: parsed.id,
    name: parsed.name ?? input.filename,
    webViewLink: parsed.webViewLink ?? null,
  };
}
