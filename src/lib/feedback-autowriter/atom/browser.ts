import "server-only";
import { existsSync } from "node:fs";
import { z } from "zod";
import { chromium as playwrightChromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { serverlessChromiumArgs } from "@/lib/onsite-foot-traffic/pdf";
import { AtomCollectionError, ATOM_SUBJECT_IDS, normalizeAtomTranscript, parseActivityIndex } from "./normalize";
import { withAtomTimeout } from "./deadline";
import type { AtomActivity } from "./types";

const APP = "https://app.atomlearning.com";
const API = "https://api.atomlearning.com";
const Student = z.object({ id_full_student: z.string().regex(/^_[0-9]+$/u), studentName: z.string(), surname: z.string().nullable().optional() });
export interface AtomCatalogStudent { id: string; name: string }
/** Browser shutdown can hang on serverless Chromium; it never holds a run open longer than this. */
const CLOSE_TIMEOUT_MS = 5_000;
const closeQuietly = (close: (() => Promise<void>) | undefined, stage: string) =>
  close ? withAtomTimeout(close(), CLOSE_TIMEOUT_MS, stage).catch(() => undefined) : Promise.resolve();
export interface AtomReadClient {
  catalog: AtomCatalogStudent[];
  collect(studentId: string, dates: string[]): Promise<AtomActivity[]>;
  close(): Promise<void>;
}

/** A fresh, private browser profile on every run. Passwords and tokens never leave memory. */
export async function openAtomReadClient(input: {
  username: string; password: string; deadlineMs: number;
}): Promise<AtomReadClient> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let stage = "launch";
  // Set when the open deadline passes; a browser that finishes launching afterwards is closed at once.
  let abandoned = false;
  const open = async (): Promise<AtomReadClient> => {
    let executablePath: string;
    let args: string[] = [];
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const { default: chromium } = await import("@sparticuz/chromium");
      chromium.setGraphicsMode = false;
      stage = "chromium_extract";
      executablePath = await withAtomTimeout(chromium.executablePath(), 60_000, "chromium_extract");
      stage = "launch";
      args = serverlessChromiumArgs(chromium.args);
    } else {
      const path = [process.env.CHROME_EXECUTABLE_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"]
        .find(candidate => candidate && existsSync(candidate));
      if (!path) throw new AtomCollectionError("collection_failed");
      executablePath = path;
    }
    const launched = await playwrightChromium.launch({ executablePath, args, headless: true, timeout: 30_000 });
    if (abandoned) {
      await closeQuietly(() => launched.close(), "browser_close");
      throw new AtomCollectionError("collection_failed", "open_deadline");
    }
    browser = launched;
    context = await browser.newContext({ serviceWorkers: "block" });
    // Only the normal sign-in form can POST. No assignments, edits, tracking POSTs or result mutations.
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      const read = ["GET", "HEAD", "OPTIONS"].includes(request.method());
      const login = request.method() === "POST" && url.origin === API && url.pathname === "/ms_accounts/auth/login";
      return read || login ? route.continue() : route.abort("blockedbyclient");
    });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const catalog = new Map<string, AtomCatalogStudent>();
    const responseJobs = new Set<Promise<void>>();
    page.on("response", response => {
      if (!/^\/ms_accounts\/users\/_?\d+$/u.test(new URL(response.url()).pathname) || new URL(response.url()).origin !== API || response.status() !== 200) return;
      const job = (async () => {
        const parsed = Student.safeParse(await response.json());
        if (parsed.success) catalog.set(parsed.data.id_full_student, {
          id: parsed.data.id_full_student, name: [parsed.data.studentName, parsed.data.surname].filter(Boolean).join(" "),
        });
      })().catch(() => undefined);
      responseJobs.add(job);
      void job.finally(() => responseJobs.delete(job));
    });
    stage = "sign_in_form";
    await page.goto(APP + "/public/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByPlaceholder("Enter your email", { exact: true }).fill(input.username);
    await page.getByPlaceholder("Enter your password", { exact: true }).fill(input.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    try { await page.waitForURL("**/tutor/**", { timeout: 45_000 }); }
    catch { throw new AtomCollectionError("authentication_failed"); }
    stage = "student_catalog";
    await page.goto(APP + "/tutor/students", { waitUntil: "domcontentloaded", timeout: 45_000 });
    stage = "catalog_count";
    // The count is split across nested elements; only return its number, never the page or account data.
    const count = await page.waitForFunction(() => document.body.innerText.match(/(\d+)\s+items\s*-\s*Sorted/u)?.[1], undefined, { timeout: 45_000 });
    const expected = Number(await count.jsonValue());
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 5000) throw new AtomCollectionError("response_changed");
    const readyBy = Math.min(input.deadlineMs - 10_000, Date.now() + 45_000);
    while (catalog.size < expected && Date.now() < readyBy) {
      // A response body that never completes must not hold the run past its deadline.
      await withAtomTimeout(Promise.allSettled([...responseJobs]), readyBy - Date.now(), "catalog_responses").catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Atom uses its HttpOnly atom-auth session cookie. BrowserContext.request shares that cookie jar.
    const signedIn = (await context.cookies(API)).some(cookie => cookie.name === "atom-auth");
    if (catalog.size !== expected || !signedIn) throw new AtomCollectionError("response_changed", "catalog_or_session_incomplete");
    const ownedContext = context;
    const ownedBrowser = browser;
    // All direct reads use paths observed on Atom's completed-work pages, and only this account's catalog IDs.
    const get = async (path: string): Promise<unknown> => {
      const timeout = Math.min(30_000, input.deadlineMs - Date.now() - 5_000);
      if (timeout <= 0) throw new AtomCollectionError("collection_failed");
      const response = await ownedContext.request.get(API + path, {
        timeout, maxRedirects: 0,
      });
      if ([401, 403].includes(response.status())) throw new AtomCollectionError("authentication_failed");
      if (!response.ok()) throw new AtomCollectionError("collection_failed");
      const text = await response.text();
      if (text.length > 20_000_000) throw new AtomCollectionError("response_changed");
      try { return JSON.parse(text); } catch { throw new AtomCollectionError("response_changed"); }
    };
    return {
      catalog: [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name)),
      collect: async (studentId, dates) => {
        if (!catalog.has(studentId)) throw new AtomCollectionError("source_contradiction");
        const wanted = new Set(dates);
        const references = new Map<string, ReturnType<typeof parseActivityIndex>[number]>();
        const prefix = "/ms_mocks/students/" + encodeURIComponent(studentId);
        const practices = parseActivityIndex("practice", await get(prefix + "/custom_practices"), studentId, wanted);
        practices.forEach(ref => references.set(ref.id, ref));
        for (const subjectId of Object.keys(ATOM_SUBJECT_IDS)) {
          const tests = parseActivityIndex("test", await get(prefix + "/mock_tests?type=HOME_MOCK%2CSCHOOL_MOCK&id_course_subjects=" + subjectId), studentId, wanted);
          tests.forEach(ref => references.set(ref.id, ref));
          const islands = parseActivityIndex("exam_topic", await get("/ms_learning/students/" + encodeURIComponent(studentId) + "/islands?id_course_subjects=" + subjectId + "&status=completed"), studentId, wanted);
          islands.forEach(ref => references.set(ref.id, ref));
        }
        if (references.size > 300) throw new AtomCollectionError("collection_failed");
        const activities: AtomActivity[] = [];
        for (const ref of references.values()) {
          const raw = await get("/ms_mocks/transcripts/" + encodeURIComponent(ref.id));
          activities.push(normalizeAtomTranscript(raw, ref));
        }
        return activities.sort((a, b) => a.id.localeCompare(b.id));
      },
      close: async () => {
        await closeQuietly(() => ownedContext.close(), "context_close");
        await closeQuietly(() => ownedBrowser.close(), "browser_close");
      },
    };
  };
  try {
    // Several Playwright calls have no timeout of their own. Closing the browser on the deadline also fails them.
    return await withAtomTimeout(open(), input.deadlineMs - Date.now() - 5_000, "open_deadline");
  } catch (error) {
    abandoned = true;
    await closeQuietly(context ? () => context!.close() : undefined, "context_close");
    await closeQuietly(browser ? () => browser!.close() : undefined, "browser_close");
    if (error instanceof AtomCollectionError && error.stage === "open_deadline") {
      throw new AtomCollectionError("collection_failed", `${stage}_timeout`);
    }
    if (error instanceof AtomCollectionError) throw error;
    // Playwright errors can include typed values. Never propagate their text or stack.
    throw new AtomCollectionError("collection_failed", stage);
  }
}
