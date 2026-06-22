"use client";

// ── US Universities — Console KPI hero ─────────────────────────────────
// Four at-a-glance tiles for the active IPEDS slice. Every value is an
// Overview scalar (no derived metrics): total institutions, the count with a
// published acceptance rate, the average acceptance rate, and a public vs.
// private headcount split summed from controls[]. Numeric nulls render the
// EM_DASH, never 0, per the fail-closed rule.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EM_DASH, formatInt, formatPct } from "@/lib/us-universities/format";
import type { ControlFacet, UsUniversitiesOverview } from "@/lib/us-universities/types";

/**
 * Headcount split by control: control 1 is public; controls 2 (private
 * nonprofit) and 3 (private for-profit) are folded into private. Unknown
 * codes are ignored so a malformed facet never inflates either total.
 */
export function publicPrivateSplit(controls: ControlFacet[]): { public: number; private: number } {
  let pub = 0;
  let priv = 0;
  for (const facet of controls) {
    if (facet.control === 1) pub += facet.count;
    else if (facet.control === 2 || facet.control === 3) priv += facet.count;
  }
  return { public: pub, private: priv };
}

interface KpiTile {
  label: string;
  value: string;
  hint: string;
}

export function KpiHero({ overview }: { overview: UsUniversitiesOverview }) {
  const split = publicPrivateSplit(overview.controls);
  const splitValue =
    split.public === 0 && split.private === 0
      ? EM_DASH
      : `${split.public.toLocaleString()} / ${split.private.toLocaleString()}`;

  const tiles: KpiTile[] = [
    {
      label: "Total universities",
      value: formatInt(overview.totalInstitutions),
      hint: `IPEDS ${overview.dataYear}`,
    },
    {
      label: "With acceptance rate",
      value: formatInt(overview.withAcceptanceRate),
      hint: "Published admit rate",
    },
    {
      label: "Avg. acceptance rate",
      value: formatPct(overview.avgAcceptanceRate != null ? Math.round(overview.avgAcceptanceRate) : null),
      hint: "Across reporting schools",
    },
    {
      label: "Public / private",
      value: splitValue,
      hint: "Headcount by control",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardHeader className="pb-2">
            <CardDescription>{tile.label}</CardDescription>
            <CardTitle className="text-3xl font-semibold tabular-nums">{tile.value}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">{tile.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
