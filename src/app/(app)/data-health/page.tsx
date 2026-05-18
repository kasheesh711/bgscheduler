"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { isApiSnapshotStale } from "@/lib/ops/stale";

interface HealthData {
  lastSuccessfulSync: string | null;
  lastFailedSync: string | null;
  lastFailureError: string | null;
  staleAgeMs: number | null;
  staleMinutes: number | null;
  activeSnapshotId: string | null;
  stats: {
    totalWiseTeachers: number;
    totalIdentityGroups: number;
    resolvedGroups: number;
    unresolvedGroups: number;
    totalDataIssues: number;
  } | null;
  issuesByType: Record<string, number>;
  unresolvedAliases: { entityName: string; message: string }[];
  // MOD-03 / D-10: modality issues now include both legacy group-level
  // `modality` issues and session-level `conflict_model` issues. The
  // `issueType` field lets the UI distinguish "group" from "session" rows.
  unresolvedModality: {
    entityName: string;
    message: string;
    issueType: string; // "modality" | "conflict_model"
  }[];
  unmappedTags: { entityName: string; message: string }[];
  recentSyncs: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    teacherCount: number | null;
    errorSummary: string | null;
  }[];
}

/** Shimmer skeleton matching the DataHealthPage card layout. */
function DataHealthSkeleton() {
  return (
    <div className="space-y-6">
      {/* Sync status cards */}
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-xl border bg-card p-6 space-y-3">
            <div className="h-3 w-32 bg-muted animate-pulse rounded" />
            <div className="h-6 w-24 bg-muted animate-pulse rounded" />
          </div>
        ))}
      </div>
      {/* Stats cards */}
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="rounded-xl border bg-card p-6 space-y-3">
            <div className="h-3 w-20 bg-muted animate-pulse rounded" />
            <div className="h-8 w-12 bg-muted animate-pulse rounded" />
          </div>
        ))}
      </div>
      {/* Table placeholder */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="h-5 w-40 bg-muted animate-pulse rounded" />
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-4 bg-muted/50 animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DataHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const loadHealthData = useCallback(async ({ showLoading = false } = {}): Promise<HealthData | null> => {
    if (showLoading) setLoading(true);

    try {
      const response = await fetch("/api/data-health");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const healthData = (await response.json()) as HealthData;
      setData(healthData);
      return healthData;
    } catch (err) {
      console.error(err);
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHealthData({ showLoading: true });
  }, [loadHealthData]);

  async function handleSyncNow() {
    if (syncing) return;

    const confirmed = window.confirm(
      "Sync can take several minutes and will contact Wise heavily. Start sync now?",
    );

    if (!confirmed) return;

    setSyncing(true);
    setSyncMessage(null);
    const startedAtMs = Date.now();
    let refreshed = false;

    const completedAfterStart = (healthData: HealthData | null) => {
      const lastSuccess = healthData?.lastSuccessfulSync;
      if (!lastSuccess) return false;
      return new Date(lastSuccess).getTime() >= startedAtMs - 30_000;
    };

    try {
      const response = await fetch("/api/admin/sync-wise", { method: "POST" });
      let body: {
        error?: string;
        errorSummary?: string | null;
        skipped?: boolean;
        alreadyRunning?: boolean;
        message?: string;
      } = {};
      const text = await response.text();

      try {
        body = text ? JSON.parse(text) as typeof body : {};
      } catch {
        body = {};
      }

      if (response.ok) {
        if (body.skipped && body.alreadyRunning) {
          setSyncMessage(body.message ?? "Wise sync is already running. Data will refresh when that run finishes.");
        } else {
          setSyncMessage("Sync completed successfully.");
        }
      } else {
        const healthData = await loadHealthData();
        refreshed = true;
        if (completedAfterStart(healthData)) {
          setSyncMessage("Sync completed successfully. The browser request ended before the final response was received.");
        } else {
          const fallback = `HTTP ${response.status}${text && !body.error && !body.errorSummary ? `: ${text.slice(0, 160)}` : ""}`;
          setSyncMessage(`Sync failed: ${body.errorSummary || body.error || fallback}`);
        }
      }
    } catch (err) {
      const healthData = await loadHealthData();
      refreshed = true;
      if (completedAfterStart(healthData)) {
        setSyncMessage("Sync completed successfully. The browser request ended before the final response was received.");
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        setSyncMessage(`Sync failed: ${message}`);
      }
    } finally {
      if (!refreshed) await loadHealthData();
      setSyncing(false);
    }
  }

  if (loading) return <DataHealthSkeleton />;
  if (!data) return (
    <div className="py-12 text-center space-y-2">
      <p className="text-muted-foreground">Failed to load health data.</p>
      <p className="text-sm text-muted-foreground">Refresh the page to try again.</p>
    </div>
  );

  const isSnapshotStale = data.staleAgeMs !== null && isApiSnapshotStale(data.staleAgeMs);
  const staleMinutes =
    data.staleMinutes ?? (data.staleAgeMs === null ? null : Math.round(data.staleAgeMs / 60000));

  return (
    <div className="space-y-6">
      {/* Sync status */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last Successful Sync
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {data.lastSuccessfulSync
                ? formatBangkokDateTime(data.lastSuccessfulSync)
                : "Never"}
            </p>
            {isSnapshotStale && staleMinutes !== null && (
              <Badge variant="destructive" className="mt-1">
                Stale ({staleMinutes}m ago)
              </Badge>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Button size="sm" onClick={handleSyncNow} disabled={syncing}>
                {syncing ? "Syncing..." : "Sync now"}
              </Button>
            </div>
            {syncMessage && (
              <p
                className={`mt-2 text-sm ${
                  syncMessage.startsWith("Sync failed:")
                    ? "text-destructive"
                    : "text-available"
                }`}
              >
                {syncMessage}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Snapshot
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold font-mono">
              {data.activeSnapshotId?.slice(0, 8) ?? "None"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last Failed Sync
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {data.lastFailedSync
                ? formatBangkokDateTime(data.lastFailedSync)
                : "None"}
            </p>
            {data.lastFailureError && (
              <p className="text-xs text-destructive mt-1 truncate">{data.lastFailureError}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stats */}
      {data.stats && (
        <div className="grid grid-cols-5 gap-4">
          {[
            { label: "Wise Teachers", value: data.stats.totalWiseTeachers },
            { label: "Identity Groups", value: data.stats.totalIdentityGroups },
            { label: "Resolved", value: data.stats.resolvedGroups },
            { label: "Unresolved", value: data.stats.unresolvedGroups },
            { label: "Total Issues", value: data.stats.totalDataIssues },
          ].map((s) => (
            <Card key={s.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {s.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Issues by type */}
      {Object.keys(data.issuesByType).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Issues by Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4">
              {Object.entries(data.issuesByType).map(([type, count]) => (
                <Badge key={type} variant="outline" className="text-sm">
                  {type}: {count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Unresolved aliases */}
      {data.unresolvedAliases.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Unresolved Aliases ({data.unresolvedAliases.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Teacher</TableHead>
                  <TableHead>Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unresolvedAliases.map((a, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{a.entityName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{a.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Modality issues — MOD-03 / D-10: combined group-level + session-level counter */}
      {data.unresolvedModality.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle
              title="Includes unresolved group modality + per-session signal contradictions"
            >
              Modality issues ({data.unresolvedModality.length})
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Includes unresolved group modality + per-session signal contradictions.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Note: Post-MOD-01 deploy, this counter is expected to rise as session-level contradictions are now surfaced. The rise is surface-of-reality, not a regression.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Group / Session</TableHead>
                  <TableHead>Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unresolvedModality.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">
                      {m.entityName}
                      <span
                        className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground align-middle"
                        title={
                          m.issueType === "conflict_model"
                            ? "Session-level signal contradiction (conflict_model)"
                            : "Group-level unresolved modality"
                        }
                      >
                        {m.issueType === "conflict_model" ? "session" : "group"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{m.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Unmapped tags */}
      {data.unmappedTags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Unmapped Tags ({data.unmappedTags.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Teacher</TableHead>
                  <TableHead>Tag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unmappedTags.slice(0, 50).map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{t.entityName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent syncs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sync History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Teachers</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentSyncs.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === "success"
                          ? "default"
                          : s.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatBangkokDateTime(s.startedAt)}</TableCell>
                  <TableCell>
                    {s.finishedAt ? formatBangkokDateTime(s.finishedAt) : "-"}
                  </TableCell>
                  <TableCell>{s.teacherCount ?? "-"}</TableCell>
                  <TableCell className="text-xs text-destructive max-w-xs truncate">
                    {s.errorSummary ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
