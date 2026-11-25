"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { CapacityReport } from "@/lib/hiring/capacity";
import { buildFunnel } from "@/lib/hiring/funnel";
import type { HiringData } from "./dashboard";
import type { Show } from "./overview-analytics";
import { currentStageRows, OverviewPriorities } from "./overview-priorities";
import { TabSkeleton } from "./tab-skeleton";
import css from "./overview-analytics.module.css";

const OverviewDetails = dynamic(() => import("./overview-analytics").then((module) => module.OverviewDetails), {
  loading: () => <TabSkeleton label="Loading pipeline details…" />,
});

export function OverviewBoard({ data, now, capacity, onShow, onOpen }: {
  data: HiringData;
  now: Date;
  capacity: CapacityReport | null;
  onShow: Show;
  onOpen: (id: string) => void;
}) {
  const report = useMemo(() => buildFunnel(data, now), [data, now]);
  const stages = useMemo(() => currentStageRows(data, report, now), [data, report, now]);
  const [detailsOpened, setDetailsOpened] = useState(false);

  return (
    <div className={css.board}>
      <OverviewPriorities data={data} report={report} now={now} capacity={capacity} stages={stages} />
      <details className={css.moreDetails} onToggle={(event) => {
        if (event.currentTarget.open) setDetailsOpened(true);
      }}>
        <summary>Pipeline details, send queues and candidate groups</summary>
        {detailsOpened && <OverviewDetails data={data} now={now} report={report} stages={stages} onShow={onShow} onOpen={onOpen} />}
      </details>
    </div>
  );
}
