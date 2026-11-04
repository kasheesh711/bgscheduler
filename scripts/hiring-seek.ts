import { chromium, type Page } from "playwright-core";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import JSZip from "jszip";
import {
  parseSeekFolderCounts,
  type Application,
} from "../src/lib/hiring/model";
import { BackfillFatal, type BackfillRead } from "../src/lib/hiring/backfill";
import type { ResumeFile } from "../src/lib/hiring/resume-files";
import { readWorkRights, redactProfile, removeWorkRights } from "../src/lib/hiring/seek-text";

const ID_CONTROL = 'input[id^="checkbox-"], button[id$="-move-to"]';

export { redactProfile };
async function documentText(data: Buffer) {
  if (data.length > 15 * 1024 * 1024)
    throw new Error("Resume exceeds the 15 MB import limit.");
  if (data.subarray(0, 5).toString() === "%PDF-") {
    const task = getDocument({
      data: new Uint8Array(data),
      useSystemFonts: false,
    });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 30)
        throw new Error("Resume exceeds the 30-page import limit.");
      const parts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        parts.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      return parts.join("\n").slice(0, 120000);
    } finally {
      await task.destroy();
    }
  }
  if (data.subarray(0, 2).toString() === "PK") {
    const zip = await JSZip.loadAsync(data);
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("Unsupported resume document.");
    const xml = await entry.async("string");
    if (xml.length > 2000000) throw new Error("Resume text is too large.");
    return xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .slice(0, 120000);
  }
  throw new Error("The resume is not a supported PDF or Word document.");
}

export async function connectSeek(profilePath: string, jobId: string) {
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  const browser = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: false,
    acceptDownloads: false,
  });
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(`https://th.employer.seek.com/candidates/?jobid=${jobId}`);
    console.log(
      "Sign in to SEEK in this browser. The connection will close after the candidate list is available.",
    );
    await page
      .getByTestId("job-application-card")
      .first()
      .waitFor({ state: "visible", timeout: 300000 });
  } finally {
    await browser.close();
  }
}

/** `resumeFailed`: a résumé control was there but the download failed. `resumeUnusable`: the file can never be read (not PDF or Word, encrypted, too long). */
type ApplicationRead = {
  application: Application;
  resumeFile: ResumeFile | null;
  resumeFailed: boolean;
  resumeUnusable: boolean;
};

/**
 * `forBackfill` skips two checks the backfill does not use: the status line on the card and the Emails tab. The worker's
 * own read keeps both.
 */
