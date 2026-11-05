// Self-check for build-email.mjs. Run: node --test .claude/skills/email-current-tutors/build-email.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./build-email.mjs", import.meta.url));
const BASE = {
  template: "newsletter",
  subject: "[BeGifted] Term dates",
  preheader: "Key dates for next term",
  title: "Next term at a glance",
  paragraphs: ["Classes resume on <b>3 Nov</b>."],
};

function run(spec, args) {
  const dir = mkdtempSync(path.join(tmpdir(), "email-current-tutors-test-"));
  const specPath = path.join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const out = path.join(dir, "out");
  const result = spawnSync(process.execPath, [SCRIPT, ...(args ?? [specPath, "--out", out])], { encoding: "utf8" });
  return { ...result, out };
}

test("renders the branded HTML, plain text and subject", () => {
  const result = run(BASE);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(path.join(result.out, "email.html"), "utf8");
  assert.match(html, /https:\/\/bgscheduler\.vercel\.app\/brand\/email\/v3\/logo-horizontal\.png/);
  assert.match(html, /Next term at a glance/);
  assert.match(html, /&lt;b&gt;3 Nov&lt;\/b&gt;/, "supplied text is escaped, never raw HTML");
  assert.match(readFileSync(path.join(result.out, "email.txt"), "utf8"), /Classes resume on <b>3 Nov<\/b>\./);
  assert.equal(readFileSync(path.join(result.out, "subject.txt"), "utf8"), "[BeGifted] Term dates");
});

test("renders an event with its details", () => {
  const result = run({ ...BASE, template: "event", eventDetails: [{ label: "Date", value: "Sat 8 Nov, 10:00" }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(result.out, "email.txt"), "utf8"), /Sat 8 Nov, 10:00/);
});

test("rejects specs the skill must not send", () => {
  const cases = [
    [{ ...BASE, photo: { url: "https://example.com/a.png" } }, /Unknown spec keys: photo/],
    [{ ...BASE, template: "receipt" }, /template must be one of: newsletter, programme, event/],
    [{ ...BASE, paragraphs: [] }, /paragraphs must be a non-empty list of text/],
    [{ ...BASE, preheader: "" }, /preheader is required/],
    [{ ...BASE, template: "event" }, /eventDetails is required/],
    [{ ...BASE, action: { label: "Go", url: "javascript:alert(1)" } }, /Email links must use HTTP or HTTPS/],
  ];
  for (const [spec, message] of cases) {
    const result = run(spec);
    assert.equal(result.status, 1, `expected a failure for ${JSON.stringify(spec)}`);
    assert.match(result.stderr, /^Could not build the email: /);
    assert.match(result.stderr, message);
  }
});

test("prints usage for bad arguments", () => {
  const result = run(BASE, ["only-one-arg.json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node build-email\.mjs <spec\.json> --out <dir>/);
});
