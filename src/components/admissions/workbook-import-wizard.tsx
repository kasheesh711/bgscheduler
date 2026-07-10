"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileSpreadsheetIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SELECT_FIELD_CLASSES } from "@/components/admissions/field-classes";
import type { AdmissionsWorkbookPreview } from "@/lib/admissions/workbook-import";
import type {
  AdmissionsImportCommitResult,
  AdmissionsImportConflictPolicy,
} from "@/lib/admissions/workbook-import-commit";
import type { AdmissionsImportRunDto } from "@/lib/admissions/workbook-import-service";

const SHEETS_SCOPE = "openid email profile https://www.googleapis.com/auth/spreadsheets.readonly";

interface ApiErrorPayload {
  error?: string;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as ApiErrorPayload).error;
    if (typeof value === "string" && value) return value;
  }
  return fallback;
}

function countLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function displayImportValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

export interface WorkbookImportWizardProps {
  caseId: string;
}

export function WorkbookImportWizard({ caseId }: WorkbookImportWizardProps) {
  const router = useRouter();
  const [spreadsheetUrl, setSpreadsheetUrl] = useState("");
  const [preview, setPreview] = useState<AdmissionsWorkbookPreview | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<AdmissionsImportConflictPolicy | "">("");
  const [result, setResult] = useState<AdmissionsImportCommitResult | null>(null);
  const [history, setHistory] = useState<AdmissionsImportRunDto[]>([]);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blockingIssues = useMemo(
    () => preview?.issues.filter((issue) => issue.severity === "error") ?? [],
    [preview],
  );
  const warnings = useMemo(
    () => preview?.issues.filter((issue) => issue.severity === "warning") ?? [],
    [preview],
  );
  const counts = useMemo(
    () => Object.entries(preview?.counts ?? {}).filter(([, value]) => value > 0),
    [preview],
  );

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/imports`);
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      const imports = (payload as { imports?: unknown } | null)?.imports;
      if (Array.isArray(imports)) setHistory(imports as AdmissionsImportRunDto[]);
    } catch {
      // Import history is supporting context; a transient read failure must not
      // prevent preview or commit actions in the primary wizard.
    }
  }, [caseId]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  async function previewWorkbook() {
    const source = spreadsheetUrl.trim();
    if (!source) {
      setError("Paste the copied student workbook URL first.");
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", spreadsheetUrl: source }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Workbook preview failed."));
      const nextPreview = (payload as { preview?: AdmissionsWorkbookPreview } | null)?.preview;
      if (!nextPreview) throw new Error("Workbook preview returned no data.");
      setPreview(nextPreview);
      setConflictPolicy("");
    } catch (requestError) {
      setPreview(null);
      setError(requestError instanceof Error ? requestError.message : "Workbook preview failed.");
    } finally {
      setBusy(null);
    }
  }

  async function commitWorkbook() {
    if (!preview) return;
    if (!conflictPolicy) {
      setError("Choose how the import should handle values already in this case.");
      return;
    }
    setBusy("commit");
    setError(null);
    try {
      const response = await fetch(`/api/admissions/cases/${caseId}/imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          spreadsheetUrl: spreadsheetUrl.trim(),
          expectedFingerprint: preview.sourceFingerprint,
          conflictPolicy,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "Workbook import failed."));
      const nextResult = (payload as { result?: AdmissionsImportCommitResult } | null)?.result;
      if (!nextResult) throw new Error("Workbook import returned no result.");
      setResult(nextResult);
      await loadHistory();
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Workbook import failed.");
    } finally {
      setBusy(null);
    }
  }

  function connectGoogleSheets() {
    void signIn("google", { callbackUrl: `/admissions/${caseId}?tab=casework` }, {
      prompt: "consent",
      access_type: "offline",
      scope: SHEETS_SCOPE,
    });
  }

  return (
    <Card data-testid="workbook-import-wizard">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheetIcon aria-hidden className="size-4" />
          Legacy workbook import
        </CardTitle>
        <CardDescription>
          Preview a copied student workbook, resolve any issues, then commit it once. The source stays a read-only archive; there is no ongoing synchronization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <label className="space-y-1 text-xs font-medium text-foreground">
            Copied Google Sheets workbook URL
            <Input
              type="url"
              inputMode="url"
              placeholder="https://docs.google.com/spreadsheets/d/…/edit"
              value={spreadsheetUrl}
              disabled={busy !== null}
              onChange={(event) => {
                setSpreadsheetUrl(event.target.value);
                setPreview(null);
                setResult(null);
                setError(null);
              }}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !spreadsheetUrl.trim()}
            onClick={() => void previewWorkbook()}
          >
            {busy === "preview" ? <Loader2Icon aria-hidden className="animate-spin" /> : <RefreshCwIcon aria-hidden />}
            {preview ? "Refresh preview" : "Preview"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={connectGoogleSheets}>
            <ShieldCheckIcon aria-hidden /> Connect Sheets
          </Button>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}

        {preview ? (
          <div className="space-y-4 rounded-lg border border-border bg-muted/15 p-3" data-testid="workbook-import-preview">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">Preview ready</p>
                <p className="text-xs text-muted-foreground">
                  Source fingerprint {preview.sourceFingerprint.slice(0, 12)}… · no changes have been written
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{counts.reduce((sum, [, value]) => sum + value, 0)} mapped items</Badge>
                {blockingIssues.length ? (
                  <Badge className="bg-destructive/15 text-destructive">{blockingIssues.length} blocking</Badge>
                ) : (
                  <Badge className="bg-available/15 text-available">Ready to import</Badge>
                )}
                {warnings.length ? <Badge className="bg-warning/15 text-warning">{warnings.length} warnings</Badge> : null}
              </div>
            </div>

            {counts.length ? (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {counts.map(([key, value]) => (
                  <div key={key} className="rounded-md border border-border bg-background p-2">
                    <dt className="truncate text-[11px] capitalize text-muted-foreground">{countLabel(key)}</dt>
                    <dd className="text-base font-semibold text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No student-entered records were found in the supported ranges.</p>
            )}

            {preview.issues.length ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Issues to review</p>
                <ul className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
                  {preview.issues.slice(0, 50).map((issue, index) => (
                    <li
                      key={`${issue.code}-${issue.sheetName}-${issue.range ?? index}`}
                      className="flex gap-2 rounded-md border border-border bg-background p-2 text-xs"
                    >
                      <AlertTriangleIcon
                        aria-hidden
                        className={issue.severity === "error" ? "mt-0.5 size-3.5 shrink-0 text-destructive" : "mt-0.5 size-3.5 shrink-0 text-warning"}
                      />
                      <span>
                        <span className="font-medium">{issue.sheetName}{issue.range ? ` · ${issue.range}` : ""}</span>
                        <span className="block text-muted-foreground">{issue.message}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.changes.length ? (
              <details className="rounded-md border border-border bg-background p-2">
                <summary className="cursor-pointer text-xs font-medium">
                  {preview.changes.length} field-level changes compared with the current case
                </summary>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {preview.changes.slice(0, 50).map((change, index) => (
                    <li key={`${change.target}-${change.field}-${index}`}>
                      <span className="font-medium text-foreground">{change.target}</span> · {change.field}: {displayImportValue(change.oldValue)} → {displayImportValue(change.newValue)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="space-y-1 text-xs font-medium text-foreground">
                Existing-value policy
                <select
                  className={SELECT_FIELD_CLASSES}
                  value={conflictPolicy}
                  disabled={busy !== null || blockingIssues.length > 0}
                  onChange={(event) => setConflictPolicy(event.target.value as AdmissionsImportConflictPolicy | "")}
                >
                  <option value="">Choose before committing…</option>
                  <option value="preserve_existing">Preserve current case values; add only missing records</option>
                  <option value="overwrite_existing">Use workbook values for matching records</option>
                </select>
              </label>
              <Button
                size="sm"
                disabled={busy !== null || blockingIssues.length > 0 || !conflictPolicy}
                onClick={() => void commitWorkbook()}
              >
                {busy === "commit" ? <Loader2Icon aria-hidden className="animate-spin" /> : <CheckCircle2Icon aria-hidden />}
                {busy === "commit" ? "Importing…" : "Confirm import"}
              </Button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="flex flex-col gap-2 rounded-lg border border-available/30 bg-available/10 p-3 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between" role="status">
            <div className="flex gap-2">
              <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-available" />
              <span>
                {result.noOp
                  ? "This exact workbook version was already imported; no records changed."
                  : "Workbook imported atomically. The source is now the read-only archive for this run."}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              render={<a href={spreadsheetUrl.trim()} target="_blank" rel="noreferrer" />}
            >
              Open archive <ExternalLinkIcon aria-hidden />
            </Button>
          </div>
        ) : null}

        {history.length ? (
          <div className="space-y-2 border-t border-border pt-4" data-testid="workbook-import-history">
            <p className="text-xs font-medium text-foreground">Import history</p>
            <ul className="space-y-2">
              {history.slice(0, 5).map((run) => {
                const committedCounts = Object.entries(run.summary).filter(([, value]) => typeof value === "number");
                return (
                  <li key={run.id} className="rounded-lg border border-border bg-muted/15 p-3 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground">
                          {run.status === "committed" ? "Committed import" : run.status}
                        </p>
                        <p className="text-muted-foreground">
                          {new Date(run.committedAt ?? run.createdAt).toLocaleString()} · {run.createdByEmail}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        render={<a href={run.spreadsheetUrl} target="_blank" rel="noreferrer" />}
                      >
                        Archive <ExternalLinkIcon aria-hidden />
                      </Button>
                    </div>
                    {committedCounts.length ? (
                      <p className="mt-2 text-muted-foreground">
                        Committed · {committedCounts.map(([key, value]) => `${countLabel(key)}: ${value}`).join(" · ")}
                      </p>
                    ) : null}
                    {Object.values(run.previewCounts).some((value) => value > 0) ? (
                      <p className="mt-1 text-muted-foreground">
                        Preview · {Object.entries(run.previewCounts)
                          .filter(([, value]) => value > 0)
                          .map(([key, value]) => `${countLabel(key)}: ${value}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                    {run.changes.length || run.issues.length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer font-medium text-foreground">
                          {run.changes.length} field changes · {run.issues.length} issues
                        </summary>
                        {run.changes.length ? (
                          <ul className="mt-2 space-y-1 text-muted-foreground">
                            {run.changes.slice(0, 20).map((change, index) => (
                              <li key={`${change.target}-${change.field}-${index}`}>
                                {change.target} · {change.field}: {displayImportValue(change.oldValue)} → {displayImportValue(change.newValue)}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {run.issues.length ? (
                          <ul className="mt-2 space-y-1 text-muted-foreground">
                            {run.issues.slice(0, 20).map((issue, index) => (
                              <li key={`${issue.code}-${issue.sourceRef ?? index}`}>
                                {issue.sheetName ? `${issue.sheetName}: ` : ""}{issue.message}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </details>
                    ) : null}
                    {Object.values(run.legacyWorksheetSections).some((section) => Object.keys(section).length > 0) ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer font-medium text-foreground">
                          Archived worksheet field values
                        </summary>
                        <div className="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
                          {Object.entries(run.legacyWorksheetSections).map(([sectionKey, section]) => (
                            Object.keys(section).length ? (
                              <div key={sectionKey}>
                                <p className="font-medium capitalize text-foreground">{countLabel(sectionKey)}</p>
                                <dl className="mt-1 grid gap-1 sm:grid-cols-2">
                                  {Object.entries(section).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => (
                                    <div key={key} className="rounded border border-border/70 bg-background p-1.5">
                                      <dt className="capitalize text-muted-foreground">{countLabel(key)}</dt>
                                      <dd className="break-words text-foreground">{displayImportValue(value)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            ) : null
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
