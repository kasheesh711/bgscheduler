import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutoPairLanguage, PairLanguages as PairLanguagesPayload } from "@/lib/feedback-autowriter/pair-languages";
import { PairLanguages, PairLanguagesTable } from "../pair-languages";

function payload(overrides: Partial<PairLanguagesPayload> = {}): PairLanguagesPayload {
  return {
    overridesAvailable: true,
    lookbackDays: 90,
    englishMaxThaiShare: 0.03,
    thaiMinMedianShare: 0.3,
    pairs: [
      {
        wiseClassId: "6a0000000000000000000001", tutorKey: "Anna", className: "English Y5", lessons: 4, zoomLessons: 0,
        medianThaiShare: 0.01, maxThaiShare: 0.02, lastLessonAt: "2026-10-10T10:00:00.000Z", auto: "english", override: null, effective: "english",
      },
      {
        wiseClassId: "6a0000000000000000000002", tutorKey: "Bee", className: "Maths Y9", lessons: 3, zoomLessons: 0,
        medianThaiShare: 0.2, maxThaiShare: 0.45, lastLessonAt: "2026-10-09T10:00:00.000Z", auto: "bilingual", override: "thai", effective: "thai",
      },
      {
        wiseClassId: "6a0000000000000000000003", tutorKey: "Cee", className: "Science Y7", lessons: 0, zoomLessons: 2,
        medianThaiShare: null, maxThaiShare: null, lastLessonAt: "2026-10-08T10:00:00.000Z", auto: "unknown", override: null, effective: "unknown",
      },
      {
        wiseClassId: "6a0000000000000000000004", tutorKey: "Dee", className: null, lessons: 2, zoomLessons: 0,
        medianThaiShare: 0.05, maxThaiShare: 0.1, lastLessonAt: "2026-10-07T10:00:00.000Z", auto: "bilingual", override: null, effective: "bilingual",
      },
    ],
    ...overrides,
  };
}

function render(options: { data?: PairLanguagesPayload; canControl?: boolean; filter?: AutoPairLanguage | "all" } = {}): string {
  return renderToStaticMarkup(
    <PairLanguagesTable data={options.data ?? payload()} canControl={options.canControl ?? true} filter={options.filter ?? "all"}
      onFilter={() => undefined} busy={false} onOverride={() => undefined} />,
  );
}

describe("PairLanguages", () => {
  it("renders a closed section and fetches nothing before it is opened", () => {
    const html = renderToStaticMarkup(<PairLanguages canControl />);
    expect(html).toContain("Class languages");
    expect(html).toMatch(/<details/u);
    expect(html).not.toMatch(/<details[^>]*\sopen/u);
    expect(html).not.toContain("<table");
  });
});

describe("PairLanguagesTable", () => {
  it("shows one row per pair with lessons, Thai share and both labels", () => {
    const html = render();
    expect(html.match(/<tr/gu)).toHaveLength(5);
    for (const text of ["Anna", "English Y5", "Maths Y9", "1% / 2%", "20% / 45%", "— / —", "0<span class=\"text-muted-foreground\"> · 2 Zoom</span>", "6a0000000000000000000004", "owner"]) {
      expect(html).toContain(text);
    }
  });

  it("gives the owner an override select per row, and nobody else", () => {
    const owner = render();
    expect(owner.match(/<select/gu)).toHaveLength(4);
    expect(owner).toContain("Override");
    for (const option of [">Auto<", ">English<", ">Bilingual<", ">Thai<"]) expect(owner).toContain(option);
    const viewer = render({ canControl: false });
    expect(viewer).not.toContain("<select");
    expect(viewer).not.toContain("Override");
  });

  it("counts by effective label and filters on it", () => {
    const html = render();
    expect(html).toMatch(/All<span[^>]*>4<\/span>/u);
    expect(html).toMatch(/English<span[^>]*>1<\/span>/u);
    expect(html).toMatch(/Bilingual<span[^>]*>1<\/span>/u);
    expect(html).toMatch(/Thai<span[^>]*>1<\/span>/u);
    expect(html).toMatch(/Unknown<span[^>]*>1<\/span>/u);
    const thai = render({ filter: "thai" });
    expect(thai.match(/<tr/gu)).toHaveLength(2);
    expect(thai).toContain("Maths Y9");
    expect(thai).not.toContain("English Y5");
  });

  it("disables overrides with a notice before migration 0116", () => {
    const html = render({ data: payload({ overridesAvailable: false }) });
    expect(html).toContain("Overrides need migration 0116");
    expect(html.match(/<select[^>]*disabled/gu)).toHaveLength(4);
    expect(render({ data: payload({ overridesAvailable: false }), canControl: false })).not.toContain("migration 0116");
  });

  it("says so when there are no pairs", () => {
    expect(render({ data: payload({ pairs: [] }) })).toContain("No transcribed lessons in the last 90 days.");
  });
});
