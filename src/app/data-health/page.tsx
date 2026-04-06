"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface HealthData {
  lastSuccessfulSync: string | null;
  lastFailedSync: string | null;
  lastFailureError: string | null;
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
  unresolvedModality: { entityName: string; message: string }[];
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

export default function DataHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data-health")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6">Loading...</div>;
  if (!data) return <div className="p-6">Failed to load health data</div>;

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Data Health</h1>
        <a href="/search" className="text-sm text-blue-600 hover:underline">
          Back to Search
        </a>
      </div>

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
                ? new Date(data.lastSuccessfulSync).toLocaleString()
                : "Never"}
            </p>
            {data.staleMinutes !== null && data.staleMinutes > 35 && (
              <Badge variant="destructive" className="mt-1">
                Stale ({data.staleMinutes}m ago)
              </Badge>
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
                ? new Date(data.lastFailedSync).toLocaleString()
                : "None"}
            </p>
            {data.lastFailureError && (
              <p className="text-xs text-red-600 mt-1 truncate">{data.lastFailureError}</p>
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

      {/* Unresolved modality */}
      {data.unresolvedModality.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Unresolved Modality ({data.unresolvedModality.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Group</TableHead>
                  <TableHead>Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unresolvedModality.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{m.entityName}</TableCell>
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
                  <TableCell>{new Date(s.startedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    {s.finishedAt ? new Date(s.finishedAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell>{s.teacherCount ?? "-"}</TableCell>
                  <TableCell className="text-xs text-red-600 max-w-xs truncate">
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
