import "server-only";

import { existsSync } from "node:fs";

const MAX_PDF_RESPONSE_BYTES = 4_400_000;

export function serverlessChromiumArgs(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--user-data-dir"));
}

function localChromePath(): string {
  const explicit = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error("No local Chrome executable found. Set CHROME_EXECUTABLE_PATH.");
  return resolved;
}

/** Render the exact standalone HTML snapshot into a portrait A4 PDF. */
export async function renderFootTrafficPdf(html: string): Promise<Buffer> {
  const { chromium: playwrightChromium } = await import("playwright-core");
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  let browser: Awaited<ReturnType<typeof playwrightChromium.launch>> | null = null;
  try {
    let executablePath: string;
    let args: string[] = [];
    if (serverless) {
      const { default: chromium } = await import("@sparticuz/chromium");
      chromium.setGraphicsMode = false;
      executablePath = await chromium.executablePath();
      args = serverlessChromiumArgs(chromium.args);
    } else {
      executablePath = localChromePath();
    }
    browser = await playwrightChromium.launch({ executablePath, args, headless: true });
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    const bytes = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      outline: true,
    }));
    if (bytes.byteLength > MAX_PDF_RESPONSE_BYTES) {
      throw new Error(`Generated PDF is ${bytes.byteLength} bytes, above the 4.4 MB response safety limit.`);
    }
    return bytes;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
