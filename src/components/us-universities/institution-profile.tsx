"use client";

// ── Institution profile dialog ─────────────────────────────────────────
// Fetches a single IPEDS institution on demand and renders a scrollable,
// sectioned read-only profile. Fail-closed UI rule: a missing numeric metric
// (number | null) is rendered as an em dash "—", never coerced to 0.

import { useEffect, useState } from "react";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ADM_CONSIDERATION_LABELS,
  ADM_CONSIDERATION_VALUE_LABELS,
  AWARD_LEVEL_LABELS,
  CONTROL_LABELS,
  INST_SIZE_LABELS,
} from "@/lib/us-universities/constants";
import type { InstitutionProfile } from "@/lib/us-universities/types";
import type { InstitutionProfileDialogProps } from "./view-types";

// ── Formatting helpers (pure, exported for tests) ──────────────────────

const EM_DASH = "—";

/** USD with thousands separators; null/undefined → em dash. */
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Percentage value (already 0–100); null/undefined → em dash. */
export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  // Keep up to one decimal place but drop a trailing ".0".
  const rounded = Math.round(v * 10) / 10;
  return `${rounded}%`;
}

/** Student-faculty ratio as "N:1"; null/undefined → em dash. */
export function formatRatio(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  const rounded = Math.round(v * 10) / 10;
  return `${rounded}:1`;
}

export interface AdmissionRequirement {
  key: string;
  label: string;
  level: string;
}

/**
 * Build the admission-requirements list from the ADMCON1..12 map.
 * Skips null codes and "Not considered" (code 3), preserving the canonical
 * ADMCON1→ADMCON12 ordering.
 */
export function admissionRequirements(
  admConsiderations: Record<string, number | null> | null | undefined,
): AdmissionRequirement[] {
  if (!admConsiderations) return [];
  const out: AdmissionRequirement[] = [];
  for (let n = 1; n <= 12; n += 1) {
    const key = `ADMCON${n}`;
    const code = admConsiderations[key];
    if (code == null) continue;
    // 3 = "Not considered" — omit it from the surfaced requirements.
    if (code === 3) continue;
    const level = ADM_CONSIDERATION_VALUE_LABELS[code];
    if (!level) continue;
    out.push({ key, label: ADM_CONSIDERATION_LABELS[key] ?? key, level });
  }
  return out;
}

/** Completion row label, preferring the precomputed award-level label. */
function awardLevelText(awardLevel: number | null, fallbackLabel: string | null): string {
  if (fallbackLabel) return fallbackLabel;
  if (awardLevel != null && AWARD_LEVEL_LABELS[awardLevel]) {
    return AWARD_LEVEL_LABELS[awardLevel];
  }
  return EM_DASH;
}

const MAX_COMPLETION_ROWS = 25;

// ── Presentational atoms ───────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">{children}</dl>
  );
}

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

/** Render a p25–p75 range, or em dash if neither bound is present. */
function rangeText(p25: number | null, p75: number | null): string {
  if (p25 == null && p75 == null) return EM_DASH;
  const lo = p25 == null ? EM_DASH : p25.toLocaleString("en-US");
  const hi = p75 == null ? EM_DASH : p75.toLocaleString("en-US");
  return `${lo}–${hi}`;
}

// ── Component ──────────────────────────────────────────────────────────

