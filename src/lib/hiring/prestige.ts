import { type HiringConfig } from "./model";
import {
  THAI_PRIORITY_UNIVERSITIES,
  type UniversityRecord,
} from "./university-catalog";
export type UniversityEvidence = {
  name: string;
  evidence: string;
  completedDegree: boolean;
};
export type Prestige = {
  name: string | null;
  country: string | null;
  rank: number | null;
  edition: string | null;
  fraction: number;
  reason: string;
  sources: string[];
  catalogHash: string;
};
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** Bump when the match or the bands change, so the worker computes every stored result again. */
export const PRESTIGE_RULES = 2;
type CatalogRow = HiringConfig["universities"][number];
const REGION = new Intl.DisplayNames(["en"], { type: "region" });
/** U.S. News writes "University of Texas--Austin"; a résumé writes "The University of Texas at Austin". */
const loose = (value: string) => normalized(value).replace(/^the /, "").replace(/ at /g, " ");
/** U.S. News adds the country to some names ("University of Queensland Australia", "Northeastern University - China"). */
function looseKeys(u: CatalogRow) {
  const country = normalized(REGION.of(u.country) ?? "");
  return [u.name, ...u.aliases].flatMap((n) => {
    const key = loose(n);
    return country && key.endsWith(" " + country) ? [key, key.slice(0, -country.length - 1)] : [key];
  });
}
/**
 * The catalog rows for one institution's names. The first rule with a result decides:
 * 1. the exact name or alias;
 * 2. the same name in the other spelling (see `loose` and `looseKeys`);
 * 3. a college or faculty that states its named Thai university ("SIIT, Thammasat University").
 * More than one row is ambiguous and the caller gives no points.
 */
export function catalogMatches(names: string[], rows: CatalogRow[]): CatalogRow[] {
  const exact = new Set(names.map(normalized));
  const wanted = new Set(names.map(loose));
  const padded = names.map((n) => ` ${normalized(n)} `);
  const rules: ((u: CatalogRow) => boolean)[] = [
    (u) => [u.name, ...u.aliases].some((n) => exact.has(normalized(n))),
    (u) => looseKeys(u).some((k) => wanted.has(k)),
    (u) =>
      THAI_PRIORITY_UNIVERSITIES.includes(u.name.toLowerCase()) &&
      padded.some((n) => n.includes(` ${normalized(u.name)} `)),
  ];
  for (const rule of rules) {
    const found = rows.filter(rule);
    if (found.length) return found;
  }
  return [];
}
/**
 * The last resort: the names give only the university system before "--" ("Arizona State University").
 * No campus is named, so the lowest-ranked campus counts: no better rank is proven.
 */
export function systemMatch(names: string[], rows: CatalogRow[]): CatalogRow[] {
  const wanted = new Set(names.map(loose));
  return rows
    .filter((u) => u.name.includes("--") && wanted.has(loose(u.name.split("--")[0])))
    .sort((a, b) => (b.rank ?? Infinity) - (a.rank ?? Infinity))
    .slice(0, 1);
}
const countryCache = new Map<
  string,
  { country: string; source: string; names: string[] } | null
>();
export function prestigeFraction(
  university: Pick<UniversityRecord, "name" | "country" | "rank">,
) {
  if (THAI_PRIORITY_UNIVERSITIES.includes(university.name.toLowerCase()))
    return 0.6;
  const rank = university.rank;
  // The US/UK boost needs a rank in the top 1,000: a country alone proves nothing about the school.
  const countryBoost =
    rank !== null && rank <= 1000 && ["US", "GB"].includes(university.country) ? 0.4 : 0;
  const rankingBoost =
    rank === null
      ? 0
      : rank <= 10
        ? 0.6
        : rank <= 50
          ? 0.5
          : rank <= 100
            ? 0.4
            : rank <= 200
              ? 0.3
              : rank <= 500
                ? 0.2
                : rank <= 1000
                  ? 0.1
                  : 0;
  return Math.min(1, countryBoost + rankingBoost);
}
async function verifiedCountry(name: string, fetchImpl: typeof fetch) {
  const key = normalized(name);
  if (countryCache.has(key)) return countryCache.get(key)!;
  const response = await fetchImpl(
    "https://api.ror.org/v2/organizations?query=" + encodeURIComponent(name),
    { signal: AbortSignal.timeout(10000) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    items?: Array<{
      id?: string;
      names?: Array<{ value?: string; types?: string[] }>;
      locations?: Array<{ geonames_details?: { country_code?: string } }>;
    }>;
  };
  const exact = (body.items ?? []).filter((row) =>
    row.names?.some((n) => normalized(n.value ?? "") === key),
  );
  const result =
    exact.length === 1 &&
    exact[0].id?.startsWith("https://ror.org/") &&
    exact[0].locations?.length === 1
      ? {
          country: exact[0].locations[0].geonames_details?.country_code ?? "",
          source: exact[0].id,
          names: (exact[0].names ?? [])
            .filter((n) => !n.types?.includes("acronym"))
            .map((n) => normalized(n.value ?? "")),
        }
      : null;
  const valid = result && /^[A-Z]{2}$/.test(result.country) ? result : null;
  countryCache.set(key, valid);
  return valid;
}
export async function assessPrestige(
  evidence: UniversityEvidence[],
  config: HiringConfig,
  catalogHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Prestige> {
  let best: Prestige = {
    name: null,
    country: null,
    rank: null,
    edition: null,
    fraction: 0,
    reason: "No completed degree-awarding university was identified.",
    sources: [],
    catalogHash,
  };
  for (const school of evidence.filter((s) => s.completedDegree)) {
    let matches = catalogMatches([school.name], config.universities);
    // ROR settles the country when the name alone finds no row or more than one.
    const institution =
      matches.length === 1 ? null : await verifiedCountry(school.name, fetchImpl).catch(() => null);
    const names = [school.name, ...(institution?.names ?? [])];
    const rows = institution
      ? config.universities.filter((u) => u.country === institution.country)
      : config.universities;
    if (institution) matches = catalogMatches(names, rows);
    if (!matches.length) matches = systemMatch(names, rows);
    if (matches.length > 1) continue;
    const matched = matches[0];
    const country = matched
      ? { country: matched.country, source: matched.sourceUrl }
      : institution;
    if (!country) continue;
    const fraction = prestigeFraction({
      name: matched?.name ?? school.name,
      country: country.country,
      rank: matched?.rank ?? null,
    });
    if (best.name === null || fraction > best.fraction)
      best = {
        name: matched?.name ?? school.name,
        country: country.country,
        rank: matched?.rank ?? null,
        edition: matched?.rank ? matched.edition : null,
        fraction,
        reason: matched?.rank
          ? `U.S. News global rank ${matched.rank} (${matched.edition}); institution country ${country.country}.`
          : THAI_PRIORITY_UNIVERSITIES.includes(
                (matched?.name ?? "").toLowerCase(),
              )
            ? "Named Thai university boost. No U.S. News rank is assumed."
            : `Institution country ${country.country} verified. U.S. News rank is not yet verified.`,
        sources: [
          ...new Set([
            country.source,
            ...(institution ? [institution.source] : []),
            ...(matched?.rank ? [matched.sourceUrl] : []),
          ]),
        ],
        catalogHash,
      };
  }
  return best;
}
