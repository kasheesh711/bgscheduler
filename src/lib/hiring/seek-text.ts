/** Text rules for SEEK profiles and pre-screen answers. This file has no I/O, so the import script and the worker can both use it. */

export function redactProfile(text: string, name: string) {
  return (name ? text.replaceAll("\0", "").replaceAll(name, "[candidate]") : text.replaceAll("\0", ""))
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

/** Headings of the SEEK profile page that the import script already knows. */
const PAGE_HEADINGS = [
  "career history",
  "employment status",
  "application questions",
  "expected monthly salary",
  "preferred work rights in thailand",
];
// \s* skips blank lines after the heading. The capture is the next line, which may be a heading when the answer is blank.
const RIGHTS = /Preferred work rights in Thailand\s*\n([^\n]*)/i;
const isHeading = (line: string) => PAGE_HEADINGS.includes(line.trim().toLowerCase());

/** The work-rights answer on a SEEK profile, or null when it is blank. The import schema allows 300 characters. */
export function readWorkRights(profile: string): string | null {
  const line = profile.match(RIGHTS)?.[1] ?? "";
  return isHeading(line) ? null : line.trim().slice(0, 300).trim() || null;
}

/** Remove the heading, any blank lines and the answer. A heading that follows a blank answer stays. */
export function removeWorkRights(profile: string): string {
  return profile.replace(RIGHTS, (_match, line: string) => (isHeading(line) ? line : ""));
}
