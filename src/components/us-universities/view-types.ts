// ── Shared prop contracts for US Universities client components ─────────
// The shell and every leaf component code against these interfaces so the
// pieces compose without drift.

import type {
  UsUniversitiesOverview,
  FilterParams,
  StateFacet,
  Cip2Option,
} from "@/lib/us-universities/types";

export interface OverviewChartsProps {
  overview: UsUniversitiesOverview;
  /** True when the Overview tab is visible (Chart.js must resize on show). */
  active: boolean;
  /** Open an institution profile (e.g. clicking a scatter point). */
  onSelect: (unitId: number) => void;
}

export interface InstitutionFiltersProps {
  states: StateFacet[];
  cip2Options: Cip2Option[];
  value: FilterParams;
  onChange: (next: FilterParams) => void;
}

export interface InstitutionTableProps {
  overview: UsUniversitiesOverview;
  /** Open the profile dialog for a row. */
  onSelect: (unitId: number) => void;
  /** Add a row to the compare set. */
  onAddCompare: (unitId: number) => void;
  /** Unit ids already in the compare set (to disable/mark rows). */
  compareIds: number[];
}

export interface InstitutionProfileDialogProps {
  unitId: number | null;
  onClose: () => void;
  onAddCompare: (unitId: number) => void;
}

export interface InstitutionSearchComboboxProps {
  placeholder?: string;
  onSelect: (unitId: number, name: string) => void;
}

export interface ComparePanelProps {
  unitIds: number[];
  onRemove: (unitId: number) => void;
  onAdd: (unitId: number) => void;
  onClear: () => void;
}
