"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ComparePanel } from "./compare-panel";

// ─────────────────────────────────────────────────────────────────────────────
// Wide modal wrapper around the existing ComparePanel. Opened from the
// ShortlistBar "Compare (N)" button. The panel is rendered verbatim — it owns
// its own compare fetch keyed on unitIds — so the sheet adds no data layer.
// DialogContent's default narrow width (sm:max-w-sm) is overridden to a wide,
// internally-scrolling surface for the side-by-side metric table.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompareSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitIds: number[];
  onRemove: (unitId: number) => void;
  onAdd: (unitId: number) => void;
  onClear: () => void;
}

export function CompareSheet({
  open,
  onOpenChange,
  unitIds,
  onRemove,
  onAdd,
  onClear,
}: CompareSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-full overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Compare institutions</DialogTitle>
        </DialogHeader>
        <ComparePanel
          unitIds={unitIds}
          onRemove={onRemove}
          onAdd={onAdd}
          onClear={onClear}
        />
      </DialogContent>
    </Dialog>
  );
}
