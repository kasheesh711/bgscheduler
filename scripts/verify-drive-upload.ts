/**
 * Proves the one assumption the payout-run CSV handoff rests on: that the
 * per-file `drive.file` scope can create a file inside a Drive folder this app
 * did not create.
 *
 * `drive.file` grants access to files the app creates. Writing INTO a
 * pre-existing folder is normally accepted, but a folder the connected account
 * cannot edit fails with 404 rather than 403 — Drive hides what you cannot
 * see. If this script fails, the fallbacks in order are: share the folder with
 * the connected account as an Editor, have the app create its own folder, or
 * write a Sheets tab instead of a CSV.
 *
 * The connected account must have signed in since `drive.file` was added to
 * the sign-in scope, or there is no Drive-capable token to use.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-drive-upload.ts
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-drive-upload.ts \
 *     --folder-id <id> --email <address>
 *
 * The `--tsconfig` flag is required: `drive.ts` declares itself `server-only`,
 * which Next resolves during its own build but plain `tsx` cannot. The scripts
 * tsconfig maps that import to an empty stub. See `scripts/stubs/server-only.ts`
 * for why the mapping is not in the root tsconfig.
 *
 * Reads DATABASE_URL and AUTH_SECRET from `.env.local` — a git worktree does not
 * inherit it, so copy it in if this is a fresh worktree.
 *
 * Creates one small file in the target folder. Delete it afterwards.
 */

import fs from "node:fs";
import path from "node:path";

import { getDb } from "@/lib/db";
import { getGoogleTokenStatus, hasDriveFileScope } from "@/lib/sales-dashboard/google-oauth";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { uploadCsvToDrive } from "@/lib/post-class-feedback/drive";
import { PAYOUT_DRIVE_FOLDER_ID, payoutConnectedEmail } from "@/lib/post-class-feedback/payout-config";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const email = (optionValue("--email") ?? payoutConnectedEmail()).toLowerCase();
  const folderId = optionValue("--folder-id") ?? PAYOUT_DRIVE_FOLDER_ID;

  console.log(`Connected account: ${email}`);
  console.log(`Target folder:     ${folderId}`);

  const [token] = await getDb()
    .select({ scope: schema.googleOAuthTokens.scope })
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, email))
    .limit(1);
  const status = await getGoogleTokenStatus(email);

  if (!token) {
    console.error(`\nNo Google token stored for ${email}. Sign in as that account first.`);
    process.exit(1);
  }
  if (!hasDriveFileScope(token.scope)) {
    console.error(
      `\n${email} has no drive.file scope on record.`
      + "\nOpen the post-class feedback workspace as that account and use"
      + " \"Reconnect Google\" to re-consent, then run this again.",
    );
    console.error(`Scopes currently granted: ${token.scope ?? "(none)"}`);
    process.exit(1);
  }
  console.log(`Sheets write scope: ${status.writeConnected ? "yes" : "no"}`);
  console.log("Drive file scope:   yes\n");

  try {
    const result = await uploadCsvToDrive({
      email,
      folderId,
      filename: "bgscheduler-drive-scope-probe.csv",
      csv: "probe,value\r\ndrive.file,ok\r\n",
    });
    console.log("PASS — drive.file created a file in a folder the app does not own.");
    console.log(`  fileId:      ${result.fileId}`);
    console.log(`  name:        ${result.name}`);
    console.log(`  webViewLink: ${result.webViewLink ?? "(none)"}`);
    console.log("\nDelete the probe file from the folder when you are done.");
  } catch (error) {
    console.error("FAIL — the upload was refused.");
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "\nWhat the three known failures mean:"
      + "\n  · 'has not been used in project' / 'is disabled' — the Drive API is off"
      + "\n    for the Cloud project behind AUTH_GOOGLE_ID. Enable it in the console"
      + "\n    and wait a minute. Nothing to do with scopes or the folder."
      + "\n  · 404 — the connected account cannot SEE the folder. Drive hides what you"
      + "\n    cannot access, so this is a permissions problem: share it as an Editor."
      + "\n  · 403 insufficient permissions — the scope is missing; re-consent.",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
