"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ClipboardList,
  DollarSign,
  ExternalLink,
  Globe2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  CompetitorDashboardPayload,
  CompetitorSourceStatus,
  CompetitorTaskStatus,
} from "@/lib/competitor-intelligence/types";

type BusyAction = "load" | "sync" | "evidence" | `source:${string}` | `task:${string}` | `suggestion:${string}` | "";

interface EvidenceForm {
  entityId: string;
  title: string;
  contentText: string;
  canonicalUrl: string;
  pricingSignal: boolean;
}

interface OwnSourceForm {
  id: string;
  sourceType: "website" | "instagram" | "facebook";
  label: string;
  url: string;
  handle: string;
  status: CompetitorSourceStatus;
}

const SOURCE_STATUSES: CompetitorSourceStatus[] = ["active", "disabled", "needs_review", "archived"];
const TASK_STATUSES: CompetitorTaskStatus[] = ["todo", "in_progress", "blocked", "done", "ignored"];
const OWN_SOURCE_TYPES: OwnSourceForm["sourceType"][] = ["website", "instagram", "facebook"];

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date(value));
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function scoreTone(value: number): string {
  if (value >= 80) return "text-emerald-700 dark:text-emerald-300";
  if (value >= 50) return "text-amber-700 dark:text-amber-300";
  return "text-destructive";
}

function badgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active" || status === "success" || status === "done") return "default";
  if (status === "failed" || status === "blocked" || status === "archived") return "destructive";
  if (status === "disabled" || status === "ignored") return "secondary";
  return "outline";
}

