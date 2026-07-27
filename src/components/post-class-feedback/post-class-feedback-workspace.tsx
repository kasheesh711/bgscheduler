"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  FileClock,
  RefreshCw,
  Settings,
  ShieldAlert,
  WalletCards,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { FeedbackMutationRequest, PostClassFeedbackPayload } from "@/types/post-class-feedback";
import { AnalyticsTab } from "./analytics-tab";
import { AuditTab } from "./audit-tab";
import { DeductionsTab } from "./deductions-tab";
import {
  EmptyPanel,
  KpiCell,
  LoadingSurface,
  currentBangkokMonthRange,
  formatMoney,
  formatRate,
} from "./feedback-ui";
import { OperationsTab } from "./operations-tab";
import { SettingsTab, type SettingsRequest } from "./settings-tab";

/**
 * Declared here rather than imported from `@/lib/sales-dashboard/google-oauth`:
 * that module pulls in node:crypto and the database, which must not reach the
 * client bundle. Same approach as the leave-requests workspace. Keep in step
 * with the sign-in scope in `src/lib/auth.ts`.
 */
const PAYOUT_RECONSENT_SCOPE = "openid email profile"
  + " https://www.googleapis.com/auth/spreadsheets"
  + " https://www.googleapis.com/auth/drive.file";

type WorkspaceTab = "operations" | "analytics" | "deductions" | "audit" | "settings";
type Toast = { tone: "success" | "error"; message: string } | null;

async function checkedJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error
      ? payload.error
      : fallback);
  }
  return payload as T;
}

function SetupBanner({ payload, onOpenSettings }: { payload: PostClassFeedbackPayload; onOpenSettings?: () => void }) {
  if (payload.setup.complete) return null;
  const incomplete = payload.setup.items.filter((item) => !item.complete);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="mr-auto">
        <span className="font-semibold">Setup required.</span>{" "}
        {incomplete.slice(0, 2).map((item) => item.label).join(" and ")}{incomplete.length > 2 ? ` plus ${incomplete.length - 2} more items` : ""}.
      </div>
      {onOpenSettings ? (
        <Button variant="outline" size="sm" className="border-amber-300 bg-white/70" onClick={onOpenSettings}>
          Review setup
        </Button>
      ) : null}
    </div>
  );
}

function SummaryBand({ payload }: { payload: PostClassFeedbackPayload }) {
  const summary = payload.summary;
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-3 xl:grid-cols-6">
      <KpiCell label="Eligible" value={summary.eligible.toLocaleString()} detail={`${summary.assessed.toLocaleString()} assessed`} />
      <KpiCell label="Raw on-time" value={`${summary.rawOnTime.toLocaleString()} (${formatRate(summary.rawOnTimeRate)})`} detail="Proven before deadline" tone="good" />
      <KpiCell label="Adjusted compliance" value={`${summary.adjustedCompliant.toLocaleString()} (${formatRate(summary.adjustedComplianceRate)})`} detail="Includes timing-unknown + waived" tone="good" />
      <KpiCell label="Open violations" value={summary.openViolations.toLocaleString()} detail={`${summary.late} late · ${summary.incomplete} incomplete`} tone={summary.openViolations > 0 ? "danger" : "good"} />
      <KpiCell label="Pending deductions" value={summary.pendingDeductions.toLocaleString()} detail={formatMoney(summary.pendingDeductionAmount)} tone={summary.pendingDeductions > 0 ? "warning" : "default"} />
      <KpiCell label="Reminder failures" value={summary.reminderFailures.toLocaleString()} detail="Final failed deliveries" tone={summary.reminderFailures > 0 ? "danger" : "good"} />
    </div>
  );
}

function WorkspaceToast({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className={cn(
      "fixed right-5 bottom-5 z-50 flex max-w-md items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg",
      toast.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900",
    )} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "success" ? <CheckCircle2 className="size-4 shrink-0" /> : <ShieldAlert className="size-4 shrink-0" />}
      <span>{toast.message}</span>
      <Button variant="ghost" size="icon-xs" onClick={onClose}><X /><span className="sr-only">Dismiss</span></Button>
    </div>
  );
}

