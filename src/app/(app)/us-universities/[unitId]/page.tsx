import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getInstitutionProfile } from "@/lib/us-universities/data";
import { MAX_COMPARE } from "@/lib/us-universities/constants";
import { consoleHref } from "@/lib/us-universities/nav";
import type { FilterParams } from "@/lib/us-universities/types";
import { InstitutionDossier } from "@/components/us-universities/institution-dossier";
import DossierLoading from "./loading";

// ── Pure param parsers (exported for tests) ────────────────────────────

type SearchParamsShape = Record<string, string | string[] | undefined>;

/** Positive integer unit id, or null. */
export function parseUnitId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Comma-list of positive ints, capped at MAX_COMPARE (mirrors shell parseIds). */
export function parseCompareParam(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_COMPARE);
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toInt(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Reconstruct FilterParams from a search-param object (inverse of buildSearchQuery). */
export function parseFilterParams(sp: SearchParamsShape): FilterParams {
  const out: FilterParams = {};
  const search = first(sp.search)?.trim();
  if (search) out.search = search;

  const states = first(sp.states);
  if (states) {
    const arr = states.split(",").map((s) => s.trim()).filter(Boolean);
    if (arr.length) out.states = arr;
  }

  const control = first(sp.control);
  if (control) {
    const arr = control
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (arr.length) out.control = arr;
  }

  const minAcceptance = toInt(first(sp.minAcceptance));
  if (minAcceptance != null) out.minAcceptance = minAcceptance;
  const maxAcceptance = toInt(first(sp.maxAcceptance));
  if (maxAcceptance != null) out.maxAcceptance = maxAcceptance;
  const maxNetPrice = toInt(first(sp.maxNetPrice));
  if (maxNetPrice != null) out.maxNetPrice = maxNetPrice;
  const minGradRate = toInt(first(sp.minGradRate));
  if (minGradRate != null) out.minGradRate = minGradRate;

  const cip2 = first(sp.cip2)?.trim();
  if (cip2) out.cip2 = cip2;

  const sort = first(sp.sort)?.trim();
  if (sort) out.sort = sort;

  const dir = first(sp.dir);
  if (dir === "asc" || dir === "desc") out.dir = dir;

  const page = toInt(first(sp.page));
  if (page != null) out.page = page;
  const pageSize = toInt(first(sp.pageSize));
  if (pageSize != null) out.pageSize = pageSize;

  return out;
}

// ── Route ──────────────────────────────────────────────────────────────

async function DossierBody({
  unitId,
  searchParams,
}: {
  unitId: number;
  searchParams: SearchParamsShape;
}) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  const profile = await getInstitutionProfile(unitId);
  if (!profile) {
    notFound();
  }

  const filters = parseFilterParams(searchParams);
  const compareIds = parseCompareParam(first(searchParams.compare));
  const backHref = consoleHref(filters, compareIds);

  return <InstitutionDossier profile={profile} backHref={backHref} compareIds={compareIds} />;
}

export default async function InstitutionDossierPage({
  params,
  searchParams,
}: {
  params: Promise<{ unitId: string }>;
  searchParams: Promise<SearchParamsShape>;
}) {
  const { unitId } = await params;
  const sp = await searchParams;
  const parsed = parseUnitId(unitId);
  if (parsed == null) {
    notFound();
  }

  return (
    <Suspense fallback={<DossierLoading />}>
      <DossierBody unitId={parsed} searchParams={sp} />
    </Suspense>
  );
}