function compact(value: string | null | undefined, max = 120): string {
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function trendLabel(value: "up" | "down" | "flat"): string {
  if (value === "up") return "Up";
  if (value === "down") return "Down";
  return "Flat";
}

function sourceHealthSummary(value: Record<string, unknown>): string {
  const active = typeof value.active === "number" ? value.active : null;
  const healthy = typeof value.healthy === "number" ? value.healthy : null;
  if (active === null || healthy === null) return "No source health captured";
  return `${healthy}/${active} active sources healthy`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

function KpiCard({ icon: Icon, label, value, detail }: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card size="sm">
      <CardHeader className="grid-cols-[auto_1fr] gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div>
          <CardTitle className="text-sm">{label}</CardTitle>
          <p className="text-2xl font-semibold leading-tight">{value}</p>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function SelectMenu<T extends string>({ value, values, disabled, onChange, label }: {
  value: T;
  values: T[];
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
    >
      {values.map((item) => (
        <option key={item} value={item}>{item.replace(/_/g, " ")}</option>
      ))}
    </select>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
      {title}
    </div>
  );
}

export function CompetitorIntelligenceSkeleton() {
  return (
    <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
      <div className="h-10 w-72 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </main>
  );
}

export function CompetitorIntelligenceDashboard() {
  const [data, setData] = useState<CompetitorDashboardPayload | null>(null);
  const [busy, setBusy] = useState<BusyAction>("load");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [evidence, setEvidence] = useState<EvidenceForm>({
    entityId: "",
    title: "",
    contentText: "",
    canonicalUrl: "",
    pricingSignal: false,
  });
  const [ownSource, setOwnSource] = useState<OwnSourceForm>({
    id: "",
    sourceType: "website",
    label: "",
    url: "",
    handle: "",
    status: "active",
  });

  const pricingItems = useMemo(
    () => data?.recentItems.filter((item) => item.pricingSignal || item.category === "pricing_offer") ?? [],
    [data],
  );
  const activeCompetitors = useMemo(
    () => data?.entities.filter((entity) => entity.active) ?? [],
    [data],
  );
  const selectedMatrixRow = useMemo(() => {
    if (!data) return null;
    return data.competitorMatrix.find((row) => row.entityId === selectedEntityId) ?? data.competitorMatrix[0] ?? null;
  }, [data, selectedEntityId]);
  const selectedDrilldown = selectedMatrixRow && data ? data.scoreDrilldowns[selectedMatrixRow.entityId] : null;
  const topCompetitor = data?.competitorMatrix.find((row) => row.kind === "competitor") ?? null;
  const gapCount = data?.competitorMatrix.filter((row) => row.kind === "competitor" && !row.beGiftedGap.startsWith("No major")).length ?? 0;
  const averageCadence = data?.competitorMatrix.length
    ? data.competitorMatrix.reduce((sum, row) => sum + row.cadencePerWeek, 0) / data.competitorMatrix.length
    : 0;

  async function load() {
    setError("");
    try {
      const payload = await requestJson<CompetitorDashboardPayload>("/api/competitor-intelligence");
      setData(payload);
      setSelectedEntityId((current) => current || payload.competitorMatrix[0]?.entityId || "");
      setEvidence((current) => ({
        ...current,
        entityId: current.entityId || payload.entities.find((entity) => entity.kind === "competitor")?.id || "",
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load competitor intelligence");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function runAction(action: BusyAction, callback: () => Promise<string | void>) {
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const nextMessage = await callback();
      if (nextMessage) setMessage(nextMessage);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Request failed");
    } finally {
      setBusy("");
    }
  }

  async function runSync() {
    await runAction("sync", async () => {
      const payload = await requestJson<{ result?: { newItemCount?: number; sourceFailedCount?: number } }>("/api/competitor-intelligence/sync", {
        method: "POST",
        body: JSON.stringify({}),
      });
      return `Sync finished: ${payload.result?.newItemCount ?? 0} new signals, ${payload.result?.sourceFailedCount ?? 0} failed sources.`;
    });
  }

  async function updateSource(sourceId: string, status: CompetitorSourceStatus) {
    await runAction(`source:${sourceId}`, async () => {
      await requestJson(`/api/competitor-intelligence/sources/${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      return "Source updated.";
    });
  }

  async function acceptSuggestion(suggestionId: string) {
    await runAction(`suggestion:${suggestionId}`, async () => {
      await requestJson(`/api/competitor-intelligence/task-suggestions/${suggestionId}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return "Task accepted.";
    });
  }

  async function acceptContentAngle(suggestionId: string | null) {
    if (!suggestionId) return;
    await acceptSuggestion(suggestionId);
  }

  async function updateTask(taskId: string, status: CompetitorTaskStatus) {
    await runAction(`task:${taskId}`, async () => {
      await requestJson(`/api/competitor-intelligence/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      return "Task updated.";
    });
  }

  async function createEvidence() {
    if (!evidence.entityId) return;
    await runAction("evidence", async () => {
      await requestJson("/api/competitor-intelligence/manual-evidence", {
        method: "POST",
        body: JSON.stringify({
          entityId: evidence.entityId,
          title: evidence.title,
          contentText: evidence.contentText,
          canonicalUrl: evidence.canonicalUrl || null,
          pricingSignal: evidence.pricingSignal,
        }),
      });
      setEvidence((current) => ({
        ...current,
        title: "",
        contentText: "",
        canonicalUrl: "",
        pricingSignal: false,
      }));
      return "Evidence saved.";
    });
  }

  function resetOwnSourceForm() {
    setOwnSource({
      id: "",
      sourceType: "website",
      label: "",
      url: "",
      handle: "",
      status: "active",
    });
  }

  async function saveOwnSource() {
    await runAction("source:own-brand", async () => {
      const body = JSON.stringify({
        sourceType: ownSource.sourceType,
        label: ownSource.label,
        url: ownSource.url,
        handle: ownSource.handle || null,
        status: ownSource.status,
      });
      await requestJson(
        ownSource.id
          ? `/api/competitor-intelligence/own-sources/${ownSource.id}`
          : "/api/competitor-intelligence/own-sources",
        {
          method: ownSource.id ? "PATCH" : "POST",
          body,
        },
      );
      resetOwnSourceForm();
      return ownSource.id ? "BeGifted source updated." : "BeGifted source added.";
    });
  }

  async function disableOwnSource(source: CompetitorDashboardPayload["ownBrandSources"][number]) {
    await runAction(`source:${source.id}`, async () => {
      await requestJson(`/api/competitor-intelligence/own-sources/${source.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          sourceType: source.sourceType,
          label: source.label,
          url: source.url,
          handle: source.handle,
          status: "disabled",
        }),
      });
      return "BeGifted source disabled.";
    });
  }

  if (busy === "load" && !data) return <CompetitorIntelligenceSkeleton />;
  if (!data) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <EmptyState title={error || "Competitor intelligence is unavailable."} />
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background p-4 text-foreground md:p-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Competitor Intelligence</h1>
            <p className="text-sm text-muted-foreground">
              Checked {formatDateTime(data.checkedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={!!busy}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Button onClick={() => void runSync()} disabled={!!busy}>
              {busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
              Run Sync
            </Button>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-lg border border-emerald-600/20 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
            {message}
          </div>
        )}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,0.8fr)]">
          <Card>
            <CardHeader className="border-b">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Weekly War Room</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {data.weeklyWarRoom.weekStart} to {data.weeklyWarRoom.weekEnd} · 90-day lookback from {data.weeklyWarRoom.lookbackStart}
                  </p>
                </div>
                <Badge variant={data.weeklyWarRoom.status === "ready" ? "default" : "outline"}>
                  {data.weeklyWarRoom.status.replace(/_/g, " ")}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 py-4">
              <p className="text-sm leading-6 text-muted-foreground">{data.weeklyWarRoom.executiveSummary}</p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  icon={Target}
                  label="Top Attention"
                  value={topCompetitor ? String(topCompetitor.attentionScore) : "-"}
                  detail={topCompetitor ? topCompetitor.displayName : "No competitor matrix yet"}
                />
                <KpiCard
                  icon={Activity}
                  label="Posting Velocity"
                  value={averageCadence ? averageCadence.toFixed(1) : "-"}
                  detail="Average captured signals per week"
                />
                <KpiCard
                  icon={Globe2}
                  label="Channel Coverage"
                  value={percent(data.kpis.coveragePercent)}
                  detail={sourceHealthSummary(data.weeklyWarRoom.sourceHealth)}
                />
                <KpiCard
                  icon={ShieldAlert}
                  label="BeGifted Gaps"
                  value={String(gapCount)}
                  detail="Competitors with a visible baseline gap"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>War Room Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 py-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className={`text-2xl font-semibold ${scoreTone(data.weeklyWarRoom.confidence * 100)}`}>{percent(data.weeklyWarRoom.confidence * 100)}</p>
                  <p className="text-xs text-muted-foreground">Confidence</p>
                </div>
                <div>
                  <p className={`text-2xl font-semibold ${scoreTone(data.kpis.seoVisibilityScore)}`}>{data.kpis.seoVisibilityScore}</p>
                  <p className="text-xs text-muted-foreground">SEO</p>
                </div>
                <div>
                  <p className={`text-2xl font-semibold ${scoreTone(100 - data.kpis.budgetUsedPercent)}`}>{percent(data.kpis.budgetUsedPercent)}</p>
                  <p className="text-xs text-muted-foreground">Budget</p>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="text-muted-foreground">{sourceHealthSummary(data.weeklyWarRoom.sourceHealth)}</span>
                </div>
                <div className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="text-muted-foreground">{data.contentAngles.length} content angles waiting for review</span>
                </div>
                <div className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="text-muted-foreground">{data.kpis.openTaskCount} accepted response tasks open</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.85fr)]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Competitor Matrix</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.competitorMatrix.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Brand</TableHead>
                      <TableHead>Attention</TableHead>
                      <TableHead>Cadence</TableHead>
                      <TableHead>Channels</TableHead>
                      <TableHead>Burst</TableHead>
                      <TableHead>Theme</TableHead>
                      <TableHead>BeGifted Gap</TableHead>
                      <TableHead>Recommended Angle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.competitorMatrix.map((row) => (
                      <TableRow
                        key={row.entityId}
                        className={row.entityId === selectedMatrixRow?.entityId ? "bg-muted/50" : "cursor-pointer"}
                        onClick={() => setSelectedEntityId(row.entityId)}
                      >
                        <TableCell>
                          <div className="font-medium">{row.displayName}</div>
                          <div className="text-xs text-muted-foreground">{row.kind === "own_brand" ? "Own baseline" : row.categoryTags.slice(0, 2).join(", ")}</div>
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            className="text-left text-lg font-semibold text-primary hover:underline"
                            onClick={() => setSelectedEntityId(row.entityId)}
                          >
                            {row.attentionScore}
                          </button>
                        </TableCell>
                        <TableCell>{row.cadencePerWeek.toFixed(1)}/wk · {trendLabel(row.cadenceTrend)}</TableCell>
                        <TableCell className="max-w-44">
                          <div className="flex flex-wrap gap-1">
                            {row.activeChannels.length ? row.activeChannels.map((channel) => (
                              <Badge key={channel} variant="outline">{channel}</Badge>
                            )) : <span className="text-muted-foreground">No signals</span>}
                          </div>
                        </TableCell>
                        <TableCell>{row.burstLabel}</TableCell>
                        <TableCell>{row.topTheme}</TableCell>
                        <TableCell className="min-w-64 whitespace-normal text-muted-foreground">{row.beGiftedGap}</TableCell>
                        <TableCell className="min-w-72 whitespace-normal">{row.recommendedAngle}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <div className="p-4"><EmptyState title="No War Room matrix yet. Run sync after adding BeGifted and competitor sources." /></div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>{selectedMatrixRow ? `${selectedMatrixRow.displayName} Score Drilldown` : "Score Drilldown"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 py-4">
              {selectedMatrixRow && selectedDrilldown ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    {Object.entries(selectedMatrixRow.scoreComponents).map(([label, value]) => (
                      <div key={label} className="rounded-lg border p-2">
                        <div className="text-lg font-semibold">{value}</div>
                        <div className="text-xs text-muted-foreground capitalize">{label}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{selectedDrilldown.formula}</p>
                  <div className="space-y-3">
                    {selectedDrilldown.weeklyTimeline.slice(0, 5).map((week) => (
                      <div key={week.weekStart} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="font-medium">{week.weekStart}</span>
                          <Badge variant="outline">{week.activityCount} signals</Badge>
                        </div>
                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {week.topEvidence.slice(0, 3).map((item) => (
                            <div key={item.itemId} className="flex items-start justify-between gap-2">
                              <span>{item.channel}: {compact(item.title, 70)}</span>
                              <span>{item.impactScore.toFixed(1)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : <EmptyState title="Select a matrix row to inspect score evidence." />}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Content Angles</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 py-4">
              {data.contentAngles.length ? data.contentAngles.slice(0, 5).map((angle) => (
                <div key={angle.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{angle.title}</div>
                      <div className="mt-1 text-sm text-muted-foreground">{angle.rationale}</div>
                    </div>
                    <Badge variant="outline">{Math.round(angle.confidence * 100)}%</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">{angle.suggestedChannel}</Badge>
                    <span>{angle.competitorName ?? "General"}</span>
                    <span>{angle.status.replace(/_/g, " ")}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">CTA: {angle.cta}</p>
                  <Button
                    className="mt-3"
                    size="sm"
                    onClick={() => void acceptContentAngle(angle.suggestionId)}
                    disabled={!!busy || !angle.suggestionId || angle.status !== "suggested"}
                  >
                    {busy === `suggestion:${angle.suggestionId}` ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                    Accept
                  </Button>
                </div>
              )) : <EmptyState title="No content angles generated yet." />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>SEO And Offers Context</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 py-4 text-sm">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">SEO visibility</span>
                <span className="font-semibold">{data.kpis.seoVisibilityScore}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">Pricing / offer signals</span>
                <span className="font-semibold">{pricingItems.length}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-muted-foreground">High-impact moves</span>
                <span className="font-semibold">{data.kpis.highImpactMoves}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>Accepted Tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 py-4">
              {data.tasks.length ? data.tasks.slice(0, 5).map((task) => (
                <div key={task.id} className="rounded-lg border p-3 text-sm">
                  <div className="font-medium">{task.title}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant={badgeVariant(task.status)}>{task.status.replace(/_/g, " ")}</Badge>
                    <span>{task.ownerEmail ?? "Unassigned"}</span>
                  </div>
                </div>
              )) : <EmptyState title="No accepted tasks yet." />}
            </CardContent>
          </Card>
        </section>

        <Tabs defaultValue="activity" className="gap-3">
          <TabsList variant="line" className="max-w-full flex-wrap justify-start border-b pb-1">
            <TabsTrigger value="activity" className="px-2.5"><Activity className="size-4" /> Activity</TabsTrigger>
            <TabsTrigger value="seo" className="px-2.5"><Search className="size-4" /> SEO</TabsTrigger>
            <TabsTrigger value="pricing" className="px-2.5"><Target className="size-4" /> Pricing</TabsTrigger>
            <TabsTrigger value="sources" className="px-2.5"><Globe2 className="size-4" /> Sources</TabsTrigger>
            <TabsTrigger value="tasks" className="px-2.5"><ClipboardList className="size-4" /> Tasks</TabsTrigger>
            <TabsTrigger value="costs" className="px-2.5"><DollarSign className="size-4" /> Costs</TabsTrigger>
          </TabsList>

          <TabsContent value="activity">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>Activity Feed</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.recentItems.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Competitor</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>Signal</TableHead>
                        <TableHead>Impact</TableHead>
                        <TableHead>Observed</TableHead>
                        <TableHead>Evidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recentItems.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.entityName}</TableCell>
                          <TableCell><Badge variant="outline">{item.channel}</Badge></TableCell>
                          <TableCell className="min-w-80 whitespace-normal">
                            <div className="font-medium">{item.title}</div>
                            <div className="text-muted-foreground">{compact(item.summary, 180)}</div>
                          </TableCell>
                          <TableCell>{item.impactScore.toFixed(1)}</TableCell>
                          <TableCell>{formatDateTime(item.observedAt)}</TableCell>
                          <TableCell>
                            {item.canonicalUrl ? (
                              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={item.canonicalUrl} target="_blank" rel="noreferrer">
                                Source <ExternalLink className="size-3" />
                              </a>
                            ) : `${item.assetCount} media`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : <div className="p-4"><EmptyState title="No activity captured yet." /></div>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="seo">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>SEO Rank Matrix</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.serp.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keyword</TableHead>
                        <TableHead>Language</TableHead>
                        <TableHead>Device</TableHead>
                        <TableHead>BeGifted</TableHead>
                        <TableHead>Best Competitor</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Observed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.serp.map((row) => (
                        <TableRow key={`${row.keyword}-${row.language}-${row.device}`}>
                          <TableCell className="font-medium">{row.keyword}</TableCell>
                          <TableCell>{row.language.toUpperCase()}</TableCell>
                          <TableCell>{row.device}</TableCell>
                          <TableCell>{row.bestBeGiftedRank ?? "-"}</TableCell>
                          <TableCell>{row.bestCompetitorRank ?? "-"}</TableCell>
                          <TableCell><Badge variant={badgeVariant(row.status)}>{row.status.replace(/_/g, " ")}</Badge></TableCell>
                          <TableCell>{formatDateTime(row.latestObservedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : <div className="p-4"><EmptyState title="No SERP observations yet." /></div>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="pricing">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Pricing And Offer Evidence</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {pricingItems.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Competitor</TableHead>
                          <TableHead>Evidence</TableHead>
                          <TableHead>Impact</TableHead>
                          <TableHead>Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pricingItems.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell>{item.entityName}</TableCell>
                            <TableCell className="min-w-80 whitespace-normal">
                              <div className="font-medium">{item.title}</div>
                              <div className="text-muted-foreground">{compact(item.summary, 200)}</div>
                            </TableCell>
                            <TableCell>{item.impactScore.toFixed(1)}</TableCell>
                            <TableCell>
                              {item.canonicalUrl ? (
                                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={item.canonicalUrl} target="_blank" rel="noreferrer">
                                  Evidence <ExternalLink className="size-3" />
                                </a>
                              ) : `${item.assetCount} attachments`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : <div className="p-4"><EmptyState title="No pricing evidence yet." /></div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Manual Evidence</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 py-4">
                  <select
                    aria-label="Competitor"
                    value={evidence.entityId}
                    onChange={(event) => setEvidence((current) => ({ ...current, entityId: event.target.value }))}
                    className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {activeCompetitors.map((entity) => (
                      <option key={entity.id} value={entity.id}>{entity.displayName}</option>
                    ))}
                  </select>
                  <Input
                    value={evidence.title}
                    placeholder="Evidence title"
                    onChange={(event) => setEvidence((current) => ({ ...current, title: event.target.value }))}
                  />
                  <Input
                    value={evidence.canonicalUrl}
                    placeholder="Source URL"
                    onChange={(event) => setEvidence((current) => ({ ...current, canonicalUrl: event.target.value }))}
                  />
                  <Textarea
                    value={evidence.contentText}
                    placeholder="Evidence note"
                    onChange={(event) => setEvidence((current) => ({ ...current, contentText: event.target.value }))}
                    className="min-h-28"
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={evidence.pricingSignal}
                      onChange={(event) => setEvidence((current) => ({ ...current, pricingSignal: event.target.checked }))}
                    />
                    Pricing signal
                  </label>
                  <Button onClick={() => void createEvidence()} disabled={!!busy || !evidence.title || !evidence.contentText || !evidence.entityId}>
                    {busy === "evidence" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    Add Evidence
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="sources">
            <div className="grid gap-4">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>BeGifted Own-Brand Sources</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 py-4 xl:grid-cols-[420px_minmax(0,1fr)]">
                  <div className="space-y-3">
                    <SelectMenu
                      label="Own source type"
                      value={ownSource.sourceType}
                      values={OWN_SOURCE_TYPES}
                      disabled={!!busy}
                      onChange={(sourceType) => setOwnSource((current) => ({ ...current, sourceType }))}
                    />
                    <Input
                      value={ownSource.label}
                      placeholder="Label, e.g. BeGifted Instagram"
                      onChange={(event) => setOwnSource((current) => ({ ...current, label: event.target.value }))}
                    />
                    <Input
                      value={ownSource.url}
                      placeholder="https://..."
                      onChange={(event) => setOwnSource((current) => ({ ...current, url: event.target.value }))}
                    />
                    <Input
                      value={ownSource.handle}
                      placeholder="Handle (optional)"
                      onChange={(event) => setOwnSource((current) => ({ ...current, handle: event.target.value }))}
                    />
                    <SelectMenu
                      label="Own source status"
                      value={ownSource.status}
                      values={SOURCE_STATUSES}
                      disabled={!!busy}
                      onChange={(status) => setOwnSource((current) => ({ ...current, status }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => void saveOwnSource()} disabled={!!busy || !ownSource.label || !ownSource.url}>
                        {busy === "source:own-brand" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                        {ownSource.id ? "Update Source" : "Add Source"}
                      </Button>
                      {ownSource.id && (
                        <Button variant="outline" onClick={resetOwnSourceForm} disabled={!!busy}>
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {data.ownBrandSources.length ? data.ownBrandSources.map((source) => (
                      <div key={source.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                        <div>
                          <div className="font-medium">{source.label}</div>
                          <div className="text-sm text-muted-foreground">{source.sourceType} · {source.url}</div>
                          {source.lastError && <div className="text-sm text-destructive">{compact(source.lastError, 160)}</div>}
                        </div>
                        <div className="flex gap-2">
                          <Badge variant={badgeVariant(source.status)}>{source.status.replace(/_/g, " ")}</Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setOwnSource({
                              id: source.id,
                              sourceType: source.sourceType,
                              label: source.label,
                              url: source.url,
                              handle: source.handle ?? "",
                              status: source.status,
                            })}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void disableOwnSource(source)}
                            disabled={!!busy || source.status === "disabled"}
                          >
                            Disable
                          </Button>
                        </div>
                      </div>
                    )) : <EmptyState title="No BeGifted website/social sources configured yet." />}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Competitors And Sources</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Competitor</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Reliability</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last Success</TableHead>
                        <TableHead>Health</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.sources.map((source) => (
                        <TableRow key={source.id}>
                          <TableCell>{source.entityName}</TableCell>
                          <TableCell><Badge variant="outline">{source.sourceType}</Badge></TableCell>
                          <TableCell className="max-w-72 truncate">
                            <a className="text-primary hover:underline" href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                          </TableCell>
                          <TableCell>{source.reliability}</TableCell>
                          <TableCell>
                            <SelectMenu
                              label={`${source.label} status`}
                              value={source.status}
                              values={SOURCE_STATUSES}
                              disabled={!!busy}
                              onChange={(status) => void updateSource(source.id, status)}
                            />
                          </TableCell>
                          <TableCell>{formatDateTime(source.lastSuccessAt)}</TableCell>
                          <TableCell className="max-w-80 whitespace-normal">
                            {source.lastError ? (
                              <span className="text-destructive">{compact(source.lastError, 180)}</span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-300">Healthy</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="tasks">
            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>AI Suggested Tasks</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 py-4">
                  {data.taskSuggestions.length ? data.taskSuggestions.map((suggestion) => (
                    <div key={suggestion.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-medium">{suggestion.title}</div>
                          <div className="text-sm text-muted-foreground">{suggestion.description}</div>
                        </div>
                        <Badge variant={suggestion.priority === "high" ? "destructive" : "outline"}>{suggestion.priority}</Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{suggestion.competitorName ?? "General"}</span>
                        <span>{Math.round(suggestion.confidence * 100)}% confidence</span>
                        {suggestion.labels.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
                      </div>
                      <Button
                        className="mt-3"
                        size="sm"
                        onClick={() => void acceptSuggestion(suggestion.id)}
                        disabled={!!busy}
                      >
                        {busy === `suggestion:${suggestion.id}` ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                        Accept
                      </Button>
                    </div>
                  )) : <EmptyState title="No open AI suggestions." />}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Active Tasks</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 py-4">
                  {data.tasks.length ? data.tasks.map((task) => (
                    <div key={task.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-medium">{task.title}</div>
                          <div className="text-sm text-muted-foreground">{task.description}</div>
                        </div>
                        <SelectMenu
                          label={`${task.title} status`}
                          value={task.status}
                          values={TASK_STATUSES}
                          disabled={!!busy}
                          onChange={(status) => void updateTask(task.id, status)}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant={badgeVariant(task.priority)}>{task.priority}</Badge>
                        <span>{task.ownerEmail ?? "Unassigned"}</span>
                        <span>{task.dueDate ?? "No due date"}</span>
                        <span>{task.competitorName ?? "General"}</span>
                      </div>
                    </div>
                  )) : <EmptyState title="No accepted tasks." />}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="costs">
            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Vendor Usage</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {data.usage.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Month</TableHead>
                          <TableHead>Provider</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Units</TableHead>
                          <TableHead>Cost</TableHead>
                          <TableHead>Cap</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.usage.map((row) => (
                          <TableRow key={`${row.usageMonth}-${row.provider}-${row.sourceType}`}>
                            <TableCell>{row.usageMonth}</TableCell>
                            <TableCell>{row.provider}</TableCell>
                            <TableCell>{row.sourceType}</TableCell>
                            <TableCell>{row.usageUnits.toFixed(0)}</TableCell>
                            <TableCell>${row.estimatedCostUsd.toFixed(2)}</TableCell>
                            <TableCell>
                              <Badge variant={row.capped ? "destructive" : "outline"}>${row.hardCapUsd.toFixed(2)}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : <div className="p-4"><EmptyState title="No vendor usage recorded." /></div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle>Recent Runs</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {data.runs.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>Trigger</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Sources</TableHead>
                          <TableHead>Signals</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.runs.map((run) => (
                          <TableRow key={run.id}>
                            <TableCell><Badge variant={badgeVariant(run.status)}>{run.status}</Badge></TableCell>
                            <TableCell>{run.triggerType}</TableCell>
                            <TableCell>{formatDateTime(run.startedAt)}</TableCell>
                            <TableCell>{run.sourceSuccessCount}/{run.sourceCount}</TableCell>
                            <TableCell>{run.newItemCount} new</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : <div className="p-4"><EmptyState title="No sync runs yet." /></div>}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
