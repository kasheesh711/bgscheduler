"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ----------------------------------------------------------------------------
// Period toolbar — extraction-only of the shell's preset buttons + date
// inputs. Identical preset behavior; computed presets are a flagged follow-up
// pending owner sign-off.
// ----------------------------------------------------------------------------

export const SALES_PERIODS = [
  { key: "all", label: "All" },
  { key: "y2025", label: "2025" },
  { key: "y2026", label: "2026" },
  { key: "q1", label: "Q1 2026" },
  { key: "thismonth", label: "This Month" },
] as const;

export type SalesPeriodKey = (typeof SALES_PERIODS)[number]["key"];

interface PeriodToolbarProps {
  period: SalesPeriodKey;
  from: string;
  to: string;
  onSelectPreset: (period: SalesPeriodKey) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

export function PeriodToolbar({ period, from, to, onSelectPreset, onFromChange, onToChange }: PeriodToolbarProps) {
  return (
    <div className="flex flex-col gap-3 border-b bg-card px-4 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-6">
      <div className="flex flex-wrap items-center gap-2">
        {SALES_PERIODS.map((item) => (
          <Button
            key={item.key}
            size="sm"
            variant={period === item.key ? "default" : "outline"}
            onClick={() => onSelectPreset(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input type="date" value={from} onChange={(event) => onFromChange(event.target.value)} className="w-36" />
        <span className="text-xs text-muted-foreground">to</span>
        <Input type="date" value={to} onChange={(event) => onToChange(event.target.value)} className="w-36" />
      </div>
    </div>
  );
}
