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
const countryCache = new Map<
  string,
  { country: string; source: string } | null
>();
export function prestigeFraction(
  university: Pick<UniversityRecord, "name" | "country" | "rank">,
) {
  if (THAI_PRIORITY_UNIVERSITIES.includes(university.name.toLowerCase()))
    return 0.6;
  const countryBoost = ["US", "GB"].includes(university.country) ? 0.4 : 0;
  const rank = university.rank;
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
      names?: Array<{ value?: string }>;
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
    const matches = config.universities.filter((u) =>
      [u.name, ...u.aliases].some(
        (n) => normalized(n) === normalized(school.name),
      ),
    );
    if (matches.length > 1) continue;
    const matched = matches[0];
    const country = matched
      ? { country: matched.country, source: matched.sourceUrl }
      : await verifiedCountry(school.name, fetchImpl).catch(() => null);
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
            ...(matched?.rank ? [matched.sourceUrl] : []),
          ]),
        ],
        catalogHash,
      };
  }
  return best;
}
