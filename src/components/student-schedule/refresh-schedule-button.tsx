"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { StudentSchedulePayload } from "@/lib/student-schedule/types";

export function RefreshScheduleButton({ url, method = "GET", onRefresh, thai = false }: {
  url: string; method?: "GET" | "POST"; onRefresh?: (payload: StudentSchedulePayload) => void; thai?: boolean;
}) {
  const router = useRouter();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function refresh() {
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(false);
    try {
      const response = await fetch(url, { method, cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Refresh unavailable");
      const payload = await response.json() as StudentSchedulePayload;
      if (controller.signal.aborted) return;
      if (onRefresh) onRefresh(payload); else router.refresh();
    } catch { if (!controller.signal.aborted) setError(true); } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <span className="print:hidden"><Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
    {busy ? (thai ? "กำลังอัปเดต…" : "Refreshing…") : (thai ? "อัปเดตตารางเรียน" : "Refresh from Wise")}
  </Button>{error && <span role="status" className="ml-2 text-sm">{thai ? "อัปเดตไม่สำเร็จ กรุณาลองอีกครั้ง" : "Unable to refresh. Please try again."}</span>}</span>;
}