export function InstitutionProfileDialog({
  unitId,
  onClose,
  onAddCompare,
}: InstitutionProfileDialogProps) {
  const [profile, setProfile] = useState<InstitutionProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Defer state updates into the timer callback so no setState runs
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const handle = window.setTimeout(() => {
      if (unitId == null) {
        setProfile(null);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setProfile(null);

      fetch(`/api/us-universities/institutions/${unitId}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(
              res.status === 404
                ? "Institution not found."
                : `Failed to load institution (${res.status}).`,
            );
          }
          return (await res.json()) as InstitutionProfile;
        })
        .then((data) => {
          setProfile(data);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load institution.");
          setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [unitId]);

  const open = unitId != null;

  const requirements = profile ? admissionRequirements(profile.admConsiderations) : [];
  const completions = profile
    ? [...profile.completions].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, MAX_COMPLETION_ROWS)
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto sm:max-w-2xl"
        aria-busy={loading}
      >
        {loading && (
          <div className="space-y-4 py-8" aria-live="polite">
            <DialogHeader>
              <DialogTitle>Loading institution…</DialogTitle>
              <DialogDescription>Fetching the latest IPEDS profile.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-24 w-full animate-pulse rounded bg-muted" />
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="space-y-3 py-8">
            <DialogHeader>
              <DialogTitle>Unable to load institution</DialogTitle>
              <DialogDescription>{error}</DialogDescription>
            </DialogHeader>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {!loading && !error && profile && (
          <div className="space-y-5">
            {/* Header */}
            <DialogHeader>
              <DialogTitle className="text-lg">{profile.instName}</DialogTitle>
              <DialogDescription>
                {[profile.city, profile.stateAbbr].filter(Boolean).join(", ") || EM_DASH}
              </DialogDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {profile.control != null && CONTROL_LABELS[profile.control] && (
                  <Badge variant="secondary">{CONTROL_LABELS[profile.control]}</Badge>
                )}
                {profile.instSize != null && INST_SIZE_LABELS[profile.instSize] && (
                  <Badge variant="outline">{INST_SIZE_LABELS[profile.instSize]}</Badge>
                )}
                {profile.website && (
                  <a
                    href={
                      /^https?:\/\//i.test(profile.website)
                        ? profile.website
                        : `https://${profile.website}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                  >
                    Website
                    <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
              <div className="pt-2">
                <Button size="sm" onClick={() => onAddCompare(profile.unitId)}>
                  <PlusIcon className="size-4" aria-hidden="true" />
                  Add to compare
                </Button>
              </div>
            </DialogHeader>

            <Separator />

            {/* Admissions */}
            <Section title="Admissions">
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
            </Section>

            <Separator />

            {/* Cost */}
            <Section title="Cost">
              <MetricGrid>
                <Metric label="Tuition (in-state)" value={formatUsd(profile.tuitionInState)} />
                <Metric label="Tuition (out-of-state)" value={formatUsd(profile.tuitionOutState)} />
                <Metric label="Total price (in-state)" value={formatUsd(profile.totalPriceInState)} />
                <Metric label="Room & board" value={formatUsd(profile.roomBoardAmt)} />
                <Metric label="Avg net price" value={formatUsd(profile.avgNetPrice)} />
                <Metric label="Application fee (UG)" value={formatUsd(profile.appFeeUg)} />
              </MetricGrid>
            </Section>

            <Separator />

            {/* Outcomes */}
            <Section title="Outcomes">
              <MetricGrid>
                <Metric label="Grad rate (bach. 6yr)" value={formatPct(profile.gradRateBach6yr)} />
                <Metric label="Grad rate (total)" value={formatPct(profile.gradRateTotal)} />
                <Metric label="Retention (full-time)" value={formatPct(profile.retentionFt)} />
                <Metric label="Transfer-out rate" value={formatPct(profile.transferOutRate)} />
                <Metric label="Student-faculty ratio" value={formatRatio(profile.studentFacultyRatio)} />
                <Metric label="Award within 8yr" value={formatPct(profile.omAward8yr)} />
                <Metric label="Still enrolled 8yr" value={formatPct(profile.omStillEnrolled8yr)} />
              </MetricGrid>
            </Section>

            <Separator />

            {/* Diversity & demographics */}
            <Section title="Diversity & demographics">
              <MetricGrid>
                <Metric label="Women" value={formatPct(profile.pctWomen)} />
                <Metric label="In-state" value={formatPct(profile.pctInState)} />
                <Metric label="Out-of-state" value={formatPct(profile.pctOutOfState)} />
                <Metric label="White" value={formatPct(profile.pctWhite)} />
                <Metric label="Black" value={formatPct(profile.pctBlack)} />
                <Metric label="Hispanic" value={formatPct(profile.pctHispanic)} />
                <Metric label="Asian or Pacific Islander" value={formatPct(profile.pctAsianPacIsl)} />
                <Metric label="American Indian" value={formatPct(profile.pctAmInd)} />
                <Metric label="Two or more races" value={formatPct(profile.pctTwoOrMore)} />
                <Metric label="Nonresident" value={formatPct(profile.pctNonresident)} />
                <Metric label="Unknown" value={formatPct(profile.pctUnknown)} />
              </MetricGrid>
            </Section>

            <Separator />

            {/* Known for */}
            <Section title="Known for">
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

              {completions.length > 0 && (
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
              )}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
