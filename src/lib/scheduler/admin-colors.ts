export interface AdminAccent {
  key: string;
  label: string;
  dotClassName: string;
  borderClassName: string;
  bgClassName: string;
  textClassName: string;
  bubbleClassName: string;
}

const ADMIN_ACCENTS = [
  {
    key: "sky",
    dotClassName: "bg-sky-500",
    borderClassName: "border-sky-300",
    bgClassName: "bg-sky-50 dark:bg-sky-950/30",
    textClassName: "text-sky-700 dark:text-sky-200",
    bubbleClassName: "border-l-4 border-l-sky-400",
  },
  {
    key: "amber",
    dotClassName: "bg-amber-500",
    borderClassName: "border-amber-300",
    bgClassName: "bg-amber-50 dark:bg-amber-950/30",
    textClassName: "text-amber-700 dark:text-amber-200",
    bubbleClassName: "border-l-4 border-l-amber-400",
  },
  {
    key: "emerald",
    dotClassName: "bg-emerald-500",
    borderClassName: "border-emerald-300",
    bgClassName: "bg-emerald-50 dark:bg-emerald-950/30",
    textClassName: "text-emerald-700 dark:text-emerald-200",
    bubbleClassName: "border-l-4 border-l-emerald-400",
  },
  {
    key: "violet",
    dotClassName: "bg-violet-500",
    borderClassName: "border-violet-300",
    bgClassName: "bg-violet-50 dark:bg-violet-950/30",
    textClassName: "text-violet-700 dark:text-violet-200",
    bubbleClassName: "border-l-4 border-l-violet-400",
  },
  {
    key: "rose",
    dotClassName: "bg-rose-500",
    borderClassName: "border-rose-300",
    bgClassName: "bg-rose-50 dark:bg-rose-950/30",
    textClassName: "text-rose-700 dark:text-rose-200",
    bubbleClassName: "border-l-4 border-l-rose-400",
  },
  {
    key: "cyan",
    dotClassName: "bg-cyan-500",
    borderClassName: "border-cyan-300",
    bgClassName: "bg-cyan-50 dark:bg-cyan-950/30",
    textClassName: "text-cyan-700 dark:text-cyan-200",
    bubbleClassName: "border-l-4 border-l-cyan-400",
  },
] as const;

function hashIdentity(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function adminAccentFor(identity?: string | null, fallbackName?: string | null): AdminAccent {
  const normalized = (identity || fallbackName || "unknown-admin").trim().toLowerCase();
  const accent = ADMIN_ACCENTS[hashIdentity(normalized) % ADMIN_ACCENTS.length];
  return {
    ...accent,
    label: fallbackName?.trim() || identity?.trim() || "Unknown admin",
  };
}
