import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The page's small presentational pieces, drawn like the autowriter dashboard's (mockup A). */

export type Tone = "neutral" | "amber" | "green" | "red";

/** The `available` token is a fill colour: as small text on a light card it is darkened to stay readable. */
const GREEN_TEXT = "text-[color:color-mix(in_oklch,var(--available),black_32%)] dark:text-available";

const TAG_TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  green: `border-available/30 bg-available/10 ${GREEN_TEXT}`,
  red: "border-conflict/30 bg-conflict/10 text-conflict",
};

export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]", className)} {...props} />;
}

export function Upper({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground", className)}>{children}</span>;
}

export function CountChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rounded bg-muted px-1.5 py-[3px] text-[10px] font-semibold leading-none text-muted-foreground", className)}>{children}</span>;
}

export function Tag({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-[5px] py-[3px] text-[10px] font-medium leading-none whitespace-nowrap", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Disclosure({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]">
      <summary className="flex cursor-pointer list-none items-center gap-[9px] px-5 py-3.5 outline-none hover:bg-muted/30 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="text-[13px] font-semibold">{title}</span>
        {count !== undefined ? <CountChip>{count}</CountChip> : null}
      </summary>
      <div className="border-t">{children}</div>
    </details>
  );
}
