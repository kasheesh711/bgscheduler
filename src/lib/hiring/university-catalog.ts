export const RANKING_EDITION = "2026-2027";
export const RANKING_SOURCE =
  "https://www.prnewswire.com/news-releases/us-news-unveils-2026-2027-best-global-universities-rankings-302800745.html";
export type UniversityRecord = {
  name: string;
  aliases: string[];
  country: string;
  rank: number | null;
  sourceUrl: string;
  edition: string;
};
// Overall global ranks from U.S. News' 16 June 2026 release, not subject or national ranks.
export const UNIVERSITY_CATALOG: UniversityRecord[] = [
  ["Harvard University", "US", 1, ["Harvard"]],
  ["Massachusetts Institute of Technology", "US", 2, ["MIT"]],
  ["Stanford University", "US", 3, ["Stanford"]],
  ["University of Oxford", "GB", 4, ["Oxford University"]],
  ["University of Cambridge", "GB", 5, ["Cambridge University"]],
  ["Tsinghua University", "CN", 6, []],
  [
    "University of California Berkeley",
    "US",
    7,
    ["University of California, Berkeley", "UC Berkeley"],
  ],
  ["Yale University", "US", 8, ["Yale"]],
  ["University College London", "GB", 9, ["UCL"]],
  ["Columbia University", "US", 10, []],
].map(([name, country, rank, aliases]) => ({
  name: name as string,
  country: country as string,
  rank: rank as number,
  aliases: aliases as string[],
  sourceUrl: RANKING_SOURCE,
  edition: RANKING_EDITION,
}));
export const THAI_PRIORITY_UNIVERSITIES = [
  "chulalongkorn university",
  "thammasat university",
  "mahidol university",
];
export const THAI_UNIVERSITIES: UniversityRecord[] = [
  {
    name: "Chulalongkorn University",
    aliases: ["Chula", "จุฬาลงกรณ์มหาวิทยาลัย"],
    country: "TH",
    rank: null,
    sourceUrl: "https://www.chula.ac.th/en/",
    edition: RANKING_EDITION,
  },
  {
    name: "Thammasat University",
    aliases: ["ธรรมศาสตร์", "มหาวิทยาลัยธรรมศาสตร์"],
    country: "TH",
    rank: null,
    sourceUrl: "https://tu.ac.th/en",
    edition: RANKING_EDITION,
  },
  {
    name: "Mahidol University",
    aliases: ["มหาวิทยาลัยมหิดล"],
    country: "TH",
    rank: null,
    sourceUrl: "https://mahidol.ac.th/",
    edition: RANKING_EDITION,
  },
];
