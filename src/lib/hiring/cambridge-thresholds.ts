import configurations from "./cambridge-0500-written-configurations.json";
import writtenHistory from "./cambridge-0500-written-history.json";
import publishedRoutes from "./cambridge-igcse-thresholds.json";

export const writtenPairs: Record<string, Record<string, (number | null)[]>> = configurations;

const [variantTwo, ...otherRoutes] = publishedRoutes;
export const allWrittenYears = [...writtenHistory, ...variantTwo.years].map(row => {
  const pairs = Object.values(writtenPairs[row.year]);
  const marks = row.marks.map((_, grade) => {
    const eligible = pairs.flatMap(pair => pair[grade] === null ? [] : [pair[grade]]);
    return eligible.length ? eligible.reduce((sum, mark) => sum + mark, 0) / eligible.length : null;
  });
  return { ...row, components: "All written pairs", marks };
});

export const englishWrittenAverage = {
  code: variantTwo.code,
  subject: "First Language English · all two-paper configurations",
  years: allWrittenYears.filter(row => row.year >= variantTwo.years[0].year),
};

export const syllabuses = [
  englishWrittenAverage,
  { ...variantTwo, subject: "First Language English · written papers, variant 2" },
  ...otherRoutes,
];
