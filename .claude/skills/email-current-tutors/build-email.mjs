#!/usr/bin/env node
// Renders a BeGifted v3 company email from a JSON spec for the email-current-tutors skill.
// Usage: node build-email.mjs <spec.json> --out <dir>   → <dir>/email.html, email.txt, subject.txt
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCompanyEmail } from "./renderer/company.mjs";

const LOGO_URL = "https://bgscheduler.vercel.app/brand/email/v3/logo-horizontal.png";
const TEMPLATES = ["newsletter", "programme", "event"];
const KEYS = new Set([
  "template", "subject", "preheader", "title", "subtitle", "greeting", "paragraphs",
  "sections", "action", "eventDetails", "programmeDetails",
]);

function render(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("The spec must be a JSON object.");
  const unknown = Object.keys(spec).filter((key) => !KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown spec keys: ${unknown.join(", ")}`);
  if (!TEMPLATES.includes(spec.template)) throw new Error(`template must be one of: ${TEMPLATES.join(", ")}`);
  if (!Array.isArray(spec.paragraphs) || !spec.paragraphs.length
    || spec.paragraphs.some((paragraph) => typeof paragraph !== "string" || !paragraph.trim())) {
    throw new Error("paragraphs must be a non-empty list of text.");
  }
  // The renderer escapes every string, checks the logo and links, and supplies the standard BeGifted footer.
  return buildCompanyEmail({ ...spec, logoUrl: LOGO_URL });
}

const [specPath, flag, outDir] = process.argv.slice(2);
if (!specPath || flag !== "--out" || !outDir) {
  console.error("Usage: node build-email.mjs <spec.json> --out <dir>");
  process.exit(2);
}
try {
  const email = render(JSON.parse(readFileSync(specPath, "utf8")));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "email.html"), email.html);
  writeFileSync(path.join(outDir, "email.txt"), email.text);
  writeFileSync(path.join(outDir, "subject.txt"), email.subject);
  console.log(`Wrote email.html, email.txt and subject.txt to ${path.resolve(outDir)}`);
} catch (error) {
  console.error(`Could not build the email: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
