import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The small pieces every section of the autowriter dashboard is drawn with (mockup A): the panel, the tiny uppercase
 * label, the count chip and the tag. Presentational only.
 */

export type Tone = "neutral" | "blue" | "amber" | "green" | "red";

const TAG_TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  blue: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  green: "border-available/30 bg-available/10 text-available",
  red: "border-conflict/30 bg-conflict/10 text-conflict",
};

/** Text colour of a tone, for a figure or a note outside a tag. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  blue: "text-sky-700 dark:text-sky-300",
  amber: "text-amber-700 dark:text-amber-400",
  green: "text-available",
  red: "text-conflict",
};

/** A white card with the page's border and corner. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]", className)} {...props} />;
}

/** A tiny uppercase label. */
export function Upper({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground", className)}>{children}</span>;
}

/** A count next to a heading. */
export function CountChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rounded bg-muted px-1.5 py-[3px] text-[10px] font-semibold leading-none text-muted-foreground", className)}>{children}</span>;
}

/** A small bordered tag: the evidence of a post, a deadline, a status. */
export function Tag({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-[5px] py-[3px] text-[10px] font-medium leading-none whitespace-nowrap", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

/** A panel that opens on a click: the page's detail sections, collapsed by default. */
export function Disclosure({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-[10px] border bg-card shadow-[0_2px_3px_rgb(37_52_65/0.02)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 outline-none hover:bg-muted/30 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-[9px]">
          <ChevronRight aria-hidden className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="text-[13px] font-semibold">{title}</span>
          {count !== undefined ? <CountChip>{count}</CountChip> : null}
        </span>
        {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="border-t">{children}</div>
    </details>
  );
}
