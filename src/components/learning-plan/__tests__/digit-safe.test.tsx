import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DigitSafe } from "@/components/learning-plan/digit-safe";
import { ReportOverview } from "@/components/learning-plan/report-overview";

describe("DigitSafe", () => {
  it("wraps every digit run without changing surrounding text", () => {
    const html = renderToStaticMarkup(
      <DigitSafe text="Student 11 · Numbers to 20" />,
    );

    expect(html).toContain('Student <span class="digits">11</span>');
    expect(html).toContain('Numbers to <span class="digits">20</span>');
  });

  it("protects digits in data-driven report headings", () => {
    const html = renderToStaticMarkup(
      <ReportOverview
        student="Mali 11"
        year={7}
        totalTopicsInYear={2}
        topics={[
          {
            code: "A",
            name: "Numbers to 20",
            skills: [{ code: "A.1", description: "Count accurately" }],
          },
        ]}
      />,
    );

    expect(html).toContain('What Mali <span class="digits">11</span>');
    expect(html).toContain('<span class="digits">7</span>');
  });
});
