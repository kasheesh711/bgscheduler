"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  Archive,
  CalendarClock,
  Database,
  LinkIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  SalesDashboardProjectionPayload,
  SalesDashboardSourceSummary,
} from "@/lib/sales-dashboard/types";

export type SourceForm = {
  spreadsheetUrl: string;
  sourceMonth: string;
  label: string;
  normalSheetName: string;
  additionalSheetName: string;
};

export type ProjectionSourceForm = {
  spreadsheetUrl: string;
  summarySheetName: string;
  whatIfSheetName: string;
  calcMultiSheetName: string;
};

interface SourceManagerProps {
  sources: SalesDashboardSourceSummary[];
  form: SourceForm;
  setForm: Dispatch<SetStateAction<SourceForm>>;
  projection: SalesDashboardProjectionPayload | null;
  projectionForm: ProjectionSourceForm;
  setProjectionForm: Dispatch<SetStateAction<ProjectionSourceForm>>;
  busyAction: string;
  runAction: (actionName: string, action: () => Promise<void>) => Promise<void>;
  postJson: (url: string, body?: unknown) => Promise<unknown>;
  patchJson: (url: string, body?: unknown) => Promise<unknown>;
  deleteJson: (url: string) => Promise<unknown>;
  addSource: () => Promise<void>;
  saveProjectionSource: () => Promise<void>;
  importProjectionSource: () => Promise<void>;
  seedHistoricalSources: () => Promise<void>;
  backfillAllSources: () => Promise<void>;
}

