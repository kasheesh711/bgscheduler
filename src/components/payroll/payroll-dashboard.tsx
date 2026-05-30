"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  Clock3,
  Download,
  FileText,
  RefreshCw,
  Save,
  Trash2,
  UserMinus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { PayrollPayload, PayrollTutorRow } from "@/lib/payroll/types";

type FilterMode = "all" | "issues" | "kevin" | "free-pay";

function currentBangkokMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}`;
}

function formatHours(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}h`;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "long",
    year: "numeric",
  }).format(new Date(`${month}-01T00:00:00+07:00`));
}

function flagLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: typeof Banknote;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <Card size="sm" className="rounded-lg">
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
        <Icon className={tone === "danger" ? "size-4 text-conflict" : tone === "warn" ? "size-4 text-amber-600" : "size-4 text-primary"} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      </CardContent>
    </Card>
  );
}

function rateSummary(row: PayrollTutorRow): string {
  if (row.rateBuckets.length === 0) return "-";
  return row.rateBuckets
    .map((bucket) => `${formatMoney(bucket.rate)}/h x ${formatHours(bucket.hours)}`)
    .join(", ");
}

export function PayrollDashboard() {
  const [month, setMonth] = useState(currentBangkokMonth);
  const [data, setData] = useState<PayrollPayload | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [notes, setNotes] = useState("");
  const [adjustment, setAdjustment] = useState({
    adjustmentType: "manual",
    tutorCanonicalKey: "",
    tutorDisplayName: "",
    hours: "",
    amount: "",
    description: "",
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (targetMonth = month) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/payroll?month=${encodeURIComponent(targetMonth)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to load payroll");
      setData(payload);
      setNotes(payload.review.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payroll");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  const filteredTutors = useMemo(() => {
    const rows = data?.tutors ?? [];
    if (filter === "issues") return rows.filter((row) => row.flags.length > 0);
    if (filter === "kevin") return rows.filter((row) => row.isKevin);
    if (filter === "free-pay") return rows.filter((row) => row.freePayHours > 0 || row.flags.includes("zero_credit_or_zero_amount"));
    return rows;
  }, [data?.tutors, filter]);

  async function syncPayroll() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/payroll/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Payroll sync failed");
      setData(body.payload);
      setNotes(body.payload.review.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payroll sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function updateReview(status?: "draft" | "approved") {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/payroll/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, status, notes }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Review update failed");
      setData(body.payload);
      setNotes(body.payload.review.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review update failed");
    } finally {
      setSaving(false);
    }
  }

  async function addAdjustment() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/payroll/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          adjustmentType: adjustment.adjustmentType,
          tutorCanonicalKey: adjustment.tutorCanonicalKey || null,
          tutorDisplayName: adjustment.tutorDisplayName || null,
          hours: Number(adjustment.hours || 0),
          amount: Number(adjustment.amount || 0),
          description: adjustment.description,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Adjustment failed");
      setData(body.payload);
      setAdjustment({ adjustmentType: "manual", tutorCanonicalKey: "", tutorDisplayName: "", hours: "", amount: "", description: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteAdjustment(id: string) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/payroll/adjustments/${id}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Delete failed");
      await load(month);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Payroll Review</h1>
          <p className="text-sm text-muted-foreground">{monthLabel(month)} · Wise payout reconciliation</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="h-9 w-40"
          />
          <Button variant="outline" size="sm" onClick={() => void load(month)} disabled={loading || syncing}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => void syncPayroll()} disabled={syncing}>
            <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
            Sync Wise
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-conflict/25 bg-conflict/5 px-4 py-3 text-sm text-conflict">{error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {loading && !data ? (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">Loading payroll data...</div>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <StatCard icon={Banknote} label="Total payout" value={formatMoney(data.summary.totalPayoutAmount)} detail={`${formatHours(data.summary.paidHours)} paid hours`} />
              <StatCard icon={Clock3} label="Utilization" value={formatHours(data.summary.utilizationHours)} detail={`${formatHours(data.summary.varianceHours)} variance`} tone={Math.abs(data.summary.varianceHours) > 1 ? "warn" : "default"} />
              <StatCard icon={UserMinus} label="Kevin hours" value={formatHours(data.summary.kevinHours)} detail={`${formatMoney(data.summary.kevinPayoutAmount)} payout`} />
              <StatCard icon={AlertTriangle} label="Issues" value={String(data.summary.issueCount)} detail={`${data.summary.unresolvedTutorCount} unresolved tutors`} tone={data.summary.issueCount > 0 ? "danger" : "default"} />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <Card className="rounded-lg">
                <CardHeader className="grid-cols-[1fr_auto]">
                  <div>
                    <CardTitle>Monthly reconciliation</CardTitle>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Last sync: {formatDateTime(data.lastSync?.finishedAt ?? data.lastSync?.startedAt)} · {data.lastSync?.invoiceCount ?? 0} invoices · {data.lastSync?.sessionCount ?? 0} sessions
                    </div>
                  </div>
                  <Badge variant={data.review.status === "approved" ? "default" : "outline"}>
                    {data.review.status === "approved" ? "Approved" : "Draft"}
                  </Badge>
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {(["all", "issues", "kevin", "free-pay"] as const).map((value) => (
                      <Button
                        key={value}
                        variant={filter === value ? "default" : "outline"}
                        size="sm"
                        onClick={() => setFilter(value)}
                      >
                        {value === "free-pay" ? "Free-pay" : value[0].toUpperCase() + value.slice(1)}
                      </Button>
                    ))}
                  </div>
                  <div className="max-h-[560px] overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tutor</TableHead>
                          <TableHead>Tier</TableHead>
                          <TableHead className="text-right">Paid</TableHead>
                          <TableHead className="text-right">Util.</TableHead>
                          <TableHead className="text-right">Variance</TableHead>
                          <TableHead className="text-right">Payout</TableHead>
                          <TableHead>Rates</TableHead>
                          <TableHead>Flags</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredTutors.map((row) => (
                          <TableRow key={row.tutorKey}>
                            <TableCell>
                              <div className="font-medium">{row.tutorName}</div>
                              <div className="text-xs text-muted-foreground">{row.invoiceCount} invoices · {row.endedSessionCount} ended sessions</div>
                            </TableCell>
                            <TableCell><Badge variant="secondary">{row.tier}</Badge></TableCell>
                            <TableCell className="text-right font-mono text-xs">{formatHours(row.paidHours)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{formatHours(row.utilizationHours)}</TableCell>
                            <TableCell className={Math.abs(row.varianceHours) > 0.05 ? "text-right font-mono text-xs text-conflict" : "text-right font-mono text-xs"}>
                              {formatHours(row.varianceHours)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">{formatMoney(row.payoutAmount)}</TableCell>
                            <TableCell className="max-w-64 text-xs text-muted-foreground">{rateSummary(row)}</TableCell>
                            <TableCell>
                              <div className="flex max-w-72 flex-wrap gap-1">
                                {row.isKevin ? <Badge variant="outline">Kevin</Badge> : null}
                                {row.freePayHours > 0 ? <Badge variant="outline">Free-pay {formatHours(row.freePayHours)}</Badge> : null}
                                {row.flags.map((flag) => <Badge key={flag} variant="destructive">{flagLabel(flag)}</Badge>)}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle>GM approval</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Review notes" className="min-h-28" />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void updateReview()} disabled={saving}>
                        <Save className="size-4" />
                        Save notes
                      </Button>
                      {data.review.status === "approved" ? (
                        <Button size="sm" variant="outline" onClick={() => void updateReview("draft")} disabled={saving}>
                          Unapprove
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => void updateReview("approved")} disabled={saving || data.summary.issueCount > 0}>
                          <BadgeCheck className="size-4" />
                          Approve
                        </Button>
                      )}
                    </div>
                    {data.review.approvedAt ? (
                      <div className="text-xs text-muted-foreground">Approved {formatDateTime(data.review.approvedAt)} by {data.review.approvedByName ?? data.review.approvedByEmail}</div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle>Adjustments</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Input placeholder="Tutor key" value={adjustment.tutorCanonicalKey} onChange={(event) => setAdjustment((prev) => ({ ...prev, tutorCanonicalKey: event.target.value }))} />
                      <Input placeholder="Tutor name" value={adjustment.tutorDisplayName} onChange={(event) => setAdjustment((prev) => ({ ...prev, tutorDisplayName: event.target.value }))} />
                      <Input type="number" step="0.25" placeholder="Hours" value={adjustment.hours} onChange={(event) => setAdjustment((prev) => ({ ...prev, hours: event.target.value }))} />
                      <Input type="number" step="1" placeholder="Amount" value={adjustment.amount} onChange={(event) => setAdjustment((prev) => ({ ...prev, amount: event.target.value }))} />
                    </div>
                    <Input placeholder="Description" value={adjustment.description} onChange={(event) => setAdjustment((prev) => ({ ...prev, description: event.target.value }))} />
                    <Button size="sm" variant="outline" onClick={() => void addAdjustment()} disabled={saving || !adjustment.description.trim()}>
                      Add adjustment
                    </Button>
                    <div className="space-y-2">
                      {data.adjustments.map((row) => (
                        <div key={row.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                          <div>
                            <div className="font-medium">{row.description}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.tutorDisplayName ?? row.tutorCanonicalKey ?? "General"} · {formatHours(row.hours)} · {formatMoney(row.amount)}
                            </div>
                          </div>
                          <Button size="icon-sm" variant="ghost" onClick={() => void deleteAdjustment(row.id)} disabled={saving} aria-label="Delete adjustment">
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <Tabs defaultValue="aggregate">
              <div className="flex items-center justify-between gap-3">
                <TabsList>
                  <TabsTrigger value="aggregate"><Download className="size-4" /> Aggregate</TabsTrigger>
                  <TabsTrigger value="long"><FileText className="size-4" /> Long</TabsTrigger>
                  <TabsTrigger value="issues"><AlertTriangle className="size-4" /> Issues</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="aggregate" className="mt-3 rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tutor</TableHead>
                      <TableHead className="text-right">Hours</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tutors.map((row) => (
                      <TableRow key={row.tutorKey}>
                        <TableCell>{row.tier}: {row.tutorName}</TableCell>
                        <TableCell className="text-right">{formatHours(row.paidHours)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.payoutAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
              <TabsContent value="long" className="mt-3 rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tutor</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Income</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tutors.map((row) => (
                      <TableRow key={row.tutorKey}>
                        <TableCell>{row.tier}: {row.tutorName}</TableCell>
                        <TableCell>{row.invoiceCount} payout invoices · {rateSummary(row)}</TableCell>
                        <TableCell className="text-right">{formatMoney(row.payoutAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
              <TabsContent value="issues" className="mt-3 rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Tutor</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.issues.map((issue, index) => (
                      <TableRow key={`${issue.type}-${issue.transactionId ?? issue.wiseSessionId ?? index}`}>
                        <TableCell><Badge variant={issue.severity === "high" ? "destructive" : "secondary"}>{issue.severity}</Badge></TableCell>
                        <TableCell>{flagLabel(issue.type)}</TableCell>
                        <TableCell>{issue.tutorName}</TableCell>
                        <TableCell>{issue.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
            </Tabs>
          </div>
        ) : null}
      </div>
    </div>
  );
}
