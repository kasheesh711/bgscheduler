// ── US Universities (IPEDS) constants ──────────────────────────────────
// Static code→label maps and load-time filters for the IPEDS 2024-25 slice.
// Keep label maps here (not a DB table) since IPEDS code sets are small and
// stable. CIP 2-digit families use the canonical NCES series names.

export const CURRENT_DATA_YEAR = "2024-25";

/** HD2024 CONTROL: control of institution. */
export const CONTROL_LABELS: Record<number, string> = {
  1: "Public",
  2: "Private nonprofit",
  3: "Private for-profit",
};

/** HD2024 ICLEVEL: level of institution. */
export const ICLEVEL_LABELS: Record<number, string> = {
  1: "Four or more years",
  2: "At least 2 but less than 4 years",
  3: "Less than 2 years",
};

/** HD2024 INSTSIZE: institution size category. */
export const INST_SIZE_LABELS: Record<number, string> = {
  1: "Under 1,000",
  2: "1,000 – 4,999",
  3: "5,000 – 9,999",
  4: "10,000 – 19,999",
  5: "20,000 and above",
};

/** HD2024 LOCALE: degree of urbanization (urban-centric locale). */
export const LOCALE_LABELS: Record<number, string> = {
  11: "City: Large",
  12: "City: Midsize",
  13: "City: Small",
  21: "Suburb: Large",
  22: "Suburb: Midsize",
  23: "Suburb: Small",
  31: "Town: Fringe",
  32: "Town: Distant",
  33: "Town: Remote",
  41: "Rural: Fringe",
  42: "Rural: Distant",
  43: "Rural: Remote",
};

/** C2024_A AWLEVEL: award level codes (degree-granting levels of interest). */
export const AWARD_LEVEL_LABELS: Record<number, string> = {
  3: "Associate's degree",
  5: "Bachelor's degree",
  7: "Master's degree",
  17: "Doctor's degree – research/scholarship",
  18: "Doctor's degree – professional practice",
  19: "Doctor's degree – other",
};

/** ADM2024 ADMCON1-12: admission consideration factor labels. */
export const ADM_CONSIDERATION_LABELS: Record<string, string> = {
  ADMCON1: "Secondary school GPA",
  ADMCON2: "Secondary school rank",
  ADMCON3: "Secondary school record",
  ADMCON4: "College-preparatory program",
  ADMCON5: "Recommendations",
  ADMCON6: "Demonstration of competencies",
  ADMCON7: "Admission test scores",
  ADMCON8: "English proficiency test",
  ADMCON9: "Other test",
  ADMCON10: "Work experience",
  ADMCON11: "Personal statement or essay",
  ADMCON12: "Legacy status",
};

/** ADM2024 ADMCON value codes → requirement level. */
export const ADM_CONSIDERATION_VALUE_LABELS: Record<number, string> = {
  1: "Required",
  2: "Recommended",
  3: "Not considered",
  5: "Considered but not required",
};

/** Canonical NCES CIP 2-digit family names. */
export const CIP2_FAMILIES: Record<string, string> = {
  "01": "Agriculture & Natural Resources",
  "03": "Natural Resources & Conservation",
  "04": "Architecture",
  "05": "Area, Ethnic & Gender Studies",
  "09": "Communication & Journalism",
  "10": "Communications Technologies",
  "11": "Computer & Information Sciences",
  "12": "Personal & Culinary Services",
  "13": "Education",
  "14": "Engineering",
  "15": "Engineering Technologies",
  "16": "Foreign Languages & Linguistics",
  "19": "Family & Consumer Sciences",
  "22": "Legal Professions & Studies",
  "23": "English Language & Literature",
  "24": "Liberal Arts & Humanities",
  "25": "Library Science",
  "26": "Biological & Biomedical Sciences",
  "27": "Mathematics & Statistics",
  "28": "Military Science",
  "29": "Military Technologies",
  "30": "Multi/Interdisciplinary Studies",
  "31": "Parks, Recreation & Fitness",
  "32": "Basic Skills",
  "33": "Citizenship Activities",
  "34": "Health-Related Knowledge & Skills",
  "35": "Interpersonal & Social Skills",
  "36": "Leisure & Recreational Activities",
  "37": "Personal Awareness & Self-Improvement",
  "38": "Philosophy & Religious Studies",
  "39": "Theology & Religious Vocations",
  "40": "Physical Sciences",
  "41": "Science Technologies",
  "42": "Psychology",
  "43": "Homeland Security & Law Enforcement",
  "44": "Public Administration & Social Service",
  "45": "Social Sciences",
  "46": "Construction Trades",
  "47": "Mechanic & Repair Technologies",
  "48": "Precision Production",
  "49": "Transportation & Materials Moving",
  "50": "Visual & Performing Arts",
  "51": "Health Professions",
  "52": "Business, Management & Marketing",
  "53": "High School/Secondary Diplomas",
  "54": "History",
  "60": "Health Professions Residency Programs",
  "61": "Medical Residency/Fellowship Programs",
};

/** Human label for a CIP 2-digit family, with a safe fallback. */
export function cip2Label(cip2: string): string {
  return CIP2_FAMILIES[cip2] ?? `CIP ${cip2}`;
}

/**
 * Load-time institution filter (D-IPEDS-4YR): include only active, Title IV,
 * 4-year, degree-granting institutions. Operates on an HD2024 row whose keys
 * have been upper-cased. Adjust here if the included set should change.
 */
export function isFourYearDegreeGranting(hd: Record<string, string>): boolean {
  const toInt = (v: string | undefined): number | null => {
    const t = (v ?? "").trim();
    return /^-?\d+$/.test(t) ? Number.parseInt(t, 10) : null;
  };
  return (
    toInt(hd.ICLEVEL) === 1 &&
    toInt(hd.DEGGRANT) === 1 &&
    toInt(hd.CYACTIVE) === 1 &&
    toInt(hd.PSET4FLG) === 1
  );
}

/** Completions kept for "known for": bachelor's-level conferred degrees. */
export const COMPLETIONS_AWARD_LEVEL = 5;

/** Allowed sort keys for the browse table (mapped to columns in query.ts). */
export const SORTABLE_COLUMN_KEYS = [
  "instName",
  "stateAbbr",
  "acceptanceRate",
  "enrollmentTotal",
  "gradRateBach6yr",
  "avgNetPrice",
  "totalPriceInState",
  "satReadingP75",
  "studentFacultyRatio",
] as const;

export type SortableColumnKey = (typeof SORTABLE_COLUMN_KEYS)[number];

export const DEFAULT_SORT: SortableColumnKey = "instName";
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_COMPARE = 4;