export function SourceManager({
  sources,
  form,
  setForm,
  projection,
  projectionForm,
  setProjectionForm,
  busyAction,
  runAction,
  postJson,
  patchJson,
  deleteJson,
  addSource,
  saveProjectionSource,
  importProjectionSource,
  seedHistoricalSources,
  backfillAllSources,
}: SourceManagerProps) {
  const activeSources = sources.filter((source) => source.status !== "archived");
  const archivedSources = sources.filter((source) => source.status === "archived");

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Monthly Sources</h2>
          <p className="text-xs text-muted-foreground">{activeSources.length} active Google Sheet sources · {archivedSources.length} archived</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void seedHistoricalSources()}>
            {busyAction === "seed" ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
            Seed historical
          </Button>
          <Button variant="outline" onClick={() => void backfillAllSources()}>
            {busyAction === "backfill" ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
            Backfill all
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/15 p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Projection Workbook</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Actual-vs-projection uses normal sales only. The imported What_If target replaces the operational dashboard target.
            </p>
            {projection?.source ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={projection.lastImportError ? "destructive" : "secondary"}>
                  {projection.lastImportError ? "Import failed" : projection.lastImportedAt ? "Imported" : "Configured"}
                </Badge>
                <span>{projection.source.lastProjectionMonthCount} scenario-month rows</span>
                <span>Target {projection.targetMonthlyRevenue ? formatMoney(projection.targetMonthlyRevenue) : "fallback"}</span>
                <span>{formatDateTime(projection.lastImportedAt)}</span>
              </div>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">Default projection workbook is ready to save and import.</div>
            )}
            {projection?.lastImportError ? (
              <div className="mt-2 text-xs text-destructive">Last import failed: {projection.lastImportError}</div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void saveProjectionSource()} disabled={!projectionForm.spreadsheetUrl || busyAction === "projection-source"}>
              {busyAction === "projection-source" ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" />}
              Save projection
            </Button>
            <Button variant="outline" onClick={() => void importProjectionSource()} disabled={!projection?.source || busyAction === "projection-import"}>
              {busyAction === "projection-import" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Import projection
            </Button>
          </div>
        </div>

        <div className="mt-3 grid min-w-0 gap-2 lg:grid-cols-[1.8fr_0.7fr_0.7fr_0.7fr]">
          <Input
            placeholder="Projection Google Sheet URL"
            value={projectionForm.spreadsheetUrl}
            onChange={(event) => setProjectionForm((current) => ({ ...current, spreadsheetUrl: event.target.value }))}
          />
          <Input
            placeholder="Summary tab"
            value={projectionForm.summarySheetName}
            onChange={(event) => setProjectionForm((current) => ({ ...current, summarySheetName: event.target.value }))}
          />
          <Input
            placeholder="What_If tab"
            value={projectionForm.whatIfSheetName}
            onChange={(event) => setProjectionForm((current) => ({ ...current, whatIfSheetName: event.target.value }))}
          />
          <Input
            placeholder="Calc_Multi tab"
            value={projectionForm.calcMultiSheetName}
            onChange={(event) => setProjectionForm((current) => ({ ...current, calcMultiSheetName: event.target.value }))}
          />
        </div>
      </div>

      <div className="grid min-w-0 gap-2 lg:grid-cols-[1.8fr_0.7fr_0.9fr_0.8fr_0.8fr_auto]">
        <Input placeholder="Google Sheet URL" value={form.spreadsheetUrl} onChange={(event) => setForm((current) => ({ ...current, spreadsheetUrl: event.target.value }))} />
        <Input type="month" value={form.sourceMonth} onChange={(event) => setForm((current) => ({ ...current, sourceMonth: event.target.value }))} />
        <Input placeholder="Label" value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
        <Input placeholder="Normal tab" value={form.normalSheetName} onChange={(event) => setForm((current) => ({ ...current, normalSheetName: event.target.value }))} />
        <Input placeholder="Additional tab" value={form.additionalSheetName} onChange={(event) => setForm((current) => ({ ...current, additionalSheetName: event.target.value }))} />
        <Button onClick={() => void addSource()} disabled={!form.spreadsheetUrl || busyAction === "source-add"}>
          {busyAction === "source-add" ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" />}
          Save
        </Button>
      </div>

      <div className="max-w-full min-w-0 overflow-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left">Month</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Rows</th>
              <th className="px-3 py-2 text-left">Imported</th>
              <th className="px-3 py-2 text-left">Account</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {activeSources.map((source) => (
              <tr key={source.id} className="border-b last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{source.label}</div>
                  <div className="text-xs text-muted-foreground">{source.sourceMonth.slice(0, 7)}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={source.status === "finalized" ? "secondary" : "outline"}>{source.status}</Badge>
                  {source.lastImportError ? (
                    <div className="mt-1 max-w-[260px] text-xs text-destructive">Last import failed: {source.lastImportError}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{source.lastNormalRowCount} normal · {source.lastAdditionalRowCount} additional</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(source.lastImportedAt)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{source.connectedEmail}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="outline" title="Import source" onClick={() => void runAction(`import-${source.id}`, async () => {
                      await postJson("/api/sales-dashboard/import", { sourceId: source.id, allowFinalized: source.status === "finalized" && window.confirm("Refresh finalized source?") });
                    })}>
                      {busyAction === `import-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    </Button>
                    {source.status === "finalized" ? (
                      <Button size="icon-sm" variant="outline" title="Reopen" onClick={() => void runAction(`reopen-${source.id}`, async () => {
                        await patchJson(`/api/sales-dashboard/sources/${source.id}`, { status: "reopened" });
                      })}>
                        <RotateCcw className="size-3.5" />
                      </Button>
                    ) : null}
                    <Button size="icon-sm" variant="outline" title="Archive source" disabled={source.status === "refreshing"} onClick={() => void runAction(`archive-${source.id}`, async () => {
                      if (!window.confirm(`Archive ${source.label}? Imported rows and import history will be kept and can be restored later.`)) return;
                      await deleteJson(`/api/sales-dashboard/sources/${source.id}`);
                    })}>
                      {busyAction === `archive-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {archivedSources.length > 0 ? (
        <details className="rounded-md border bg-muted/20 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Archived sources ({archivedSources.length})</summary>
          <div className="mt-3 max-w-full min-w-0 overflow-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 text-left">Month</th>
                  <th className="py-2 text-left">Archived</th>
                  <th className="py-2 text-left">Rows kept</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {archivedSources.map((source) => (
                  <tr key={source.id} className="border-b last:border-0">
                    <td className="py-2">
                      <div className="font-medium">{source.label}</div>
                      <div className="text-xs text-muted-foreground">{source.sourceMonth.slice(0, 7)}</div>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {formatDateTime(source.archivedAt)}
                      {source.archivedByEmail ? <div>{source.archivedByEmail}</div> : null}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{source.lastNormalRowCount} normal · {source.lastAdditionalRowCount} additional</td>
                    <td className="py-2">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => void runAction(`restore-${source.id}`, async () => {
                          await patchJson(`/api/sales-dashboard/sources/${source.id}`, { status: "active" });
                        })}>
                          {busyAction === `restore-${source.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                          Restore
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never imported";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMoney(value: number): string {
  return `฿${Math.round(value).toLocaleString("en-US")}`;
}
