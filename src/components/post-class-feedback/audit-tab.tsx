"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Bot, FileClock, MailWarning, Search, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PostClassFeedbackPayload } from "@/types/post-class-feedback";
import { ContentBadge, EmptyPanel, KpiCell, SourceBadge, TimingBadge, formatBangkokDate } from "./feedback-ui";

export function AuditTab({ payload }: { payload: PostClassFeedbackPayload }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [entityType, setEntityType] = useState("all");
  const entityTypes = useMemo(() => Array.from(new Set(payload.audit.map((row) => row.entityType))).toSorted(), [payload.audit]);
  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return payload.audit.filter((row) => {
      if (entityType !== "all" && row.entityType !== entityType) return false;
      if (!needle) return true;
      return [row.action, row.actorEmail ?? "system", row.entityType, row.entityId, row.summary]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [deferredQuery, entityType, payload.audit]);

  const sourcePaused = payload.sessions.filter((session) => session.sourceStatus !== "ready").length;
  const observedVersions = payload.sessions.reduce((sum, session) => sum + session.versionCount, 0);
  const reminderFailures = payload.sessions.filter((session) => session.reminder.status === "failed").length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-4">
        <KpiCell label="Observed versions" value={observedVersions.toLocaleString()} detail="Immutable evidence history" icon={<FileClock className="size-3.5" />} />
        <KpiCell label="Source-paused sessions" value={sourcePaused.toLocaleString()} detail="Excluded from enforcement" tone={sourcePaused > 0 ? "warning" : "good"} icon={<ShieldAlert className="size-3.5" />} />
        <KpiCell label="Reminder failures" value={reminderFailures.toLocaleString()} detail="Final delivery failures" tone={reminderFailures > 0 ? "danger" : "good"} icon={<MailWarning className="size-3.5" />} />
        <KpiCell label="AI suspects" value={payload.sessions.filter((session) => session.ai.suspect).length.toLocaleString()} detail={`${payload.summary.confirmedAiConcerns} confirmed`} icon={<Bot className="size-3.5" />} />
      </div>

      <Card className="gap-0 rounded-xl py-0 shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="font-heading text-sm font-semibold">Current evidence projection</h2>
          <p className="mt-1 text-xs text-muted-foreground">Source, content, and timing remain independent so outages cannot become deductions.</p>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead className="pl-4">Wise session</TableHead><TableHead>Tutor / students</TableHead><TableHead>Source</TableHead><TableHead>Content</TableHead><TableHead>Timing</TableHead><TableHead>Versions</TableHead><TableHead className="pr-4">Last observed</TableHead></TableRow></TableHeader>
          <TableBody>
            {payload.sessions.slice(0, 100).map((session) => (
              <TableRow key={session.id}>
                <TableCell className="pl-4"><div className="font-medium">{session.className}</div><div className="text-[11px] text-muted-foreground">{session.wiseSessionId}</div></TableCell>
                <TableCell><div className="font-medium">{session.tutorName}</div><div className="max-w-56 truncate text-[11px] text-muted-foreground">{session.students.join(", ")}</div></TableCell>
                <TableCell><SourceBadge status={session.sourceStatus} /></TableCell>
                <TableCell><ContentBadge status={session.contentStatus} /></TableCell>
                <TableCell><TimingBadge status={session.timingStatus} /></TableCell>
                <TableCell className="tabular-nums">{session.versionCount}</TableCell>
                <TableCell className="pr-4 text-xs text-muted-foreground">{formatBangkokDate(session.observedAt, true)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-0 rounded-xl py-0 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <label className="relative min-w-56 flex-1">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search action, actor, entity, or audit summary…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select aria-label="Audit entity type" className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
            <option value="all">All entities</option>
            {entityTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel title="No audit events match" detail="Configuration, review, AI, reminder, and finance actions appear here when recorded." />
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead className="pl-4">Timestamp</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead className="pr-4">Summary</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground">{formatBangkokDate(row.createdAt, true)}</TableCell>
                  <TableCell>{row.actorEmail || <span className="text-muted-foreground">System</span>}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{row.action.replaceAll("_", " ")}</Badge></TableCell>
                  <TableCell><div className="font-medium">{row.entityType}</div><div className="max-w-40 truncate text-[11px] text-muted-foreground">{row.entityId}</div></TableCell>
                  <TableCell className="pr-4"><div className="max-w-xl whitespace-normal text-xs leading-relaxed text-muted-foreground">{row.summary}</div></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
