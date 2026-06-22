"use client";

// ----------------------------------------------------------------------------
// Institution dossier — the full-page replacement for the old profile modal.
// Cover band (identity + conditional badge rail), oversized headline stats, an
// external action row, then six sections migrated from institution-profile.tsx
// plus an admissions-trend section (suppressed when empty). Fail-closed
// throughout: a missing numeric metric renders EM_DASH (never 0), and a section
// whose every field is absent is suppressed (hasAnyValue). The URL helpers
// (normalizeUrl/dossierExternalLinks) are pure + tested.
//
// Shortlist (compare set) is URL-driven: `?compare=` is the source of truth.
// The component reads `useSearchParams()` for live client-side updates and falls
// back to the SSR-seed `compareIds` prop for static rendering. Mutations call
// `router.replace()` preserving all other params.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import type { ChartConfiguration } from "chart.js";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import {
  CONTROL_LABELS,
  INST_SIZE_LABELS,
  LOCALE_LABELS,
  MAX_COMPARE,
  carnegieLabel,
} from "@/lib/us-universities/constants";
import {
  EM_DASH,
  admissionRequirements,
  awardLevelText,
  formatPct,
  formatRatio,
  formatUsd,
  rangeText,
} from "@/lib/us-universities/format";
import { hasAnyValue } from "@/lib/us-universities/dossier-sections";
import { buildAdmissionsTrendChartData } from "@/lib/us-universities/trend-charts";
import { addCompareId, removeCompareId } from "@/lib/us-universities/compare-set";
import type { InstitutionProfile, IpedsInstitutionSummary } from "@/lib/us-universities/types";
import { PriceLadder } from "./price-ladder";
import { DemographicsStackedBar } from "./demographics-stacked-bar";
import {
  DossierSectionNav,
  resolveActiveSection,
  type DossierSection,
} from "./dossier-section-nav";
import { ShortlistBar, resolveShortlistEntries } from "./shortlist-bar";
import { CompareSheet } from "./compare-sheet";

const MAX_COMPLETION_ROWS = 25;

// ── Pure URL helpers (exported for tests) ──────────────────────────────

