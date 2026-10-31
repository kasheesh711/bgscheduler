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

const ID_CONTROL = 'input[id^="checkbox-"], button[id$="-move-to"]';

export function redactProfile(text: string, name: string) {
  return text
    .replaceAll(name, "[candidate]")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/(?:date of birth|nationality|marital status|religion|passport|gender|home address|salary|right to work)/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d ()-]{8,}\d)/g, "[phone]");
}
async function documentText(file: string) {
  const data = await readFile(file);
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

async function readApplication(
  page: Page,
  card: ReturnType<Page["getByTestId"]>,
  jobId: string,
): Promise<Application> {
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
  if (!status) throw new Error("SEEK candidate status could not be verified.");
  await card.getByText(name, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Candidate details" });
  await dialog.waitFor({ state: "visible" });
  let resumeText = "";
  try {
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
    const rights =
      full.match(/Preferred work rights in Thailand\s*\n([^\n]+)/i)?.[1] ?? "";
    const workRightsConfirmed =
      /permanent work rights with no restrictions/i.test(rights) ? true : null;
    const cleaned = (educationStart >= 0 ? full.slice(educationStart) : full)
      .replace(/Employment status[\s\S]*?(?=Application questions|$)/i, "")
      .replace(/Preferred work rights in Thailand\s*\n[^\n]*/i, "")
      .replace(/Expected monthly salary\s*\n[^\n]*/i, "");
    const resume = profile.getByRole("button", { name: "Resumé", exact: true });
    if (await resume.count()) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bgs-hiring-"));
      try {
        const downloadPromise = page.waitForEvent("download", {
          timeout: 20000,
        });
        await resume.click();
        const download = await downloadPromise;
        const file = path.join(dir, "resume");
        await download.saveAs(file);
        resumeText = redactProfile(await documentText(file), name);
      } catch {
        resumeText = "";
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const emailsTab = dialog.getByRole("tab", {
      name: /^Emails(?: \(\d+\))?$/,
    });
    if ((await emailsTab.count()) !== 1)
      throw new Error("SEEK email history could not be verified.");
    const emailsText = await emailsTab.innerText();
    const previouslyContacted =
      Number(emailsText.match(/\((\d+)\)/)?.[1] ?? 0) > 0;
    if (new URL(page.url()).searchParams.get("jobid") !== jobId)
      throw new Error("SEEK changed to another job during import.");
    return {
      applicationId: id,
      name,
      email,
      profileText: redactProfile(cleaned, name),
      resumeText,
      previouslyContacted,
      sourceStatus: status,
      workRightsConfirmed,
    };
  } finally {
    await dialog
      .getByRole("button", { name: "Close modal", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
  }
}

export async function importSeek(
  profilePath: string,
  jobId: string,
  knownIds: Set<string>,
  consume: (value: Application) => Promise<void>,
  observe: (id: string, status: string, contacted: boolean) => Promise<void>,
) {
  const browser = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  let scanned = 0,
    imported = 0,
    remaining = 0;
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(`https://th.employer.seek.com/candidates/?jobid=${jobId}`);
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
    await Promise.race([
      statusButtons.first().waitFor({ state: "visible" }),
      compactFilter.waitFor({ state: "visible" }),
      notice.waitFor({ state: "visible" }),
    ]);
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
          throw new Error(
            `SEEK ${status} page ${p + 1} has no visible applications.`,
          );
        if (seenPages.has(pageKey))
          throw new Error(
            `SEEK ${status} page ${p + 1} repeated the previous page.`,
          );
        if (ids.some((id) => allIds.has(id)))
          throw new Error(
            `SEEK ${status} page ${p + 1} repeated an application from an earlier page or folder.`,
          );
        seenPages.add(pageKey);
        folderScanned += ids.length;
        scanned += ids.length;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          allIds.add(id);
          if (knownIds.has(id)) {
            const contacted =
              (await cards
                .nth(i)
                .getByRole("button", { name: /^Emails? \([1-9]\d*\)$/ })
                .count()) > 0;
            await observe(id, status, contacted);
          } else if (["Inbox", "Prescreen", "Shortlist"].includes(status)) {
            if (imported >= 40) {
              remaining++;
              continue;
            }
            await consume(await readApplication(page, cards.nth(i), jobId));
            knownIds.add(id);
            imported++;
          }
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
        if (p === 199) throw new Error("SEEK page limit exceeded.");
      }
      if (folderScanned !== count)
        throw new Error(
          `SEEK ${status} count changed during import. Retry before sending messages.`,
        );
    }
    return { scanned, imported, remaining, folders };
  } finally {
    await browser.close();
  }
}
