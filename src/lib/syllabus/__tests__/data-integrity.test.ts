import { describe, expect, it } from "vitest";

import topicsIndexJson from "../data/topics-index.json";
import year01 from "../data/year-01.json";
import year02 from "../data/year-02.json";
import year03 from "../data/year-03.json";
import year04 from "../data/year-04.json";
import year05 from "../data/year-05.json";
import year06 from "../data/year-06.json";
import year07 from "../data/year-07.json";
import year08 from "../data/year-08.json";
import year09 from "../data/year-09.json";
import year10 from "../data/year-10.json";
import year11 from "../data/year-11.json";
import year12 from "../data/year-12.json";
import year13 from "../data/year-13.json";

const years = [
  year01,
  year02,
  year03,
  year04,
  year05,
  year06,
  year07,
  year08,
  year09,
  year10,
  year11,
  year12,
  year13,
];

describe("syllabus data integrity", () => {
  it("contains the complete 13-year, 549-topic, 4,981-skill corpus", () => {
    expect(years.map(({ year }) => year)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );

    expect({
      years: years.length,
      topics: years.reduce((total, year) => total + year.topics.length, 0),
      skills: years.reduce(
        (total, year) =>
          total +
          year.topics.reduce(
            (yearTotal, topic) => yearTotal + topic.skills.length,
            0,
          ),
        0,
      ),
    }).toEqual({
      years: 13,
      topics: 549,
      skills: 4_981,
    });
  });

  it("keeps the topics index exactly aligned with every year file", () => {
    const derivedIndex = {
      years: years.map((year) => ({
        year: year.year,
        topicCount: year.topics.length,
        skillCount: year.topics.reduce(
          (total, topic) => total + topic.skills.length,
          0,
        ),
        topics: year.topics.map((topic) => ({
          code: topic.code,
          name: topic.name,
          skillCount: topic.skills.length,
        })),
      })),
    };

    expect(topicsIndexJson).toEqual(derivedIndex);
  });
});
