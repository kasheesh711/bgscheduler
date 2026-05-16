import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SearchForm } from "@/components/search/search-form";

describe("SearchForm", () => {
  it("renders natural language intake without replacing manual search controls", () => {
    const html = renderToStaticMarkup(
      <SearchForm
        filterOptions={{
          subjects: ["English"],
          curriculums: ["International"],
          levels: ["Year 5"],
        }}
        tutorList={[
          { tutorGroupId: "tutor-1", displayName: "Kevin", supportedModes: ["online"], subjects: ["English"] },
        ]}
        naturalLanguageEnabled={true}
        onSearchResponse={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(html).toContain("Natural language intake");
    expect(html).toContain("Parse");
    expect(html).toContain("Search");
    expect(html).toContain("Any subject");
  });
});
