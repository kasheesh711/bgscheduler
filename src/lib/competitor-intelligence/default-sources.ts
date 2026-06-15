import type { CompetitorSourceType } from "./types";

export interface DefaultCompetitorSource {
  type: CompetitorSourceType;
  label: string;
  url: string;
  handle?: string;
  provider: string;
  priority: number;
  bestEffort?: boolean;
  reliability?: string;
}

export interface DefaultCompetitorEntity {
  slug: string;
  displayName: string;
  kind: "competitor" | "own_brand";
  websiteUrl?: string | null;
  marketPosition?: string | null;
  categoryTags: string[];
  sources: DefaultCompetitorSource[];
}

export const DEFAULT_COMPETITOR_ENTITIES: DefaultCompetitorEntity[] = [
  {
    slug: "begifted",
    displayName: "BeGifted",
    kind: "own_brand",
    marketPosition: "Own-brand baseline",
    categoryTags: ["baseline", "academic tutoring", "test prep"],
    sources: [
      {
        type: "serp",
        label: "BeGifted SERP baseline",
        url: "begifted:serp-baseline",
        provider: "dataforseo",
        priority: 100,
      },
    ],
  },
  {
    slug: "learn",
    displayName: "Learn",
    kind: "competitor",
    websiteUrl: "https://www.learn.co.th/en/",
    marketPosition: "Academic tutoring and test prep",
    categoryTags: ["academic tutoring", "test prep"],
    sources: [
      { type: "website", label: "Website", url: "https://www.learn.co.th/en/", provider: "internal", priority: 90 },
    ],
  },
  {
    slug: "edusmith",
    displayName: "EduSmith",
    kind: "competitor",
    marketPosition: "International school admissions and test prep",
    categoryTags: ["admissions consulting", "test prep"],
    sources: [
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/edusmiththailand/", handle: "edusmiththailand", provider: "apify", priority: 95, bestEffort: true },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/EduSmithTH", handle: "EduSmithTH", provider: "apify", priority: 85, bestEffort: true },
    ],
  },
  {
    slug: "ignite-by-ondemand",
    displayName: "Ignite by OnDemand",
    kind: "competitor",
    marketPosition: "SAT and admissions test prep",
    categoryTags: ["test prep", "admissions consulting"],
    sources: [
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/ignitebyondemand/", handle: "ignitebyondemand", provider: "apify", priority: 95, bestEffort: true },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/ignitebyondemand", handle: "ignitebyondemand", provider: "apify", priority: 85, bestEffort: true },
    ],
  },
  {
    slug: "nauticus-group",
    displayName: "Nauticus Group",
    kind: "competitor",
    websiteUrl: "https://nauticus.group",
    marketPosition: "Education group / admissions services",
    categoryTags: ["admissions consulting", "education group"],
    sources: [
      { type: "website", label: "Website", url: "https://nauticus.group", provider: "internal", priority: 80 },
    ],
  },
  {
    slug: "truenorth-education",
    displayName: "True North Education",
    kind: "competitor",
    marketPosition: "International school and admissions support",
    categoryTags: ["admissions consulting", "academic tutoring"],
    sources: [
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/truenorthedu.thailand", handle: "truenorthedu.thailand", provider: "apify", priority: 85, bestEffort: true },
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/truenorthedu.th/", handle: "truenorthedu.th", provider: "apify", priority: 85, bestEffort: true },
    ],
  },
  {
    slug: "britannia-th",
    displayName: "Britannia Thailand",
    kind: "competitor",
    marketPosition: "UK education and admissions pathway",
    categoryTags: ["admissions consulting", "UK education"],
    sources: [
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/britannia_th/", handle: "britannia_th", provider: "apify", priority: 75, bestEffort: true },
    ],
  },
  {
    slug: "crimson-education-thailand",
    displayName: "Crimson Education Thailand",
    kind: "competitor",
    websiteUrl: "https://www.crimsoneducation.org/th",
    marketPosition: "Global university admissions consulting",
    categoryTags: ["admissions consulting", "university admissions"],
    sources: [
      { type: "website", label: "Website", url: "https://www.crimsoneducation.org/th", provider: "internal", priority: 90 },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/crimson.thailand", handle: "crimson.thailand", provider: "apify", priority: 85, bestEffort: true },
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/crimsonthailand/", handle: "crimsonthailand", provider: "apify", priority: 85, bestEffort: true },
    ],
  },
  {
    slug: "house-of-griffin",
    displayName: "House of Griffin",
    kind: "competitor",
    websiteUrl: "https://www.houseofgriffin.com/courses/sat/",
    marketPosition: "SAT and academic test prep",
    categoryTags: ["test prep", "SAT"],
    sources: [
      { type: "website", label: "SAT course page", url: "https://www.houseofgriffin.com/courses/sat/", provider: "internal", priority: 90 },
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/houseofgriffin/", handle: "houseofgriffin", provider: "apify", priority: 85, bestEffort: true },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/thehouseofgriffin", handle: "thehouseofgriffin", provider: "apify", priority: 80, bestEffort: true },
    ],
  },
  {
    slug: "epa-academic-center",
    displayName: "EPA Academic Center",
    kind: "competitor",
    websiteUrl: "https://www.epa.ac.th",
    marketPosition: "Academic center and school support",
    categoryTags: ["academic tutoring", "test prep"],
    sources: [
      { type: "website", label: "Website", url: "https://www.epa.ac.th", provider: "internal", priority: 80 },
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/epa.academic.center/", handle: "epa.academic.center", provider: "apify", priority: 75, bestEffort: true },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/EPAschool", handle: "EPAschool", provider: "apify", priority: 75, bestEffort: true },
    ],
  },
  {
    slug: "krutoohomeschool",
    displayName: "KruToo Homeschool",
    kind: "competitor",
    marketPosition: "Homeschool and alternative education",
    categoryTags: ["homeschool", "alternative education"],
    sources: [
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/krutoohomeschool/", handle: "krutoohomeschool", provider: "apify", priority: 70, bestEffort: true },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/Krutoohomeschool", handle: "Krutoohomeschool", provider: "apify", priority: 70, bestEffort: true },
    ],
  },
  {
    slug: "prompt-school",
    displayName: "Prompt School",
    kind: "competitor",
    websiteUrl: "https://www.promptschool.com",
    marketPosition: "Test prep and academic tutoring",
    categoryTags: ["academic tutoring", "test prep"],
    sources: [
      { type: "website", label: "Website", url: "https://www.promptschool.com", provider: "internal", priority: 80 },
      { type: "facebook", label: "Facebook", url: "https://www.facebook.com/PromptSchool", handle: "PromptSchool", provider: "apify", priority: 75, bestEffort: true },
      { type: "instagram", label: "Instagram", url: "https://www.instagram.com/promptschool/", handle: "promptschool", provider: "apify", priority: 75, bestEffort: true },
    ],
  },
];

const KEYWORD_BASE = [
  { keyword: "SAT prep Bangkok", language: "en" },
  { keyword: "SAT tutoring Bangkok", language: "en" },
  { keyword: "AP tutor Bangkok", language: "en" },
  { keyword: "IB tutor Bangkok", language: "en" },
  { keyword: "university admissions consulting Thailand", language: "en" },
  { keyword: "international school tutoring Bangkok", language: "en" },
  { keyword: "เรียน SAT กรุงเทพ", language: "th" },
  { keyword: "ติว SAT กรุงเทพ", language: "th" },
  { keyword: "ติว IB กรุงเทพ", language: "th" },
  { keyword: "ที่ปรึกษาเรียนต่อต่างประเทศ", language: "th" },
] as const;

export const DEFAULT_SERP_KEYWORDS = KEYWORD_BASE.flatMap((entry) => [
  { ...entry, location: "Bangkok, Thailand", device: "mobile" },
  { ...entry, location: "Bangkok, Thailand", device: "desktop" },
]);
