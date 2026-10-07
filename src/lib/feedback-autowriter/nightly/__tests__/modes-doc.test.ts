import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_MODES } from "../modes";

const DOC = path.resolve(__dirname, "../../../../../docs/operations/feedback-autowriter-failure-modes.md");

function flat(text: string): string {
  return text.replace(/\s+/gu, " ");
}

describe("failure-mode registry doc", () => {
  const doc = fs.readFileSync(DOC, "utf8");

  it("has one section per mode in modes.ts, with its definition and invented example", () => {
    for (const mode of FAILURE_MODES) {
      expect(doc, mode.id).toContain(`## ${mode.id} ${mode.slug} — ${mode.title}`);
      expect(flat(doc), `${mode.id} definition`).toContain(flat(mode.definition));
      expect(flat(doc), `${mode.id} example`).toContain(flat(mode.example));
      expect(doc, `${mode.id} table row`).toMatch(new RegExp(`^\\| ${mode.id} \\| ${mode.slug} \\| ${mode.defaultSeverity}`, "mu"));
    }
    const headings = doc.match(/^## M\d{2} /gmu) ?? [];
    expect(headings).toHaveLength(FAILURE_MODES.length);
  });
});