export function PostClassFeedbackWorkspace() {
  const initialRange = useRef(currentBangkokMonthRange());
  const [startDate, setStartDate] = useState(initialRange.current.startDate);
  const [endDate, setEndDate] = useState(initialRange.current.endDate);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("operations");
  const [payload, setPayload] = useState<PostClassFeedbackPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const hasPayload = useRef(false);

  const loadPayload = useCallback(async (manual = false) => {
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setError(null);
    if (manual || hasPayload.current) setRefreshing(true); else setLoading(true);
    try {
      const params = new URLSearchParams({ startDate, endDate });
      const response = await fetch(`/api/post-class-feedback?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const next = await checkedJson<PostClassFeedbackPayload>(response, "Could not load post-class feedback.");
      if (sequence !== requestSequence.current) return;
      hasPayload.current = true;
      setPayload(next);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Could not load post-class feedback.");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [endDate, startDate]);

  useEffect(() => {
    void loadPayload();
    return () => activeController.current?.abort();
  }, [loadPayload]);

  useEffect(() => {
    if (!payload) return;
    if (activeTab === "deductions" && !payload.capabilities.reviewer && !payload.capabilities.finance) {
      setActiveTab("operations");
    }
    if (activeTab === "settings" && !payload.capabilities.accessManager) {
      setActiveTab("operations");
    }
  }, [activeTab, payload]);

  const sendRequest: SettingsRequest = useCallback(async (endpoint, method, body) => {
    if (submitting) return;
    setSubmitting(true);
    setToast(null);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await checkedJson(response, "The action could not be completed.");
      setToast({ tone: "success", message: "Saved. The dashboard has been refreshed." });
      await loadPayload(true);
    } catch (requestError) {
      setToast({ tone: "error", message: requestError instanceof Error ? requestError.message : "The action could not be completed." });
    } finally {
      setSubmitting(false);
    }
  }, [loadPayload, submitting]);

  const runMutation = useCallback(async (request: FeedbackMutationRequest) => {
    await sendRequest(request.endpoint, "POST", request.body as unknown as Record<string, unknown>);
  }, [sendRequest]);

  const invalidRange = endDate < startDate;

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-auto pb-4">
      <header className="flex flex-wrap items-end gap-4 py-2">
        <div className="mr-auto min-w-0">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Post-class feedback</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track Wise feedback evidence, reminders, quality review, and manual deductions.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            From
            <Input type="date" className="w-36 bg-card" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            To
            <Input type="date" className="w-36 bg-card" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <Button variant="outline" disabled={refreshing || invalidRange} onClick={() => void loadPayload(true)}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {payload?.payoutGoogle && !payload.payoutGoogle.driveReady ? (
            <Button
              variant="outline"
              className="border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
              title={`${payload.payoutGoogle.connectedEmail} has not granted Drive access. Payout CSV upload will fail until it does.`}
              onClick={() => signIn("google", { callbackUrl: "/post-class-feedback" }, {
                prompt: "consent",
                access_type: "offline",
                scope: PAYOUT_RECONSENT_SCOPE,
              })}
            >
              <ShieldAlert />
              Reconnect Google
            </Button>
          ) : null}
          {payload ? (
            <Badge variant="outline" className={cn(
              "h-8 gap-2 px-3 capitalize",
              payload.settings.mode === "live" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : payload.settings.mode === "paused" ? "border-red-300 bg-red-50 text-red-800" : "border-sky-300 bg-sky-50 text-sky-800",
            )}>
              <span className={cn("size-2 rounded-full", payload.settings.mode === "live" ? "bg-emerald-500" : payload.settings.mode === "paused" ? "bg-red-500" : "bg-sky-500")} />
              {payload.settings.mode} mode
            </Badge>
          ) : null}
        </div>
      </header>

      {invalidRange ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">The end date must be on or after the start date.</div> : null}

      <Tabs value={activeTab} onValueChange={(value) => { if (value) setActiveTab(value as WorkspaceTab); }} className="min-h-0 min-w-0 max-w-full flex-1">
        <TabsList variant="line" className="mb-3 h-10 w-full max-w-full justify-start gap-4 overflow-x-auto border-b px-1">
          <TabsTrigger value="operations" className="px-2.5"><ClipboardList />Operations</TabsTrigger>
          <TabsTrigger value="analytics" className="px-2.5"><BarChart3 />Analytics</TabsTrigger>
          {payload?.capabilities.reviewer || payload?.capabilities.finance ? (
            <TabsTrigger value="deductions" className="px-2.5"><WalletCards />Deductions</TabsTrigger>
          ) : null}
          <TabsTrigger value="audit" className="px-2.5"><FileClock />Audit</TabsTrigger>
          {payload?.capabilities.accessManager ? (
            <TabsTrigger value="settings" className="px-2.5"><Settings />Settings</TabsTrigger>
          ) : null}
        </TabsList>

        {loading && !payload ? <LoadingSurface /> : error && !payload ? (
          <div className="rounded-xl border bg-card shadow-sm">
            <EmptyPanel
              title="Post-class feedback is unavailable"
              detail={error}
              kind="error"
              action={<Button variant="outline" onClick={() => void loadPayload(true)}><RefreshCw />Try again</Button>}
            />
          </div>
        ) : payload && !payload.capabilities.viewer ? (
          <div className="rounded-xl border bg-card shadow-sm"><EmptyPanel title="Viewer access required" detail="An access manager must grant your account the post-class feedback viewer capability." kind="paused" /></div>
        ) : payload ? (
          <>
            {error ? <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="size-4" />Showing the last successful payload. Refresh failed: {error}</div> : null}
            <SetupBanner
              payload={payload}
              onOpenSettings={payload.capabilities.accessManager ? () => setActiveTab("settings") : undefined}
            />
            {activeTab === "operations" ? <div className="mt-3"><SummaryBand payload={payload} /></div> : null}

            <TabsContent value="operations" className="mt-3 min-w-0"><OperationsTab payload={payload} submitting={submitting} onMutation={runMutation} /></TabsContent>
            <TabsContent value="analytics" className="mt-3 min-w-0"><AnalyticsTab payload={payload} /></TabsContent>
            {payload.capabilities.reviewer || payload.capabilities.finance ? (
              <TabsContent value="deductions" className="mt-3 min-w-0"><DeductionsTab payload={payload} submitting={submitting} onMutation={runMutation} /></TabsContent>
            ) : null}
            <TabsContent value="audit" className="mt-3 min-w-0"><AuditTab payload={payload} /></TabsContent>
            {payload.capabilities.accessManager ? (
              <TabsContent value="settings" className="mt-3 min-w-0" keepMounted={false}>
                <SettingsTab key={`${payload.settings.version ?? 0}:${payload.settings.sourceLastSyncedAt ?? "never"}`} payload={payload} submitting={submitting} onRequest={sendRequest} />
              </TabsContent>
            ) : null}
          </>
        ) : null}
      </Tabs>
      <WorkspaceToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
