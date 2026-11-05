import { launchPdfBrowser } from "@/lib/onsite-foot-traffic/pdf";

export async function renderTheaPdf(token: string) {
  const base = process.env.APP_BASE_URL;
  if (!base || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("PDF address is not configured.");
  const url = new URL(`/weekend-schedule/${token}/print`, base);
  const browser = await launchPdfBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    // The capability must never travel to a third-party asset host.
    await page.route("**/*", route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
    const response = await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 180_000 });
    if (!response?.ok()) throw new Error("The weekend report is unavailable.");
    await page.waitForFunction(() => document.querySelectorAll('[data-thea-pdf-ready="true"]').length === 2
      || Boolean(document.querySelector('[data-thea-pdf-error]')), undefined, { timeout: 60_000 });
    if (await page.locator('[data-thea-pdf-error]').count()) throw new Error("The weekend report could not be verified.");
    await page.evaluate(() => document.fonts.ready);
    const pdf = Buffer.from(await page.pdf({ format: "A4", landscape: true, preferCSSPageSize: true, printBackground: true, tagged: true }));
    if (pdf.byteLength > 4_400_000) throw new Error("The weekend PDF exceeds the download limit.");
    return pdf;
  } finally { await browser.close().catch(() => undefined); }
}
