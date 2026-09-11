import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const output = path.resolve("output/teacher-emails");
const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
await mkdir(path.join(output, "screenshots"), { recursive: true });
// Exercise the real React preview controls with the production build's CSS.
// Run npm run build first; the gallery itself has no build dependency.
const chunks = path.resolve(".next/static/chunks");
const cssFiles = (await readdir(chunks)).filter(name => name.endsWith(".css"));
assert.ok(cssFiles.length, "Run npm run build before checking the actual preview controls");
await writeFile(path.join(output, "preview-component.css"), (await Promise.all(cssFiles.map(name => readFile(path.join(chunks, name), "utf8")))).join("\n"));
await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {TeacherEmailPreview} from './src/components/class-assignments/teacher-email-preview';import {teacherEmailFixtures} from './src/lib/teacher-emails/fixtures';const fixture=teacherEmailFixtures(new URL('/assets/logo.png',location.href).href)[0];createRoot(document.getElementById('root')).render(<TeacherEmailPreview {...fixture.content}/>);`,
    loader: "tsx", resolveDir: process.cwd(),
  },
  bundle: true, jsx: "automatic", alias: { "@": path.resolve("src") },
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(output, "preview-component.js"),
});
await writeFile(path.join(output, "preview-component.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="preview-component.css"><title>Actual email preview controls</title></head><body><main id="root" style="max-width:800px;margin:auto;padding:16px"></main><script src="preview-component.js"></script></body></html>');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const file = path.resolve(output, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${output}${path.sep}`)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", ({ ".png": "image/png", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "text/plain; charset=utf-8");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const issues = [];
let layouts = 0;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  page.on("pageerror", error => issues.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  for (const fixture of manifest) {
    let expectedText;
    for (const width of [320, 375, 900]) {
      for (const colorScheme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(`${origin}/${fixture.id}.html`);
        const inspection = await page.evaluate(() => {
          const problems = [];
          if (document.documentElement.scrollWidth > innerWidth) problems.push("Document overflows horizontally");
          for (const element of document.querySelectorAll("h1,h2,p,li,td,a")) {
            if (element.scrollWidth > element.clientWidth + 1) problems.push(`Text overflows: ${element.textContent.slice(0, 60)}`);
          }
          for (const img of document.images) if (!img.complete || img.naturalWidth === 0) problems.push("Logo failed to load");
          for (const link of document.links) if (!/^https?:/.test(link.href)) problems.push(`Invalid action: ${link.href}`);
          return { problems, text: document.body.innerText };
        });
        assert.deepEqual(inspection.problems, [], `${fixture.id}, ${width}, ${colorScheme}`);
        expectedText ??= inspection.text;
        assert.equal(inspection.text, expectedText, "Responsive styling must not hide email content");
        layouts++;
        if (colorScheme === "light" && ((fixture.id === "schedule-mixed" && width === 375) || (fixture.id === "progress-summary" && width === 900) || (fixture.id === "feedback-deadline" && width === 375))) {
          await page.screenshot({ path: path.join(output, "screenshots", `${fixture.id}-${width}.png`), fullPage: true });
        }
        await page.addStyleTag({ content: "img{display:none!important}" });
        assert.equal(await page.locator("body").innerText(), expectedText, "All email information must survive hidden images");
      }
    }
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto(origin);
  await page.getByLabel("Message", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "375px", exact: true }).click();
  assert.equal(await page.locator("iframe").evaluate(el => el.getBoundingClientRect().width), 375);
  assert.equal(await page.frameLocator("iframe").getByRole("link", { name: "View school map" }).count(), 0);
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  assert.equal(await page.locator("pre").isVisible(), true);
  assert.match(await page.locator("pre").innerText(), /Remote \/ no room needed/);
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await page.getByRole("button", { name: "Images off", exact: true }).click();
  assert.equal(await page.frameLocator("iframe").getByAltText("BeGifted", { exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "Dark surround", exact: true }).click();
  assert.equal(await page.locator("body").getAttribute("class"), "dark");
  await page.getByLabel("Message", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "Images off", exact: true }).click();
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  await page.screenshot({ path: path.join(output, "screenshots/gallery.png"), fullPage: true });
  await page.goto(`${origin}/preview-component.html`);
  await page.getByRole("button", { name: "Phone width", exact: true }).click();
  assert.equal(await page.locator("iframe").evaluate(el => el.getBoundingClientRect().width), 375);
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
  await page.getByRole("button", { name: "Plain text", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("iframe").count(), 0);
  assert.match(await page.locator("pre").innerText(), /View school map:/);
  await page.getByRole("button", { name: "Email", exact: true }).click();
  assert.equal(await page.frameLocator("iframe").getByRole("heading", { name: "Teaching schedule", exact: true }).count(), 1);
  for (const width of [320, 375, 900]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await page.locator("html").evaluate((el, value) => el.classList.toggle("dark", value), dark);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole("button", { name: "Phone width", exact: true }).click();
    }
  }
  assert.deepEqual(issues, []);
  const report = { templates: manifest.length, layouts, widths: [320, 375, 900], themes: ["light", "dark"], imagesHidden: "All layouts retain content", galleryControls: "Passed", actualPreviewControls: "Passed, including keyboard activation, sandbox isolation and both app themes", nativeEmailClients: "Not tested; browser checks do not emulate Gmail, Outlook, or Apple Mail" };
  await writeFile(path.join(output, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
