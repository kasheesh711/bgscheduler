import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyWeek } from "@/lib/hiring/week-hours";
import { WeekGrid } from "../week-grid";

describe("WeekGrid", () => {
  it("puts exactly one hour in the Tab order, so a keyboard user can reach the grid", () => {
    const html = renderToStaticMarkup(<WeekGrid value={emptyWeek()} onChange={() => {}} disabled={false} />);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Monday 08:00 to 09:00"');
    expect(html.match(/data-cell=/g)).toHaveLength(7 * 13);
  });
  it("names each hour, shows chosen hours as pressed, and reads them back with the two booking rules", () => {
    const week = emptyWeek();
    week[0] = [17, 18];
    week[5] = [9];
    const html = renderToStaticMarkup(<WeekGrid value={week} onChange={() => {}} disabled={false} />);
    expect(html).toMatch(/data-cell="0,17"[^>]*aria-pressed="true"/);
    expect(html).toContain("Mon 17–19 · Sat 09–10");
    expect(html).toContain("Weekend hour added");
    expect(html).toContain("Weekday hour at or after 15:00 added");
    expect(html).toContain("3 h");
    const none = renderToStaticMarkup(<WeekGrid value={emptyWeek()} onChange={() => {}} disabled={false} />);
    expect(none).toContain("Still needed: a weekend hour · a weekday hour at or after 15:00");
  });
});
