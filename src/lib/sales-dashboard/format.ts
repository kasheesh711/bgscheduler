// ————————————————————————————————————————————————————————————————————————————
// Shared sales-dashboard formatters — single source of truth consolidating the
// previously duplicated copies in gm-command-center.tsx, source-manager.tsx,
// and sales-dashboard-shell.tsx.
// ————————————————————————————————————————————————————————————————————————————

export function formatCurrency(value: number, compact = false): string {
  const rounded = Math.round(value);
  if (compact && Math.abs(rounded) >= 1_000_000) {
    return `฿${(rounded / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  if (compact && Math.abs(rounded) >= 1_000) {
    return `฿${Math.round(rounded / 1_000).toLocaleString("en-US")}k`;
  }
  if (Math.abs(rounded) >= 1_000_000) {
    return `฿${(rounded / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  return `฿${rounded.toLocaleString("en-US")}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "Never imported";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
