import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { closeSeekCheckIn } from "../../../../scripts/hiring-seek";

// A copy of SEEK's survey: a modal over the list that hides the list from role queries, with an X that removes it.
// An answer or a Submit must never happen.
const survey = (closeLabel = "Close") => `<div role="dialog" aria-modal="true" aria-labelledby="checkin" style="position:fixed;inset:0;background:#fff">
  <form onsubmit="window.answered = true; return false">
    <h2 id="checkin">Hiring check-in</h2>
    <p>Were you able to fill this role using SEEK?</p>
    <label><input type="radio" name="filled" onchange="window.answered = true">Still reviewing applications</label>
    <button type="submit">Submit</button>
    <button type="button" aria-label="${closeLabel}"
      onclick="this.closest('[role=dialog]').remove(); document.querySelector('main').removeAttribute('aria-hidden')">×</button>
  </form>
</div>`;

let browser: Browser | null = null;
beforeAll(async () => {
  // shortcut: needs Google Chrome, like the worker; the tests are skipped on a machine without it.
  browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => null);
}, 30000);
afterAll(async () => {
  await browser?.close();
}, 30000);

async function seekPage(list = "") {
  const page = await browser!.newPage();
  await page.setContent(`<main>${list}</main>`);
  await closeSeekCheckIn(page);
  return page;
}
const showSurvey = (page: Page, closeLabel?: string) =>
  page.evaluate((html) => {
    document.querySelector("main")!.setAttribute("aria-hidden", "true");
    document.body.insertAdjacentHTML("beforeend", html);
  }, survey(closeLabel));
const showList = (page: Page) =>
  page.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", "<button>Inbox 2 applications</button>"));
const flag = (page: Page, name: "answered" | "opened") =>
  page.evaluate((key) => (window as unknown as Record<string, unknown>)[key], name);

describe("closeSeekCheckIn", () => {
  it("closes the survey with its X while the worker waits for the list, and sends no answer", { timeout: 20000 }, async ({ skip }) => {
    if (!browser) skip();
    const page = await seekPage();
    // The same kind of wait as walkSeek's first one: one locator, not a race of waits.
    const listShown = page.getByRole("button", { name: /applications$/ }).filter({ visible: true }).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    await showSurvey(page);
    await page.waitForTimeout(1000);
    await showList(page);
    // Without the close, the survey keeps the list hidden and this times out.
    await listShown;
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await flag(page, "answered")).toBeUndefined();
  });

  it("closes a survey that SEEK shows later, before the next click", { timeout: 20000 }, async ({ skip }) => {
    if (!browser) skip();
    const page = await seekPage(`<button onclick="window.opened = true">Inbox 2 applications</button>`);
    await showSurvey(page);
    await page.getByRole("button", { name: "Inbox 2 applications" }).click({ timeout: 5000 });
    expect(await flag(page, "opened")).toBe(true);
    expect(await flag(page, "answered")).toBeUndefined();
    expect(await page.getByRole("dialog").count()).toBe(0);
  });

  it("fails only the step, not the worker process, when the X cannot be found", { timeout: 30000 }, async ({ skip }) => {
    if (!browser) skip();
    const crashes: unknown[] = [];
    const onCrash = (reason: unknown) => crashes.push(reason);
    process.on("unhandledRejection", onCrash);
    try {
      const page = await seekPage(`<button>Inbox 2 applications</button>`);
      await showSurvey(page, "Dismiss");
      await expect(page.getByRole("button", { name: "Inbox 2 applications" }).click({ timeout: 8000 })).rejects.toThrow(/Timeout/);
      expect(await flag(page, "answered")).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onCrash);
    }
    expect(crashes).toEqual([]);
  });
});
