"use client";

import type { ChartConfiguration } from "chart.js";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  FileSpreadsheet,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  completedMonthEndPeriods,
  unearnedRevenueDashboardHref,
  unearnedRevenueLotLabel,
  unearnedRevenueModelPresentation,
  unearnedRevenuePeriodSuffix,
  unearnedRevenueWaterfall,
} from "@/lib/unearned-revenue/presentation";
import {
  type UnearnedRevenueAccessRow,
  type UnearnedRevenueCapability,
  type UnearnedRevenueDashboardPayload,
  type UnearnedRevenueLotDetail,
  type UnearnedRevenueStudentDetailPayload,
  type UnearnedRevenueStudentRow,
} from "@/lib/unearned-revenue/types";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 2,
});
const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function MetricCard({ label, value, note, primary = false }: {
  label: string;
  value: string;
  note?: string;
  primary?: boolean;
}) {
  return (
    <Card className={cn(primary && "border-primary/30 bg-primary/[0.04]")}> 
      <CardContent className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn("mt-2 font-mono text-xl font-semibold tracking-tight", primary && "text-2xl text-primary")}>
          {value}
        </div>
        {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

function TraceLink({ href, children = "Open formula" }: { href: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

function ModelBadge({ canonicalModel, modelVersion }: {
  canonicalModel: UnearnedRevenueDashboardPayload["metadata"]["canonicalModel"];
  modelVersion: string;
}) {
  const presentation = unearnedRevenueModelPresentation(canonicalModel, modelVersion);
  const fifo = presentation.fifoCanonical;
  return (
    <Badge variant={fifo ? "default" : "outline"} className={fifo ? "bg-emerald-600 text-white" : "border-amber-300 bg-amber-50 text-amber-900"}>
      {presentation.badgeLabel}
    </Badge>
  );
}

function QualityCard({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warn" }) {
  return (
    <div className={cn(
      "rounded-lg border px-3 py-2",
      tone === "warn" && value > 0 ? "border-amber-300 bg-amber-50/80" : "bg-muted/30",
    )}>
      <div className="font-mono text-lg font-semibold">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function StudentLiability({ row, shadow }: { row: UnearnedRevenueStudentRow; shadow: boolean }) {
  return (
    <div className="text-right">
      <div className="font-mono font-semibold tabular-nums">{money.format(row.canonicalClosingLiabilityThb)}</div>
      {shadow && (
        <div className={cn(
          "mt-0.5 flex items-center justify-end gap-1 text-[11px]",
          row.fifoVsLegacyDifferenceThb > 0 ? "text-rose-700" : "text-emerald-700",
        )}>
          {row.fifoVsLegacyDifferenceThb > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
          FIFO {row.fifoVsLegacyDifferenceThb >= 0 ? "+" : ""}{money.format(row.fifoVsLegacyDifferenceThb)}
        </div>
      )}
    </div>
  );
}

function confidenceLabel(lot: UnearnedRevenueLotDetail): string {
  if (lot.matchConfidence === "COMPOSITE_VERIFIED") return "Composite verified";
  if (lot.matchConfidence === "FINANCE_REVIEWED") return "Finance reviewed";
  if (lot.matchConfidence === "CANDIDATE") return "Candidate";
  if (lot.matchConfidence === "COMPLIMENTARY") return "Matched · zero value";
  if (lot.matchConfidence === "EXACT") return "Exact match";
  return "Residual";
}

export function UnearnedRevenueLotTraceLinks({ lot }: { lot: UnearnedRevenueLotDetail }) {
  return (
    <div className="mt-4 flex flex-wrap gap-4 border-t pt-3">
      <TraceLink href={lot.formulaTrace.url}>Open formula</TraceLink>
      {lot.salesTrace && <TraceLink href={lot.salesTrace.url}>Open sales row</TraceLink>}
      {lot.creditEventTrace && <TraceLink href={lot.creditEventTrace.url}>Open credit event</TraceLink>}
      {lot.receiptTrace && <TraceLink href={lot.receiptTrace.url}>Open receipt evidence</TraceLink>}
      {!lot.salesTrace && !lot.creditEventTrace && !lot.receiptTrace && (
        <span className="text-xs text-muted-foreground">No source links for this synthetic opening lot</span>
      )}
    </div>
  );
}

export const UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT = {
  dialog: "top-0 right-0 bottom-0 left-auto flex h-dvh w-full min-w-0 max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:w-[min(1180px,calc(100vw-2rem))] sm:max-w-none",
  scrollBody: "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden",
  content: "min-w-0 space-y-6 p-5",
  accountSection: "min-w-0 space-y-2",
  accountFrame: "min-w-0 overflow-hidden rounded-lg border",
  accountTable: "min-w-[920px]",
} as const;

export function UnearnedRevenueStudentDetailContent({
  detail,
}: {
  detail: UnearnedRevenueStudentDetailPayload;
}) {
  return (
    <div
      role="region"
      aria-label={`${detail.student.studentName || detail.student.studentId} liability details`}
      className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.content}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Closing liability" value={money.format(detail.student.canonicalClosingLiabilityThb)} primary />
        <MetricCard label="Remaining paid credits" value={quantity.format(detail.student.remainingPaidCredits)} />
        <MetricCard label="Attributed" value={`${percent.format(detail.student.attributionPercent)}%`} note={`${money.format(detail.student.residualLiabilityThb)} residual`} />
      </div>

      <section className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.accountSection}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">Class-account reconciliation</h3>
            <p className="text-xs text-muted-foreground">Each WISE student/class account rolls into the student total.</p>
          </div>
          <TraceLink href={detail.student.trace.url} />
        </div>
        <div className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.accountFrame}>
          <Table className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.accountTable}>
            <TableHeader>
              <TableRow>
                <TableHead>Class account</TableHead>
                <TableHead className="text-right">Ledger credits</TableHead>
                <TableHead className="text-right">Paid credits</TableHead>
                <TableHead className="text-right">Legacy</TableHead>
                <TableHead className="text-right">FIFO</TableHead>
                <TableHead className="text-right">Canonical</TableHead>
                <TableHead>Review</TableHead>
                <TableHead>Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.accounts.map((account) => (
                <TableRow key={account.accountId}>
                  <TableCell>
                    <div className="font-medium">{account.className || account.classId}</div>
                    <div className="text-xs text-muted-foreground">{account.classSubject || account.accountId}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{quantity.format(account.ledgerRemainingCredits)}</TableCell>
                  <TableCell className="text-right font-mono">{quantity.format(account.closingPaidCredits)}</TableCell>
                  <TableCell className="text-right font-mono">{money.format(account.legacyClosingLiabilityThb)}</TableCell>
                  <TableCell className="text-right font-mono">{money.format(account.fifoClosingLiabilityThb)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{money.format(account.canonicalClosingLiabilityThb)}</TableCell>
                  <TableCell><Badge variant="outline">{account.reviewState.replaceAll("_", " ")}</Badge></TableCell>
                  <TableCell><TraceLink href={account.trace.url} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="min-w-0 space-y-2">
        <div>
          <h3 className="font-semibold">Package lots</h3>
          <p className="text-xs text-muted-foreground">Paid lots are consumed oldest-first within each class account, before complimentary credits.</p>
        </div>
        <div className="min-w-0 space-y-3">
          {detail.lots.length === 0 && (
            <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No active lot movement for this period.</div>
          )}
          {detail.lots.map((lot) => (
            <Card key={lot.lotId} className={cn("min-w-0", ["OPENING", "AMBIGUOUS", "UNATTRIBUTED", "COMPOSITE_CANDIDATE"].includes(lot.lotKind) && "border-amber-300 bg-amber-50/40")}>
              <CardContent className="min-w-0 p-4">
                <div className="flex min-w-0 flex-col justify-between gap-3 sm:flex-row">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="break-words font-semibold">{unearnedRevenueLotLabel(lot)}</div>
                      <Badge variant="outline">{lot.matchStatus.replaceAll("_", " ")}</Badge>
                      <span className="text-xs text-muted-foreground">{confidenceLabel(lot)}</span>
                    </div>
                    {lot.receipt && (
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        Receipt {lot.receipt.id} · {money.format(lot.receipt.amountThb)} · {lot.receipt.status}
                      </div>
                    )}
                    <div className="mt-1 break-words text-xs text-muted-foreground">
                      {lot.transactionNumber || "No transaction number"}
                      {lot.transactionDate ? ` · ${formatDate(lot.transactionDate)}` : ""}
                    </div>
                    {lot.matchRuleId && (
                      <div className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                        Match rule: {lot.matchRuleId}
                      </div>
                    )}
                    {lot.candidateReceiptIds.length > 0 && (
                      <div className="mt-1 break-words text-xs text-amber-800">
                        Candidate receipts: {lot.candidateReceiptIds.join(", ")}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-left sm:text-right">
                    <div className="font-mono text-lg font-semibold">{money.format(lot.closingLiabilityThb)}</div>
                    <div className="text-xs text-muted-foreground">{quantity.format(lot.remainingCredits)} credits remaining</div>
                  </div>
                </div>
                <div className="mt-4 grid min-w-0 grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-7">
                  {[
                    ["Original", quantity.format(lot.originalCredits)],
                    ["Recovered deficit", quantity.format(lot.negativeRecoveryCredits)],
                    ["Opening", quantity.format(lot.openingCredits)],
                    ["Deferred", quantity.format(lot.deferredCredits)],
                    ["Recognized", quantity.format(lot.recognizedCredits)],
                    ["Unit rate", money.format(lot.unitRateThb)],
                    ["Net payment", money.format(lot.netPaymentThb)],
                  ].map(([label, value]) => (
                    <div className="min-w-0" key={label}>
                      <div className="text-muted-foreground">{label}</div>
                      <div className="mt-1 break-words font-mono font-medium">{value}</div>
                    </div>
                  ))}
                </div>
                {Object.keys(lot.matchEvidence).length > 0 && (
                  <details className="mt-3 rounded-md border bg-background/70 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-medium">Matching evidence</summary>
                    <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                      {JSON.stringify(lot.matchEvidence, null, 2)}
                    </pre>
                  </details>
                )}
                <UnearnedRevenueLotTraceLinks lot={lot} />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

function StudentDetailDrawer({
  studentId,
  period,
  onClose,
}: {
  studentId: string;
  period: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<UnearnedRevenueStudentDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/unearned-revenue/students/${encodeURIComponent(studentId)}?period=${encodeURIComponent(period)}`, {
      signal: controller.signal,
    })
      .then(responseJson<UnearnedRevenueStudentDetailPayload>)
      .then(setDetail)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Could not load student detail");
      });
    return () => controller.abort();
  }, [period, studentId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.dialog}>
        <DialogHeader className="shrink-0 border-b bg-background/95 px-5 py-4 pr-14 backdrop-blur">
          <DialogTitle className="break-words">{detail?.student.studentName || "Student liability detail"}</DialogTitle>
          <DialogDescription className="break-words">
            {detail ? `${detail.student.studentId} · data through ${formatDate(detail.periodEnd)}` : "Loading formula-backed account and package rows…"}
          </DialogDescription>
        </DialogHeader>
        <div
          data-slot="unearned-revenue-student-detail-scroll"
          className={UNEARNED_REVENUE_STUDENT_DRAWER_LAYOUT.scrollBody}
        >
          {error && <div className="m-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive">{error}</div>}
          {!detail && !error && <div className="p-5 text-sm text-muted-foreground">Loading…</div>}
          {detail && <UnearnedRevenueStudentDetailContent detail={detail} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rows, setRows] = useState<UnearnedRevenueAccessRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetch("/api/unearned-revenue/access")
      .then(responseJson<{ rows: UnearnedRevenueAccessRow[] }>)
      .then((body) => setRows(body.rows))
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Could not load access"));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [load, open]);

  async function toggle(row: UnearnedRevenueAccessRow, capability: UnearnedRevenueCapability) {
    setBusy(row.email);
    setError(null);
    const next = row.capabilities.includes(capability)
      ? row.capabilities.filter((item) => item !== capability)
      : [...row.capabilities, capability];
    try {
      await responseJson(await fetch("/api/unearned-revenue/access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetEmail: row.email, capabilities: next, expectedVersion: row.version }),
      }));
      load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update access");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unearned Revenue access</DialogTitle>
          <DialogDescription>Only allowlisted admins appear here. Grants are resolved fresh from Postgres.</DialogDescription>
        </DialogHeader>
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
        <div className="max-h-[60vh] overflow-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Admin</TableHead><TableHead>Viewer</TableHead><TableHead>Access manager</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.email}>
                  <TableCell><div className="font-medium">{row.name || row.email}</div><div className="text-xs text-muted-foreground">{row.email}</div></TableCell>
                  {(["viewer", "access_manager"] as const).map((capability) => (
                    <TableCell key={capability}>
                      <input
                        aria-label={`${capability} for ${row.email}`}
                        type="checkbox"
                        checked={row.capabilities.includes(capability)}
                        disabled={busy === row.email}
                        onChange={() => toggle(row, capability)}
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function UnearnedRevenueDashboard({
  initialPayload = null,
}: {
  initialPayload?: UnearnedRevenueDashboardPayload | null;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [payload, setPayload] = useState<UnearnedRevenueDashboardPayload | null>(initialPayload);
  const [loading, setLoading] = useState(initialPayload === null);
  const [error, setError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(searchParams.get("search") ?? "");
  const [refreshing, setRefreshing] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const selectedStudent = searchParams.get("student");

  const queryString = searchParams.toString();
  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/unearned-revenue?${queryString}`, { signal: controller.signal })
      .then(responseJson<UnearnedRevenueDashboardPayload>)
      .then(setPayload)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Could not load dashboard");
      })
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [queryString]);

  useEffect(load, [load]);
  useEffect(() => setSearchDraft(searchParams.get("search") ?? ""), [searchParams]);

  function updateQuery(values: Record<string, string | null>, mode: "replace" | "push" = "replace") {
    const href = unearnedRevenueDashboardHref(pathname, searchParams, values);
    if (mode === "push") router.push(href);
    else router.replace(href);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    updateQuery({ search: searchDraft.trim() || null, page: null });
  }

  async function manualRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const result = await responseJson<{ ok: boolean; errorSummary?: string }>(await fetch("/api/unearned-revenue/sync", { method: "POST" }));
      if (!result.ok) throw new Error(result.errorSummary || "Import failed");
      load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not refresh");
    } finally {
      setRefreshing(false);
    }
  }

  const trendConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    const periods = completedMonthEndPeriods(payload?.periods ?? []);
    return {
      type: "bar",
      data: {
        labels: periods.map((period) => formatDate(period.periodEnd)),
        datasets: [{
          label: "Closing unearned revenue",
          data: periods.map((period) => period.closingLiabilityThb),
          backgroundColor: colors.chart[0],
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.mutedForeground } },
          y: { beginAtZero: true, ticks: { color: colors.mutedForeground, callback: (value) => `฿${Number(value).toLocaleString("en-US", { notation: "compact" })}` } },
        },
      },
    };
  }, [payload]);

  const waterfallConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    const selected = payload?.selectedPeriod;
    const opening = selected?.openingLiabilityThb ?? 0;
    const deferred = selected?.deferredNewLiabilityThb ?? 0;
    const recognized = selected?.recognizedRevenueThb ?? 0;
    const closing = selected?.closingLiabilityThb ?? 0;
    const points = unearnedRevenueWaterfall({ opening, deferred, recognized, closing });
    return {
      type: "bar",
      data: {
        labels: ["Opening", "+ Deferred", "− Recognized", "Closing"],
        datasets: [{
          label: "THB",
          data: points as unknown as number[],
          backgroundColor: [colors.chart[4], colors.chart[0], colors.chart[1], colors.chart[3]],
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.mutedForeground } },
          y: { beginAtZero: true, ticks: { color: colors.mutedForeground, callback: (value) => `฿${Number(value).toLocaleString("en-US", { notation: "compact" })}` } },
        },
      },
    };
  }, [payload]);

  if (loading && !payload) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading unearned revenue…</div>;
  }
  if (!payload) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Card className="max-w-lg"><CardContent className="p-6"><div className="font-semibold">Unearned revenue is not ready</div><p className="mt-2 text-sm text-muted-foreground">{error}</p></CardContent></Card>
      </div>
    );
  }

  const selected = payload.selectedPeriod;
  const shadow = payload.metadata.modelMode === "SHADOW";
  const modelPresentation = unearnedRevenueModelPresentation(
    payload.metadata.canonicalModel,
    payload.metadata.modelVersion,
  );
  const exact = payload.exactPackageOverview;
  const canManage = payload.metadata.capabilities.includes("access_manager");
  const warning = payload.metadata.stale || payload.metadata.lastSyncStatus === "failed";

  return (
    <div data-selected-student={selectedStudent || undefined} className="-mx-4 -my-3 min-h-0 flex-1 overflow-y-auto bg-muted/20 px-4 py-5 lg:-mx-6 lg:px-6">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Unearned Revenue</h1>
              <ModelBadge
                canonicalModel={payload.metadata.canonicalModel}
                modelVersion={payload.metadata.modelVersion}
              />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Data through {formatDate(payload.metadata.cutoff)} · imported {formatDateTime(payload.metadata.importedAt)} · revision {payload.metadata.sourceRevision}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button nativeButton={false} variant="outline" render={<a href={payload.metadata.workbookUrl} target="_blank" rel="noreferrer" />}>
              <FileSpreadsheet className="size-4" /> Workbook
            </Button>
            {canManage && (
              <>
                <Button variant="outline" onClick={() => setAccessOpen(true)}><ShieldCheck className="size-4" /> Access</Button>
                <Button onClick={manualRefresh} disabled={refreshing}>
                  <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
                  {refreshing ? "Importing…" : "Refresh"}
                </Button>
              </>
            )}
          </div>
        </header>

        {(warning || error) && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-medium">Last-good snapshot retained</div>
              <div className="mt-0.5 text-xs">
                {error || payload.metadata.lastSyncError || "The workbook is older than the latest completed Bangkok day."}
              </div>
            </div>
          </div>
        )}

        {shadow && (
          <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3 text-sm text-sky-950">
            <div className="font-medium">Legacy is still the official number</div>
            <div className="mt-1 text-xs leading-relaxed">
              {modelPresentation.runtimeLabel} is a review copy that links a sales row, Wise receipt, and credit event. Finance must approve this exact workbook run before it can replace the legacy value.
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="period-select">Reporting period</label>
          <select
            id="period-select"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={payload.filters.period}
            onChange={(event) => updateQuery({ period: event.target.value, page: null })}
          >
            {payload.periods.map((period) => (
              <option key={period.periodEnd} value={period.periodEnd}>
                {formatDate(period.periodEnd)} ({unearnedRevenuePeriodSuffix(period.periodKind)})
              </option>
            ))}
          </select>
          <TraceLink href={selected.trace.url}>Open total formula</TraceLink>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Closing unearned revenue" value={money.format(selected.closingLiabilityThb)} primary note={`${selected.studentCount.toLocaleString()} students · ${selected.accountCount.toLocaleString()} accounts`} />
          <MetricCard label="Opening liability" value={money.format(selected.openingLiabilityThb)} />
          <MetricCard label="Newly deferred" value={money.format(selected.deferredNewLiabilityThb)} />
          <MetricCard label="Recognized revenue" value={money.format(selected.recognizedRevenueThb)} />
          <MetricCard label="Remaining paid credits" value={quantity.format(selected.remainingPaidCredits)} />
          <MetricCard
            label="Liability tied to exact packages"
            value={exact.available ? money.format(exact.totalLiabilityThb) : "Not available"}
            note={exact.available
              ? `${percent.format(exact.attributionPercent)}% of FIFO liability · ${money.format(exact.residualLiabilityThb)} residual`
              : "Appears after the first schema-4 workbook import"}
          />
          <MetricCard label={`${modelPresentation.runtimeLabel} candidate`} value={money.format(selected.fifoClosingLiabilityThb)} note={shadow ? `Delta ${money.format(selected.fifoVsLegacyDifferenceThb)}` : "Canonical package-lot model"} />
          <MetricCard label="Legacy comparator" value={money.format(selected.legacyClosingLiabilityThb)} note={!shadow ? `Delta ${money.format(-selected.fifoVsLegacyDifferenceThb)} vs FIFO` : "Canonical until Finance approval"} />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Completed month-end liability</CardTitle></CardHeader>
            <CardContent><ChartCanvas className="h-72" config={trendConfig} ariaLabel="Column chart of completed month-end closing unearned revenue" /></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Selected-period roll-forward</CardTitle></CardHeader>
            <CardContent><ChartCanvas className="h-72" config={waterfallConfig} ariaLabel="Waterfall chart showing opening plus deferred minus recognized equals closing liability" /></CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader className="space-y-1 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Liability tied to exact packages</CardTitle>
              {exact.available && (
                <Badge variant={shadow ? "outline" : "default"}>
                  {shadow ? `${modelPresentation.runtimeLabel} shadow` : "Canonical"}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Automatic exact matches and documented Finance overrides only. Opening and unresolved lots are excluded.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 p-0 pb-4">
            {exact.available ? (
              <>
                <div className="grid gap-2 px-4 sm:grid-cols-2 lg:grid-cols-4">
                  <MetricCard label="Automatic exact" value={money.format(exact.automaticLiabilityThb)} />
                  <MetricCard label="Finance reviewed" value={money.format(exact.financeReviewedLiabilityThb)} />
                  <MetricCard label="Remaining exact credits" value={quantity.format(exact.remainingCredits)} />
                  <MetricCard label="Active exact lots" value={exact.activeLotCount.toLocaleString()} note={`${exact.packageCount.toLocaleString()} packages with liability`} />
                </div>
                <div className="overflow-x-auto border-y">
                  <Table className="min-w-[980px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Package</TableHead>
                        <TableHead className="text-right">Exact liability</TableHead>
                        <TableHead className="text-right">Automatic</TableHead>
                        <TableHead className="text-right">Finance reviewed</TableHead>
                        <TableHead className="text-right">Remaining credits</TableHead>
                        <TableHead className="text-right">Students</TableHead>
                        <TableHead className="text-right">Active lots</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead>Trace</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {exact.packages.map((row) => (
                        <TableRow key={row.packageName}>
                          <TableCell className="font-medium">{row.packageName}</TableCell>
                          <TableCell className="text-right font-mono font-semibold">{money.format(row.closingExactLiabilityThb)}</TableCell>
                          <TableCell className="text-right font-mono">{money.format(row.automaticExactLiabilityThb)}</TableCell>
                          <TableCell className="text-right font-mono">{money.format(row.financeReviewedLiabilityThb)}</TableCell>
                          <TableCell className="text-right font-mono">{quantity.format(row.remainingCredits)}</TableCell>
                          <TableCell className="text-right font-mono">{row.studentCount.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{row.activeLotCount.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{percent.format(row.shareOfExactLiability)}%</TableCell>
                          <TableCell><TraceLink href={row.trace.url} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {exact.packages.length === 0 && (
                  <div className="px-4 text-sm text-muted-foreground">No exact-package liability remains in this period.</div>
                )}
              </>
            ) : (
              <div className="px-4 text-sm text-muted-foreground">
                This snapshot predates schema 4. Student and FIFO totals remain available; the package overview will appear after a successful schema-4 import.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Data quality and review conditions</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <QualityCard label="Composite verified" value={payload.quality.compositeVerifiedCount} />
              <QualityCard label="Receipt candidates" value={payload.quality.receiptCandidateCount} tone="warn" />
              <QualityCard label="Reversal conflicts" value={payload.quality.reversalConflictCount} tone="warn" />
              <QualityCard label="Missing receipt evidence" value={payload.quality.missingReceiptEvidenceCount} tone="warn" />
              <QualityCard label="Ambiguous lots" value={payload.quality.ambiguousCount} tone="warn" />
              <QualityCard label="Unattributed lots" value={payload.quality.unattributedCount} tone="warn" />
              <QualityCard label="Fallback-valued lots" value={payload.quality.fallbackValuedCount} tone="warn" />
              <QualityCard label="Negative-balance accounts" value={payload.quality.negativeBalanceCount} tone="warn" />
              <QualityCard label="API-variance accounts" value={payload.quality.apiVarianceCount} tone="warn" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-3 pb-3">
            <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
              <div>
                <CardTitle className="text-base">Students</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">One row per stable WISE student ID across all class accounts.</p>
              </div>
              <form onSubmit={submitSearch} className="flex min-w-0 gap-2">
                <div className="relative min-w-0 flex-1 sm:w-72">
                  <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search name or WISE ID" className="pl-8" />
                </div>
                <Button type="submit" variant="outline">Search</Button>
              </form>
            </div>
            <div className="flex flex-wrap gap-2">
              <select aria-label="Liability scope" className="h-8 rounded-md border bg-background px-2 text-xs" value={payload.filters.scope} onChange={(event) => updateQuery({ scope: event.target.value, page: null })}>
                <option value="positive">Positive liability</option><option value="all">All students</option>
              </select>
              <select aria-label="Attribution status" className="h-8 rounded-md border bg-background px-2 text-xs" value={payload.filters.attribution} onChange={(event) => updateQuery({ attribution: event.target.value, page: null })}>
                <option value="all">All attribution</option><option value="attributed">Fully attributed</option><option value="residual">Has residual</option><option value="ambiguous">Ambiguous</option><option value="unattributed">Unattributed</option>
              </select>
              <select aria-label="Review status" className="h-8 rounded-md border bg-background px-2 text-xs" value={payload.filters.review} onChange={(event) => updateQuery({ review: event.target.value, page: null })}>
                <option value="all">All review states</option><option value="needs_review">Needs review</option><option value="clear">No review required</option>
              </select>
              <select aria-label="Sort students" className="h-8 rounded-md border bg-background px-2 text-xs" value={payload.filters.sort} onChange={(event) => updateQuery({ sort: event.target.value, page: null })}>
                <option value="liability_desc">Liability: high to low</option><option value="liability_asc">Liability: low to high</option><option value="name_asc">Student name</option><option value="credits_desc">Paid credits: high to low</option>
              </select>
              <select aria-label="Rows per page" className="h-8 rounded-md border bg-background px-2 text-xs" value={payload.pagination.pageSize} onChange={(event) => updateQuery({ pageSize: event.target.value, page: null })}>
                {[25, 50, 100].map((size) => <option key={size} value={size}>{size} rows</option>)}
              </select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="hidden md:block">
              <Table>
                <TableHeader><TableRow><TableHead>Student</TableHead><TableHead className="text-right">Accounts</TableHead><TableHead className="text-right">Paid credits</TableHead><TableHead className="text-right">Closing liability</TableHead><TableHead className="text-right">Attributed</TableHead><TableHead className="text-right">Residual</TableHead><TableHead>Review</TableHead><TableHead>Trace</TableHead></TableRow></TableHeader>
                <TableBody>
                  {payload.students.map((row) => (
                    <TableRow key={row.studentId} data-detail-href={unearnedRevenueDashboardHref(pathname, searchParams, { student: row.studentId })} className="cursor-pointer" tabIndex={0} onClick={() => updateQuery({ student: row.studentId }, "push")} onKeyDown={(event) => { if (event.key === "Enter") updateQuery({ student: row.studentId }, "push"); }}>
                      <TableCell><div className="font-medium">{row.studentName || "Unnamed student"}</div><div className="font-mono text-xs text-muted-foreground">{row.studentId}</div></TableCell>
                      <TableCell className="text-right font-mono">{row.accountCount}</TableCell>
                      <TableCell className="text-right font-mono">{quantity.format(row.remainingPaidCredits)}</TableCell>
                      <TableCell><StudentLiability row={row} shadow={shadow} /></TableCell>
                      <TableCell className="text-right font-mono">{percent.format(row.attributionPercent)}%</TableCell>
                      <TableCell className="text-right font-mono">{money.format(row.residualLiabilityThb)}</TableCell>
                      <TableCell><Badge variant="outline" className={row.reviewState === "NEEDS_REVIEW" ? "border-amber-300 bg-amber-50" : ""}>{row.reviewState.replaceAll("_", " ")}</Badge></TableCell>
                      <TableCell><TraceLink href={row.trace.url} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="divide-y md:hidden">
              {payload.students.map((row) => (
                <button key={row.studentId} data-detail-href={unearnedRevenueDashboardHref(pathname, searchParams, { student: row.studentId })} type="button" className="w-full p-4 text-left hover:bg-muted/50" onClick={() => updateQuery({ student: row.studentId }, "push")}>
                  <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{row.studentName || "Unnamed student"}</div><div className="font-mono text-xs text-muted-foreground">{row.studentId}</div></div><StudentLiability row={row} shadow={shadow} /></div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><span className="text-muted-foreground">Accounts</span><div className="font-mono">{row.accountCount}</div></div><div><span className="text-muted-foreground">Paid credits</span><div className="font-mono">{quantity.format(row.remainingPaidCredits)}</div></div><div><span className="text-muted-foreground">Attributed</span><div className="font-mono">{percent.format(row.attributionPercent)}%</div></div></div>
                </button>
              ))}
            </div>
            {payload.students.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No students match these filters.</div>}
            <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
              <span>{payload.pagination.totalRows.toLocaleString()} students · page {payload.pagination.page} of {payload.pagination.totalPages}</span>
              <div className="flex gap-2"><Button size="sm" variant="outline" disabled={payload.pagination.page <= 1} onClick={() => updateQuery({ page: String(payload.pagination.page - 1) })}>Previous</Button><Button size="sm" variant="outline" disabled={payload.pagination.page >= payload.pagination.totalPages} onClick={() => updateQuery({ page: String(payload.pagination.page + 1) })}>Next</Button></div>
            </div>
          </CardContent>
        </Card>
      </div>

      {selectedStudent && (
        <StudentDetailDrawer
          key={`${selectedStudent}:${payload.filters.period}`}
          studentId={selectedStudent}
          period={payload.filters.period}
          onClose={() => updateQuery({ student: null }, "push")}
        />
      )}
      {canManage && <AccessDialog open={accessOpen} onOpenChange={setAccessOpen} />}
    </div>
  );
}