async function readApplication(
  page: Page,
  card: ReturnType<Page["getByTestId"]>,
  jobId: string,
  forBackfill = false,
): Promise<ApplicationRead> {
  const move = card.locator(
    'button[aria-label^="Move "][aria-haspopup="true"]',
  );
  const id = (await card.locator(ID_CONTROL).first().getAttribute("id"))
    ?.replace(/^checkbox-/, "")
    .replace(/-move-to$/, "");
  const label = await move.getAttribute("aria-label");
  const name = label?.match(
    /^Move (.+) (?:to a status|from (?:Inbox|Prescreen|Shortlist|Interview|Offer|Accept|Not Suitable))$/,
  )?.[1];
  if (!id || !name)
    throw new Error("SEEK candidate selectors changed; import stopped.");
  const summary = await card.innerText();
  const status = [
    "Inbox",
    "Prescreen",
    "Shortlist",
    "Interview",
    "Offer",
    "Accept",
    "Not Suitable",
  ].find((s) =>
    summary
      .split("\n")
      .map((t) => t.trim())
      .includes(s),
  );
  if (!status && !forBackfill) throw new Error("SEEK candidate status could not be verified.");
  await card.getByText(name, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Candidate details" });
  await dialog.waitFor({ state: "visible" });
  let resumeText = "";
  let resumeFile: ResumeFile | null = null;
  let resumeFailed = false;
  let resumeUnusable = false;
  try {
    await dialog.getByRole("tab", { name: /^Profile(?:\s+Profile)*$/ }).click();
    const profile = dialog.getByRole("tabpanel", { name: "Profile" });
    await profile
      .getByRole("heading", { name: "Application questions", exact: true })
      .waitFor({ state: "visible" });
    const emailLink = dialog.locator('a[href^="mailto:"]');
    const emailHref =
      (await emailLink.count()) === 1
        ? await emailLink.getAttribute("href")
        : null;
    const email = emailHref
      ? decodeURIComponent(emailHref.slice(7)).trim().toLowerCase()
      : null;
    for (let i = 0; i < 20; i++) {
      const more = profile.getByRole("button", { name: "More", exact: true });
      if ((await more.count()) === 0) break;
      await more.first().click();
    }
    const full = await profile.innerText();
    const educationStart = full.indexOf("Career history");
    const workRightsAnswer = readWorkRights(full);
    const cleaned = removeWorkRights(
      (educationStart >= 0 ? full.slice(educationStart) : full).replace(
        /Employment status[\s\S]*?(?=Application questions|$)/i,
        "",
      ),
    )
      .replace(/Expected monthly salary\s*\n[^\n]*/i, "");
    const resume = dialog.getByRole("button", { name: "Resumé", exact: true });
    const resumeTab = dialog.getByRole("tab", { name: "Resumé" });
    if ((await resume.count()) || (await resumeTab.count())) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bgs-hiring-"));
      try {
        let downloadButton = resume;
        if (await resumeTab.count()) {
          await resumeTab.click();
          downloadButton = dialog.getByRole("button", {
            name: "Download document",
            exact: true,
          });
        }
        await downloadButton.waitFor({ state: "visible", timeout: 10000 });
        const downloadPromise = page.waitForEvent("download", {
          timeout: 20000,
        });
        await downloadButton.click();
        const download = await downloadPromise;
        const file = path.join(dir, "resume");
        await download.saveAs(file);
        const bytes = await readFile(file);
        // Playwright keeps its own copy in a temp folder until the browser closes.
        await download.delete().catch(() => {});
        try {
          resumeText = redactProfile(await documentText(bytes), name);
          // Only a file that passed the extractor's limits is kept. The model reads the redacted text, never the file.
          resumeFile = { bytes, name: download.suggestedFilename() };
        } catch {
          // A file that is read but cannot be used will not be usable on a later run either.
          resumeUnusable = true;
        }
      } catch {
        resumeText = "";
        resumeFailed = true;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const emailsTab = dialog.getByRole("tab", {
      name: /^Emails(?: \(\d+\))?$/,
    });
    if (!forBackfill && (await emailsTab.count()) !== 1)
      throw new Error("SEEK email history could not be verified.");
    const emailsText = forBackfill ? "" : await emailsTab.innerText();
    const previouslyContacted =
      Number(emailsText.match(/\((\d+)\)/)?.[1] ?? 0) > 0;
    if (new URL(page.url()).searchParams.get("jobid") !== jobId)
      throw new Error("SEEK changed to another job during import.");
    return {
      application: {
        applicationId: id,
        name,
        email,
        profileText: redactProfile(cleaned, name),
        resumeText,
        previouslyContacted,
        sourceStatus: status ?? "",
        workRightsAnswer,
        jobId,
      },
      resumeFile,
      resumeFailed,
      resumeUnusable,
    };
  } finally {
    await dialog
      .getByRole("button", { name: "Close modal", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
  }
}

/** Saves the text first, so a failed upload cannot lose the import. False means the file was not stored. */
export async function saveApplication(
  { application, resumeFile }: Pick<ApplicationRead, "application" | "resumeFile">,
  consume: (value: Application) => Promise<string>,
  keepFile: (candidateId: string, file: ResumeFile) => Promise<boolean>,
) {
  const candidateId = await consume(application);
  return !resumeFile || keepFile(candidateId, resumeFile);
}

/** Pause between candidates in a pass that opens many profiles. It is the worker's own 10-second watch step. */
export const SEEK_PAUSE_MS = 10000;
const SEEK_SIGNED_OUT = "SEEK is signed out. Run npm run hiring:worker -- --connect-seek, then start this again.";
/** An error whose text is fixed here, so it is safe to print. Playwright's own errors can quote page text such as a name. */
class SeekPageError extends Error {}
/** The folder count changed while the pass walked it. */
class SeekListChanged extends SeekPageError {}

/** Signed in means SEEK stayed on the employer candidates page. A sign-in redirect leaves it. */
export const seekSignedIn = (url: string) => {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname === "th.employer.seek.com" && pathname.startsWith("/candidates");
  } catch {
    return false;
  }
};

type SeekCard = { page: Page; cards: ReturnType<Page["getByTestId"]>; index: number; id: string; status: string };

/** Opens each status folder and walks every page of cards. `visit` decides what to do with one card. */
async function walkSeek(
  browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  jobId: string,
  visit: (card: SeekCard) => Promise<void>,
) {
  let scanned = 0;
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`https://th.employer.seek.com/candidates/?jobid=${jobId}`);
  if (!seekSignedIn(page.url())) throw new SeekPageError(SEEK_SIGNED_OUT);
  const statusButtons = page.getByRole("button", {
    name: /^(Inbox|Prescreen|Shortlist|Interview|Offer|Accept|Not Suitable).*applications?$/i,
  });
  const compactFilter = page
    .getByText("Filter and search", { exact: true })
    .filter({ visible: true })
    .last();
  const notice = page.getByRole("heading", {
    name: "How to check references",
    exact: true,
  });
  // Filters can hydrate after the first candidate card is visible.
  try {
    await Promise.race([
      statusButtons.first().waitFor({ state: "visible" }),
      compactFilter.waitFor({ state: "visible" }),
      notice.waitFor({ state: "visible" }),
    ]);
  } catch (error) {
    if (!seekSignedIn(page.url())) throw new SeekPageError(SEEK_SIGNED_OUT);
    throw error;
  }
  if (await notice.isVisible()) {
    await page
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await Promise.race([
      statusButtons.first().waitFor({ state: "visible" }),
      compactFilter.waitFor({ state: "visible" }),
    ]);
  }
  let labels = await statusButtons.evaluateAll((elements) =>
    elements.map((el) => (el as HTMLElement).innerText),
  );
  if (!labels.length) {
    await compactFilter.click();
    const filter = page.getByRole("dialog", {
      name: "Filter applications by",
    });
    const region = filter.getByRole("region", {
      name: "Status",
      exact: true,
    });
    if (!(await region.isVisible()))
      await filter
        .getByRole("button", { name: "Status", exact: true })
        .click();
    labels = await region
      .getByRole("button")
      .evaluateAll((elements) =>
        elements.map((el) => (el as HTMLElement).innerText),
      );
    await filter.getByRole("button", { name: "Close", exact: true }).click();
  }
  const folders = parseSeekFolderCounts(labels);
  const allIds = new Set<string>();
  for (const { status, count } of folders) {
    if (!count) continue;
    const filter = status === "Not Suitable" ? "Rejected" : status;
    await page.goto(
      `https://th.employer.seek.com/candidates/?jobid=${jobId}&s=${encodeURIComponent(filter)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("job-application-card")
      .filter({ visible: true })
      .locator(ID_CONTROL)
      .first()
      .waitFor({ state: "attached", timeout: 30000 });
    const seenPages = new Set<string>();
    let folderScanned = 0;
    for (let p = 0; p < 200; p++) {
      const cards = page
        .getByTestId("job-application-card")
        .filter({ visible: true });
      const ids = await cards.evaluateAll(
        (elements, selector) =>
          elements.map((card) =>
            (card.querySelector(selector)?.id ?? "")
              .replace(/^checkbox-/, "")
              .replace(/-move-to$/, ""),
          ),
        ID_CONTROL,
      );
      const pageKey = ids.join(",");
      if (!ids.length || ids.some((id) => !id))
        throw new SeekPageError(
          `SEEK ${status} page ${p + 1} has no visible applications.`,
        );
      if (seenPages.has(pageKey))
        throw new SeekPageError(
          `SEEK ${status} page ${p + 1} repeated the previous page.`,
        );
      if (ids.some((id) => allIds.has(id)))
        throw new SeekPageError(
          `SEEK ${status} page ${p + 1} repeated an application from an earlier page or folder.`,
        );
      seenPages.add(pageKey);
      folderScanned += ids.length;
      scanned += ids.length;
      for (let i = 0; i < ids.length; i++) {
        allIds.add(ids[i]);
        await visit({ page, cards, index: i, id: ids[i], status });
      }
      const next = page.getByRole("link", { name: "Next", exact: true });
      if (!(await next.count())) break;
      await next.click();
      await page.waitForFunction(
        ({ previous, selector }) => {
          const card = [
            ...document.querySelectorAll(
              '[data-testid="job-application-card"]',
            ),
          ].find(
            (card) =>
              card.getClientRects().length > 0 &&
              getComputedStyle(card).visibility !== "hidden",
          );
          const el = card?.querySelector(selector);
          return !!el && !el.id.includes(previous);
        },
        { previous: ids[0], selector: ID_CONTROL },
        { timeout: 30000 },
      );
      if (p === 199) throw new SeekPageError("SEEK page limit exceeded.");
    }
    if (folderScanned !== count)
      throw new SeekListChanged(
        `SEEK ${status} count changed during import. Retry before sending messages.`,
      );
  }
  return { scanned, folders };
}

export async function importSeek(
  profilePath: string,
  jobId: string,
  knownIds: Set<string>,
  consume: (value: Application) => Promise<string>,
  observe: (id: string, status: string, contacted: boolean) => Promise<void>,
  // Must not throw. It returns false when the file was not stored.
  keepFile: (candidateId: string, file: ResumeFile) => Promise<boolean>,
  // New imports this pass. Several jobs share one budget per cycle.
  max = 40,
) {
  const browser = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  let imported = 0,
    remaining = 0,
    resumeUploadsFailed = 0;
  const onWebsite = new Map<string, number>();
  const count = (status: string) => onWebsite.set(status, (onWebsite.get(status) ?? 0) + 1);
  try {
    const { scanned, folders } = await walkSeek(browser, jobId, async ({ page, cards, index, id, status }) => {
      if (knownIds.has(id)) {
        count(status);
        const contacted =
          (await cards
            .nth(index)
            .getByRole("button", { name: /^Emails? \([1-9]\d*\)$/ })
            .count()) > 0;
        await observe(id, status, contacted);
      } else if (["Inbox", "Prescreen", "Shortlist"].includes(status)) {
        if (imported >= max) {
          remaining++;
          return;
        }
        const read = await readApplication(page, cards.nth(index), jobId);
        if (!(await saveApplication(read, consume, keepFile))) resumeUploadsFailed++;
        knownIds.add(id);
        imported++;
        count(status);
      }
    });
    return {
      scanned,
      imported,
      remaining,
      folders: folders.map((f) => ({ ...f, imported: onWebsite.get(f.status) ?? 0 })),
      resumeUploadsFailed,
    };
  } finally {
    await browser.close();
  }
}

/** Thrown from a visit to end the walk early and cleanly. */
class PassStopped extends Error {}

/**
 * Read-only pass over every SEEK folder. For each card it asks `step` (see `createBackfillStep`) whether the profile still
 * needs reading. The page actions are: open the job and each status folder by address, read the filter labels, open one
 * candidate's detail panel by clicking the name, open its Profile tab, expand "More", open the Resumé tab and download the
 * file, close the panel, and click Next. It never clicks Move, the status controls, or the message controls, and it imports
 * nobody.
 *
 * Playwright errors can quote page text such as a candidate's name, so none is passed on: a failed page step becomes fixed
 * text plus the error name. A list that changed during the walk stops the pass with `stopped` false and an error.
 */
export async function backfillSeek(
  profilePath: string,
  jobId: string,
  step: (applicationId: string, read: () => Promise<BackfillRead>) => Promise<"read" | "skipped" | "failed" | "stop">,
) {
  const browser = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    // Ctrl-C must reach the script, which finishes the current candidate and prints the summary.
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  const fixed = (error: unknown) => `SEEK page step failed: ${error instanceof Error ? error.name : "UnknownError"}`;
  // Errors from the step (a paused-automation message, a database error) are not page errors and pass through unchanged.
  let inStep = false;
  const signedOut = () => !seekSignedIn(browser.pages()[0]?.url() ?? "");
  try {
    await walkSeek(browser, jobId, async ({ page, cards, index, id }) => {
      inStep = true;
      const outcome = await step(id, async () => {
        try {
          const { application, resumeFile, resumeFailed, resumeUnusable } = await readApplication(page, cards.nth(index), jobId, true);
          return {
            applicationId: application.applicationId,
            workRightsAnswer: application.workRightsAnswer,
            file: resumeFile,
            resumeFailed,
            resumeUnusable,
          };
        } catch (error) {
          if (!seekSignedIn(page.url())) throw new BackfillFatal(SEEK_SIGNED_OUT);
          throw new Error(fixed(error));
        }
      });
      inStep = false;
      if (outcome === "stop") throw new PassStopped();
    });
    return { stopped: false };
  } catch (error) {
    if (error instanceof PassStopped) return { stopped: true };
    if (inStep || error instanceof BackfillFatal) throw error;
    if (signedOut()) throw new BackfillFatal(SEEK_SIGNED_OUT);
    if (error instanceof SeekListChanged) throw new BackfillFatal("The list changed during the run. Run it again.");
    throw error instanceof SeekPageError ? error : new Error(fixed(error));
  } finally {
    await browser.close();
  }
}