/** Normalize an IPEDS url: prefix a bare host with https://, blank → null. */
export function normalizeUrl(url: string | null | undefined): string | null {
  const t = (url ?? "").trim();
  if (t === "") return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export interface DossierLink {
  key: string;
  label: string;
  href: string;
}

/** Present external links in canonical order: website, admissions, net-price calc. */
export function dossierExternalLinks(
  p: Pick<InstitutionProfile, "website" | "admissionsUrl" | "netPriceCalcUrl">,
): DossierLink[] {
  const out: DossierLink[] = [];
  const website = normalizeUrl(p.website);
  if (website) out.push({ key: "website", label: "Website", href: website });
  const admissions = normalizeUrl(p.admissionsUrl);
  if (admissions) out.push({ key: "admissions", label: "Admissions", href: admissions });
  const netPrice = normalizeUrl(p.netPriceCalcUrl);
  if (netPrice) {
    out.push({ key: "netPriceCalc", label: "Net price calculator", href: netPrice });
  }
  return out;
}

// ── Presentational atoms ───────────────────────────────────────────────

function Metric({ label, value }: { label: string; value: string }) {
  const missing = value === EM_DASH;
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-sm tabular-nums",
          missing ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">{children}</dl>;
}

function HeadlineStat({ label, value }: { label: string; value: string }) {
  const missing = value === EM_DASH;
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-3xl font-semibold tabular-nums",
          missing ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DossierSectionBlock({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

// ── Component ──────────────────────────────────────────────────────────

export interface InstitutionDossierProps {
  profile: InstitutionProfile;
  backHref: string;
  compareIds: number[];
}

/** Parse a comma-list of positive ints, capped at MAX_COMPARE (mirrors shell + page logic). */
function parseIds(value: string | null): number[] {
  return (value ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_COMPARE);
}

export function InstitutionDossier({
  profile,
  backHref,
  compareIds: compareIdsProp,
}: InstitutionDossierProps): React.JSX.Element {
  const router = useRouter();
  // SSR-safe: useSearchParams() returns null under renderToStaticMarkup (no router provider).
  const searchParams = useSearchParams();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Live client-side compare set: read from the URL when a router provider exists,
  // fall back to the SSR-seed prop. Side-effects (router.replace) are kept outside
  // state updaters — only synchronous set operations happen inside setState callbacks.
  const liveCompareIds: number[] = searchParams
    ? parseIds(searchParams.get("compare"))
    : compareIdsProp;

  const requirements = admissionRequirements(profile.admConsiderations);
  const completions = [...profile.completions]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, MAX_COMPLETION_ROWS);
  const links = dossierExternalLinks(profile);
  const inCompare = liveCompareIds.includes(profile.unitId);
  const compareFull = liveCompareIds.length >= MAX_COMPARE;

  // ── URL-driven shortlist mutations ────────────────────────────────────

  /** Write `nextIds` into the current URL, preserving all other params. */
  const syncCompareUrl = useCallback(
    (nextIds: number[]) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (nextIds.length > 0) params.set("compare", nextIds.join(","));
      else params.delete("compare");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  const addCompare = useCallback(
    (unitId: number) => {
      const next = addCompareId(liveCompareIds, unitId);
      if (next !== liveCompareIds) syncCompareUrl(next);
    },
    [liveCompareIds, syncCompareUrl],
  );

  const removeCompare = useCallback(
    (unitId: number) => {
      syncCompareUrl(removeCompareId(liveCompareIds, unitId));
    },
    [liveCompareIds, syncCompareUrl],
  );

  const clearCompare = useCallback(() => {
    syncCompareUrl([]);
  }, [syncCompareUrl]);

  // Build a single-row source so the current school shows its real name in the
  // dock; ids without a matching row fall back to `Institution #<id>` inside
  // resolveShortlistEntries (mirrors Console behaviour).
  const profileRow: IpedsInstitutionSummary = profile as IpedsInstitutionSummary;

  // Trend chart config — built client-side so chartColors() can read CSS vars.
  const admissionsTrend = profile.admissionsTrend;
  const trendChartConfig = useMemo<ChartConfiguration<"line">>(() => {
    const colors = chartColors();
    const data = buildAdmissionsTrendChartData(admissionsTrend);
    data.datasets.forEach((dataset, index) => {
      const color = colors.chart[index % colors.chart.length];
      dataset.borderColor = color;
      dataset.backgroundColor = color;
      dataset.pointBackgroundColor = color;
      dataset.tension = 0.3;
    });
    return {
      type: "line",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: colors.mutedForeground } } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { color: colors.mutedForeground },
            grid: { color: colors.border },
          },
          x: {
            ticks: { color: colors.mutedForeground },
            grid: { display: false },
          },
        },
      },
    };
  }, [admissionsTrend]);

  // Section presence — fail-closed suppression of all-absent sections.
  const showAdmissions = hasAnyValue([
    profile.acceptanceRate, profile.yieldRate, profile.satSubmitPct,
    profile.satReadingP25, profile.satReadingP75, profile.satMathP25, profile.satMathP75,
    profile.actSubmitPct, profile.actCompositeP25, profile.actCompositeP75,
    ...(requirements.length > 0 ? [1] : []),
  ]);
  const showTrend = admissionsTrend.length > 0;
  const showCost = hasAnyValue([
    profile.tuitionInState, profile.tuitionOutState, profile.totalPriceInState,
    profile.roomBoardAmt, profile.avgNetPrice, profile.appFeeUg,
  ]);
  const showOutcomes = hasAnyValue([
    profile.gradRateBach6yr, profile.gradRateTotal, profile.retentionFt,
    profile.transferOutRate, profile.studentFacultyRatio, profile.omAward8yr,
    profile.omStillEnrolled8yr,
  ]);
  const showStudentBody = hasAnyValue([
    profile.pctWomen, profile.pctInState, profile.pctOutOfState, profile.pctWhite,
    profile.pctBlack, profile.pctHispanic, profile.pctAsianPacIsl, profile.pctAmInd,
    profile.pctTwoOrMore, profile.pctNonresident, profile.pctUnknown,
  ]);
  const showAcademics = profile.topMajors.length > 0 || completions.length > 0;
  const showLocation = hasAnyValue([profile.city, profile.stateAbbr, profile.locale]);

  const sections: DossierSection[] = [
    showAdmissions && { id: "admissions", label: "Admissions" },
    showTrend && { id: "admissions-trend", label: "Admissions over time" },
    showCost && { id: "cost", label: "Cost" },
    showOutcomes && { id: "outcomes", label: "Outcomes" },
    showStudentBody && { id: "student-body", label: "Student body" },
    showAcademics && { id: "academics", label: "Academics" },
    showLocation && { id: "location", label: "Location" },
  ].filter((s): s is DossierSection => Boolean(s));

  // Scroll-spy: observe section visibility, resolve the active anchor. Effect
  // does not run under SSR; the resolver itself is unit-tested directly.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setActiveId(resolveActiveSection(sections, [...visible]));
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    for (const section of sections) {
      const el = root.querySelector(`#${section.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // sections is derived from profile; re-run when the profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.unitId]);

  const location = [profile.city, profile.stateAbbr].filter(Boolean).join(", ");


  return (
    <div ref={containerRef} className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to results
      </Link>

      {/* Cover band */}
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {profile.instName}
          </h1>
          {profile.alias ? (
            <p className="text-sm text-muted-foreground">{profile.alias}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{location || EM_DASH}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {profile.control != null && CONTROL_LABELS[profile.control] ? (
            <Badge variant="secondary">{CONTROL_LABELS[profile.control]}</Badge>
          ) : null}
          {profile.instSize != null && INST_SIZE_LABELS[profile.instSize] ? (
            <Badge variant="outline">{INST_SIZE_LABELS[profile.instSize]}</Badge>
          ) : null}
          {profile.locale != null && LOCALE_LABELS[profile.locale] ? (
            <Badge variant="outline">{LOCALE_LABELS[profile.locale]}</Badge>
          ) : null}
          {carnegieLabel(profile.carnegieBasic) ? (
            <Badge variant="outline">{carnegieLabel(profile.carnegieBasic)}</Badge>
          ) : null}
          {profile.hbcu ? <Badge variant="outline">HBCU</Badge> : null}
          {profile.landGrant ? <Badge variant="outline">Land-grant</Badge> : null}
        </div>

        {/* Oversized headline stats */}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <HeadlineStat label="Acceptance" value={formatPct(profile.acceptanceRate)} />
          <HeadlineStat label="Grad rate 6yr" value={formatPct(profile.gradRateBach6yr)} />
          <HeadlineStat
            label="Net price"
            value={formatUsd(profile.avgNetPrice ?? profile.totalPriceInState)}
          />
          <HeadlineStat
            label="Student:faculty"
            value={formatRatio(profile.studentFacultyRatio)}
          />
        </dl>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          {links.map((link) => (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-primary hover:bg-muted"
            >
              {link.label}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          ))}
          <Button
            size="sm"
            disabled={inCompare || compareFull}
            onClick={() => addCompare(profile.unitId)}
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            {inCompare ? "In shortlist" : "Add to shortlist"}
          </Button>
        </div>
      </header>

      <Separator />

      <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
        <div className="hidden md:block">
          <div className="sticky top-20">
            <DossierSectionNav sections={sections} activeId={activeId} />
          </div>
        </div>

        <div className="min-w-0 space-y-8">
          {showAdmissions ? (
            <DossierSectionBlock id="admissions" title="Admissions">
              <MetricGrid>
                <Metric label="Acceptance rate" value={formatPct(profile.acceptanceRate)} />
                <Metric label="Yield rate" value={formatPct(profile.yieldRate)} />
                <Metric label="SAT submit" value={formatPct(profile.satSubmitPct)} />
                <Metric
                  label="SAT reading (25–75)"
                  value={rangeText(profile.satReadingP25, profile.satReadingP75)}
                />
                <Metric
                  label="SAT math (25–75)"
                  value={rangeText(profile.satMathP25, profile.satMathP75)}
                />
                <Metric label="ACT submit" value={formatPct(profile.actSubmitPct)} />
                <Metric
                  label="ACT composite (25–75)"
                  value={rangeText(profile.actCompositeP25, profile.actCompositeP75)}
                />
              </MetricGrid>
              <div className="space-y-1 pt-1">
                <p className="text-xs text-muted-foreground">Admission requirements</p>
                {requirements.length > 0 ? (
                  <ul className="space-y-1">
                    {requirements.map((req) => (
                      <li key={req.key} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-foreground">{req.label}</span>
                        <span className="text-muted-foreground">{req.level}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{EM_DASH}</p>
                )}
              </div>
            </DossierSectionBlock>
          ) : null}

          {showTrend ? (
            <DossierSectionBlock id="admissions-trend" title="Admissions over time">
              <div className="h-56">
                <ChartCanvas
                  config={trendChartConfig}
                  ariaLabel="Acceptance and yield rate by year"
                  active
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-3 font-medium">Year</th>
                      <th className="py-1.5 pr-3 font-medium">Acceptance %</th>
                      <th className="py-1.5 pr-3 font-medium">SAT reading (p25–p75)</th>
                      <th className="py-1.5 pr-3 font-medium">SAT math (p25–p75)</th>
                      <th className="py-1.5 pr-3 font-medium">ACT (p25–p75)</th>
                      <th className="py-1.5 pr-3 font-medium">Applicants</th>
                      <th className="py-1.5 pr-3 font-medium">Admits</th>
                      <th className="py-1.5 font-medium">Enrolled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border tabular-nums">
                    {admissionsTrend.map((point) => (
                      <tr key={point.dataYear}>
                        <td className="py-1.5 pr-3 text-foreground">{point.dataYear}</td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {formatPct(point.acceptanceRate)}
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {rangeText(point.satReadingP25, point.satReadingP75)}
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {rangeText(point.satMathP25, point.satMathP75)}
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {rangeText(point.actCompositeP25, point.actCompositeP75)}
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {point.applicantsTotal == null
                            ? EM_DASH
                            : point.applicantsTotal.toLocaleString("en-US")}
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {point.admitsTotal == null
                            ? EM_DASH
                            : point.admitsTotal.toLocaleString("en-US")}
                        </td>
                        <td className="py-1.5 text-foreground">
                          {point.enrolledTotal == null
                            ? EM_DASH
                            : point.enrolledTotal.toLocaleString("en-US")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DossierSectionBlock>
          ) : null}

          {showCost ? (
            <DossierSectionBlock id="cost" title="Cost">
              <PriceLadder
                items={[
                  { label: "Tuition (in-state)", value: profile.tuitionInState },
                  { label: "Tuition (out-of-state)", value: profile.tuitionOutState },
                  { label: "Total price (in-state)", value: profile.totalPriceInState },
                  { label: "Room & board", value: profile.roomBoardAmt },
                  { label: "Avg net price", value: profile.avgNetPrice },
                ]}
              />
              <MetricGrid>
                <Metric label="Application fee (UG)" value={formatUsd(profile.appFeeUg)} />
              </MetricGrid>
            </DossierSectionBlock>
          ) : null}

          {showOutcomes ? (
            <DossierSectionBlock id="outcomes" title="Outcomes">
              <MetricGrid>
                <Metric label="Grad rate (bach. 6yr)" value={formatPct(profile.gradRateBach6yr)} />
                <Metric label="Grad rate (total)" value={formatPct(profile.gradRateTotal)} />
                <Metric label="Retention (full-time)" value={formatPct(profile.retentionFt)} />
                <Metric label="Transfer-out rate" value={formatPct(profile.transferOutRate)} />
                <Metric
                  label="Student-faculty ratio"
                  value={formatRatio(profile.studentFacultyRatio)}
                />
                <Metric label="Award within 8yr" value={formatPct(profile.omAward8yr)} />
                <Metric label="Still enrolled 8yr" value={formatPct(profile.omStillEnrolled8yr)} />
              </MetricGrid>
            </DossierSectionBlock>
          ) : null}

          {showStudentBody ? (
            <DossierSectionBlock id="student-body" title="Student body">
              <DemographicsStackedBar
                inputs={[
                  { key: "white", label: "White", pct: profile.pctWhite },
                  { key: "black", label: "Black", pct: profile.pctBlack },
                  { key: "hispanic", label: "Hispanic", pct: profile.pctHispanic },
                  { key: "asianPac", label: "Asian/Pac. Isl.", pct: profile.pctAsianPacIsl },
                  { key: "amInd", label: "Am. Indian", pct: profile.pctAmInd },
                  { key: "twoOrMore", label: "Two or more", pct: profile.pctTwoOrMore },
                  { key: "nonresident", label: "Nonresident", pct: profile.pctNonresident },
                  { key: "unknown", label: "Unknown", pct: profile.pctUnknown },
                ]}
              />
              <MetricGrid>
                <Metric label="Women" value={formatPct(profile.pctWomen)} />
                <Metric label="In-state" value={formatPct(profile.pctInState)} />
                <Metric label="Out-of-state" value={formatPct(profile.pctOutOfState)} />
              </MetricGrid>
            </DossierSectionBlock>
          ) : null}

          {showAcademics ? (
            <DossierSectionBlock id="academics" title="Academics">
              {profile.topMajors.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {profile.topMajors.map((major) => (
                    <Badge key={major.cip2} variant="secondary">
                      {major.label}
                      <span className="ml-1 tabular-nums text-muted-foreground">
                        {major.count.toLocaleString("en-US")}
                      </span>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{EM_DASH}</p>
              )}
              {completions.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border">
                  {completions.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {row.cipTitle ?? EM_DASH}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {awardLevelText(row.awardLevel, row.awardLevelLabel)}
                      </span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {(row.count ?? 0).toLocaleString("en-US")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </DossierSectionBlock>
          ) : null}

          {showLocation ? (
            <DossierSectionBlock id="location" title="Location">
              <MetricGrid>
                <Metric label="City" value={profile.city ?? EM_DASH} />
                <Metric label="State" value={profile.stateAbbr ?? EM_DASH} />
                <Metric
                  label="Setting"
                  value={
                    profile.locale != null
                      ? (LOCALE_LABELS[profile.locale] ?? EM_DASH)
                      : EM_DASH
                  }
                />
              </MetricGrid>
            </DossierSectionBlock>
          ) : null}
        </div>
      </div>

      <ShortlistBar
        entries={resolveShortlistEntries(liveCompareIds, [profileRow])}
        onRemove={removeCompare}
        onClear={clearCompare}
        onOpenCompare={() => setCompareOpen(true)}
      />
      <CompareSheet
        open={compareOpen}
        onOpenChange={setCompareOpen}
        unitIds={liveCompareIds}
        onRemove={removeCompare}
        onAdd={addCompare}
        onClear={clearCompare}
      />
    </div>
  );
}
