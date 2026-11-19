"use client";

import { useEffect, useState } from "react";
import type { RoleView } from "@/lib/hiring/role-views";
import type { HiringData } from "./dashboard";
import { AdminScreen, HeadsScreen, HrScreen } from "./role-screens";
import css from "./dashboard.module.css";

export function HiringStaffPreview({ role }: { role: RoleView }) {
  const [data, setData] = useState<HiringData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/hiring", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Hiring is unavailable.");
      setData(await response.json() as HiringData);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  if (failed) return <p role="alert">Could not open the Hiring preview.</p>;
  if (!data) return <p role="status">Loading Hiring preview…</p>;
  return (
    <div className={css.surface} style={{ margin: 0 }}>
      {role === "hr" && <HrScreen data={data} command={async () => false} onOpenResults={() => {}} busy={false} readOnly />}
      {role === "admin" && <AdminScreen data={data} reload={async () => {}} readOnly />}
      {role === "heads" && <HeadsScreen data={data} readOnly />}
    </div>
  );
}
