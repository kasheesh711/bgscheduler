"use client";

import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";

// ----------------------------------------------------------------------------
// Card/table view toggle — a controlled two-button segmented control. The
// active view's button is `secondary` + aria-pressed; the shell owns the
// `view` state (default "cards", not persisted) and re-renders the results
// region as a card gallery or the table presenter accordingly.
// ----------------------------------------------------------------------------

export type ResultsView = "cards" | "table";

export interface CardTableToggleProps {
  view: ResultsView;
  onChange: (view: ResultsView) => void;
}

export function CardTableToggle({ view, onChange }: CardTableToggleProps) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-0.5" role="group" aria-label="Results layout">
      <Button
        type="button"
        variant={view === "cards" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Card view"
        aria-pressed={view === "cards"}
        onClick={() => onChange("cards")}
        className="h-7 gap-1.5 px-2"
      >
        <LayoutGrid aria-hidden className="size-4" />
        Cards
      </Button>
      <Button
        type="button"
        variant={view === "table" ? "secondary" : "ghost"}
        size="sm"
        aria-label="Table view"
        aria-pressed={view === "table"}
        onClick={() => onChange("table")}
        className="h-7 gap-1.5 px-2"
      >
        <List aria-hidden className="size-4" />
        Table
      </Button>
    </div>
  );
}
