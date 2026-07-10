"use client";

// ----------------------------------------------------------------------------
// Admissions caseload — client shell for /admissions (design §5.1,
// desktop-dense). Header KPI row (active cases + status counts), a
// Table ↔ Board view toggle, the "New case" dialog, the "Resources" library
// dialog (CM-92 — the library is global, so it lives here rather than as a
// per-case tab), and the selected view. Server props are authz-scoped
// (getCaseloadForUser); after a successful create the shell refreshes the
// route so the server re-fetches.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Columns3, Plus, Settings, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AdmissionsResourceTopicGroup } from "@/lib/admissions/resources";
import type {
  AdmissionsCaseStatus,
  AdmissionsCaseSummary,
  AdmissionsCohortDto,
  AdmissionsCounselorDto,
  CaseRole,
} from "@/lib/admissions/types";
import { CaseloadBoard } from "./caseload-board";
import { CaseloadTable } from "./caseload-table";
import { CreateCaseDialog } from "./create-case-dialog";
import { ManagePanel } from "./manage-panel";
import { ResourcesPanel } from "./resources-panel";

/** Caseload view mode; the table is the desktop-dense default. */
export type CaseloadView = "table" | "board";

/** Header KPI aggregates for the caseload. */
export interface CaseloadKpis {
  totalCases: number;
  statusCounts: Record<AdmissionsCaseStatus, number>;
}

/** Aggregates caseload rows into the header KPI counts (pure). */
export function computeCaseloadKpis(rows: AdmissionsCaseSummary[]): CaseloadKpis {
  const statusCounts: Record<AdmissionsCaseStatus, number> = {
    active: 0,
    committed: 0,
    completed: 0,
    withdrawn: 0,
    archived: 0,
  };
  for (const row of rows) statusCounts[row.status] += 1;
  return { totalCases: rows.length, statusCounts };
}

function KpiTile({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

function ViewToggle({ view, onChange }: { view: CaseloadView; onChange: (view: CaseloadView) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-0.5" role="group" aria-label="Caseload layout">
      <Button
        type="button"
        variant={view === "table" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Table view"
        aria-pressed={view === "table"}
        onClick={() => onChange("table")}
        className="h-7 gap-1.5 px-2"
      >
        <Table2 aria-hidden className="size-4" />
        Table
      </Button>
      <Button
        type="button"
        variant={view === "board" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Board view"
        aria-pressed={view === "board"}
        onClick={() => onChange("board")}
        className="h-7 gap-1.5 px-2"
      >
        <Columns3 aria-hidden className="size-4" />
        Board
      </Button>
    </div>
  );
}

export interface CaseloadShellProps {
  caseload: AdmissionsCaseSummary[];
  cohorts: AdmissionsCohortDto[];
  counselors: AdmissionsCounselorDto[];
  /** Resource library topic groups (listResources, CM-92). */
  resourceGroups: AdmissionsResourceTopicGroup[];
  /** Postgres-agnostic session role — "counselor" or "admin" on this shell. */
  viewerRole: CaseRole;
}

/** The /admissions counselor/admin workspace (caseload table + board). */
export function CaseloadShell({
  caseload,
  cohorts,
  counselors,
  resourceGroups,
  viewerRole,
}: CaseloadShellProps) {
  const router = useRouter();
  const [view, setView] = useState<CaseloadView>("table");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const kpis = computeCaseloadKpis(caseload);

  const handleCreated = () => {
    setDialogOpen(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-heading text-lg font-semibold">Admissions caseload</h1>
          <p className="text-sm text-muted-foreground">
            University admissions cases across your cohorts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          {viewerRole === "admin" ? (
            <Button
              type="button"
              variant="outline"
              data-testid="open-manage"
              onClick={() => setManageOpen(true)}
            >
              <Settings aria-hidden className="size-4" />
              Manage
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            data-testid="open-resources"
            onClick={() => setResourcesOpen(true)}
          >
            <BookOpen aria-hidden className="size-4" />
            Resources
          </Button>
          <Button type="button" onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden className="size-4" />
            New case
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Active cases" value={kpis.statusCounts.active} />
        <KpiTile label="Committed" value={kpis.statusCounts.committed} />
        <KpiTile label="Completed" value={kpis.statusCounts.completed} />
        <KpiTile label="All cases" value={kpis.totalCases} />
      </div>

      {view === "table" ? <CaseloadTable rows={caseload} /> : <CaseloadBoard rows={caseload} />}

      <CreateCaseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        cohorts={cohorts}
        counselors={counselors}
        onCreated={handleCreated}
      />

      {/* ── Resource library (CM-92 — global, staff-managed) ── */}
      <Dialog open={resourcesOpen} onOpenChange={setResourcesOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Resource library</DialogTitle>
            <DialogDescription>
              Curated links shown to every student in their portal.
            </DialogDescription>
          </DialogHeader>
          <ResourcesPanel groups={resourceGroups} viewerRole={viewerRole} />
        </DialogContent>
      </Dialog>

      {/* ── Manage (admin-only — counselors, cohorts, templates) ── */}
      {viewerRole === "admin" ? (
        <Dialog open={manageOpen} onOpenChange={setManageOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Manage admissions</DialogTitle>
              <DialogDescription>
                Counselor registry, graduation cohorts, and checklist templates.
              </DialogDescription>
            </DialogHeader>
            <ManagePanel counselors={counselors} cohorts={cohorts} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Suspense fallback for /admissions (>300ms loads, design §5.4). */
export function CaseloadSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading caseload">
      <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-20 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
