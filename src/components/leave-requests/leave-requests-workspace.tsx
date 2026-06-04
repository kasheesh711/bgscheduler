"use client";

import { signIn } from "next-auth/react";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AffectedClassesPanel,
  ErrorBanner,
  LeaveKpiStrip,
  LeaveRequestsCommandHeader,
  LeaveTimelinePanel,
  RequestInspector,
  RequestQueue,
} from "./leave-requests-panels";
import type {
  LeaveListResponse,
  LeaveRequestDetail,
  WorkflowStatus,
} from "./types";
import {
  SHEETS_WRITE_SCOPE,
  buildListParams,
  buildNext14DayTimeline,
  buildTimelineBucketsFromRows,
  filterQueueRows,
  statusLabel,
  type DatePreset,
  type QueueFilter,
} from "./view-model";

async function checkedJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error(payload && typeof payload === "object" && "error" in payload && payload.error ? payload.error : fallback);
  }
  return payload as T;
}

export function LeaveRequestsWorkspace() {
  const [filter, setFilter] = useState<QueueFilter>("action");
  const [datePreset, setDatePreset] = useState<DatePreset>("any");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const [data, setData] = useState<LeaveListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeaveRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staffNote, setStaffNote] = useState("");
  const [sheetText, setSheetText] = useState("");
  const [detailStatus, setDetailStatus] = useState<WorkflowStatus>("new");
  const [selectedAffected, setSelectedAffected] = useState<Set<string>>(new Set());
  const [listReloadToken, setListReloadToken] = useState(0);
  const [detailReloadToken, setDetailReloadToken] = useState(0);

  const listQuery = useMemo(() => {
    return buildListParams({ filter, query: deferredQuery, datePreset }).toString();
  }, [datePreset, deferredQuery, filter]);

  const visibleRows = useMemo(
    () => filterQueueRows(data?.requests ?? [], filter),
    [data?.requests, filter],
  );
  const timelineBuckets = useMemo(
    () => buildNext14DayTimeline(buildTimelineBucketsFromRows(visibleRows)),
    [visibleRows],
  );

  const acceptDetail = useCallback((nextDetail: LeaveRequestDetail | null) => {
    setDetail(nextDetail);
    if (!nextDetail) {
      setDetailStatus("new");
      setStaffNote("");
      setSheetText("");
      setSelectedAffected(new Set());
      return;
    }
    setDetailStatus(nextDetail.request.workflowStatus);
    setStaffNote(nextDetail.request.staffNote ?? "");
    setSheetText(nextDetail.request.sourceSheetStatus ?? statusLabel(nextDetail.request.workflowStatus));
    setSelectedAffected(new Set(nextDetail.affectedSessions.filter((row) => row.cancelPreviewSelected).map((row) => row.id)));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadList() {
      setLoading(true);
      setError(null);
      try {
        const result = await checkedJson<LeaveListResponse>(
          await fetch(`/api/leave-requests${listQuery ? `?${listQuery}` : ""}`, { signal: controller.signal }),
          "Leave request list failed",
        );
        if (!controller.signal.aborted) setData(result);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Leave request list failed");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadList();
    return () => controller.abort();
  }, [listQuery, listReloadToken]);

  useEffect(() => {
    if (loading) return;
    if (visibleRows.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      if (current && visibleRows.some((row) => row.id === current)) return current;
      return visibleRows[0]?.id ?? null;
    });
  }, [loading, visibleRows]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadDetail() {
      if (!selectedId) {
        acceptDetail(null);
        setDetailLoading(false);
        return;
      }
      setDetailLoading(true);
      try {
        const result = await checkedJson<LeaveRequestDetail>(
          await fetch(`/api/leave-requests/${selectedId}`, { signal: controller.signal }),
          "Leave request detail failed",
        );
        if (!controller.signal.aborted) acceptDetail(result);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Leave request detail failed");
        }
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => controller.abort();
  }, [acceptDetail, detailReloadToken, selectedId]);

  const selectedDate = detail?.request.startDate ?? visibleRows.find((row) => row.id === selectedId)?.startDate ?? null;

  const toggleAffected = useCallback((id: string, checked: boolean) => {
    setSelectedAffected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      await checkedJson(await fetch("/api/leave-requests/sync", { method: "POST" }), "Leave request sync failed");
      setListReloadToken((value) => value + 1);
      setDetailReloadToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function saveStatus(retrySheetWrite = false) {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      const result = await checkedJson<{ warning?: string | null; detail: LeaveRequestDetail }>(
        await fetch(`/api/leave-requests/${detail.request.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowStatus: detailStatus,
            staffNote,
            sheetStatusText: sheetText,
            retrySheetWrite,
          }),
        }),
        "Leave request update failed",
      );
      acceptDetail(result.detail);
      setListReloadToken((value) => value + 1);
      if (result.warning) setError(result.warning);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leave request update failed");
    } finally {
      setSaving(false);
    }
  }

  async function logCancelPreview() {
    if (!detail || selectedAffected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await checkedJson<{ detail: LeaveRequestDetail }>(
        await fetch(`/api/leave-requests/${detail.request.id}/wise-cancel-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ affectedSessionIds: [...selectedAffected] }),
        }),
        "Wise cancel preview failed",
      );
      acceptDetail(result.detail);
      setListReloadToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wise cancel preview failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <LeaveRequestsCommandHeader
        data={data}
        syncing={syncing}
        onSync={runSync}
        onReconnectSheets={() => signIn("google", { callbackUrl: "/leave-requests" }, {
          prompt: "consent",
          access_type: "offline",
          scope: SHEETS_WRITE_SCOPE,
        })}
      />

      {error && <ErrorBanner message={error} />}

      <LeaveKpiStrip data={data} activeFilter={filter} />

      <section className="grid min-h-0 min-w-0 flex-1 auto-rows-max items-start gap-4 overflow-y-auto overflow-x-hidden pr-1 lg:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.05fr)] xl:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.05fr)_minmax(380px,0.95fr)]">
        <RequestQueue
          rows={visibleRows}
          loading={loading}
          filter={filter}
          query={query}
          datePreset={datePreset}
          selectedId={selectedId}
          onFilterChange={setFilter}
          onQueryChange={setQuery}
          onDatePresetChange={setDatePreset}
          onSelect={setSelectedId}
        />

        <div className="grid min-w-0 content-start gap-4">
          <LeaveTimelinePanel buckets={timelineBuckets} selectedDate={selectedDate} />
          <AffectedClassesPanel
            detail={detail}
            loading={detailLoading}
            selectedAffected={selectedAffected}
            onToggle={toggleAffected}
          />
        </div>

        <div className="min-h-[520px] min-w-0 overflow-hidden lg:col-span-2 xl:col-span-1">
          <RequestInspector
            detail={detail}
            loading={detailLoading}
            saving={saving}
            detailStatus={detailStatus}
            sheetText={sheetText}
            staffNote={staffNote}
            selectedAffected={selectedAffected}
            onStatusChange={setDetailStatus}
            onSheetTextChange={setSheetText}
            onStaffNoteChange={setStaffNote}
            onSave={() => saveStatus(false)}
            onRetrySheet={() => saveStatus(true)}
            onToggleAffected={toggleAffected}
            onPreviewCancel={logCancelPreview}
          />
        </div>
      </section>
    </div>
  );
}
