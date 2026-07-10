"use client";

// ----------------------------------------------------------------------------
// Admissions manage panel (admin settings surface) — Tabs hosting the three
// admin registries: Counselors (registry + sign-in capability), Cohorts
// (registry + template push), and Templates (version-controlled checklist
// editor). A cohort row's "Edit template" action jumps to the Templates tab
// with that cohort preselected (openTemplateForCohort).
//
// Role gate: none client-side — the caseload shell mounts this inside a
// dialog rendered ONLY for admin viewers, and every route the hosted
// managers call re-resolves admin rights from Postgres on each write
// (requireAdmissionsAdmin, design §2.2).
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AdmissionsCohortDto, AdmissionsCounselorDto } from "@/lib/admissions/types";
import { CohortsManager } from "./cohorts-manager";
import { CounselorsManager } from "./counselors-manager";
import { TemplateEditor } from "./template-editor";

// ── Pure helpers (exported for tests) ───────────────────────────────────

/** The manage-panel tabs in display order. */
export const MANAGE_TABS = [
  { key: "counselors", label: "Counselors" },
  { key: "cohorts", label: "Cohorts" },
  { key: "templates", label: "Templates" },
] as const;

/** Stable manage-tab key ("counselors" | "cohorts" | "templates"). */
export type ManageTab = (typeof MANAGE_TABS)[number]["key"];

/** The tab the panel opens on. */
export const INITIAL_MANAGE_TAB: ManageTab = "counselors";

/**
 * Resolves a raw tab value (e.g. from the Tabs primitive's onValueChange) to
 * a known tab key. Unknown values fall back to the initial tab (fail-closed
 * — never guess a different tab).
 */
export function resolveManageTab(raw: unknown): ManageTab {
  const match = MANAGE_TABS.find((tab) => tab.key === raw);
  return match ? match.key : INITIAL_MANAGE_TAB;
}

/** Panel state produced by a cohort row's "Edit template" hand-off. */
export interface ManageTemplateJump {
  activeTab: ManageTab;
  selectedCohortId: string;
}

/**
 * Next panel state for a cohort row's "Edit template" action: switch to the
 * Templates tab with that cohort preselected, so the editor lazily loads the
 * cohort's versions without a second manual pick.
 */
export function openTemplateForCohort(cohortId: string): ManageTemplateJump {
  return { activeTab: "templates", selectedCohortId: cohortId };
}

// ── Panel ───────────────────────────────────────────────────────────────

/** Props for ManagePanel — registries are server-fetched by the page. */
export interface ManagePanelProps {
  /** Full counselor registry, active AND inactive rows. */
  counselors: AdmissionsCounselorDto[];
  cohorts: AdmissionsCohortDto[];
  /** Starting tab (tests/deep-links); defaults to Counselors. */
  initialTab?: ManageTab;
  /** Cohort preselected in the Templates tab (tests/deep-links). */
  initialCohortId?: string | null;
}

/**
 * Admin manage panel: Counselors / Cohorts / Templates tabs hosting the
 * corresponding managers. Owns the active tab plus the Templates tab's
 * cohort selection so CohortsManager's "Edit template" can jump straight to
 * the editor for that cohort (openTemplateForCohort). Mounted inside the
 * caseload shell's admin-only Manage dialog.
 */
export function ManagePanel({
  counselors,
  cohorts,
  initialTab = INITIAL_MANAGE_TAB,
  initialCohortId = null,
}: ManagePanelProps) {
  const [activeTab, setActiveTab] = useState<ManageTab>(initialTab);
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(initialCohortId);

  /** "Edit template" hand-off from a cohort row (CohortsManager). */
  const handleEditTemplate = useCallback((cohortId: string) => {
    const next = openTemplateForCohort(cohortId);
    setActiveTab(next.activeTab);
    setSelectedCohortId(next.selectedCohortId);
  }, []);

  return (
    <Tabs
      data-testid="manage-panel"
      value={activeTab}
      onValueChange={(value) => setActiveTab(resolveManageTab(value))}
    >
      <TabsList className="w-full">
        {MANAGE_TABS.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} data-testid={`manage-tab-${tab.key}`}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="counselors">
        <CounselorsManager counselors={counselors} />
      </TabsContent>
      <TabsContent value="cohorts">
        <CohortsManager cohorts={cohorts} onEditTemplate={handleEditTemplate} />
      </TabsContent>
      <TabsContent value="templates">
        <TemplateEditor
          cohorts={cohorts}
          selectedCohortId={selectedCohortId}
          onSelectCohort={setSelectedCohortId}
        />
      </TabsContent>
    </Tabs>
  );
}
