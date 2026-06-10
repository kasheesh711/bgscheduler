"use client";

import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Shared Chart.js canvas, extracted from gm-command-center.tsx so every
// workspace panel renders charts the same way. New charts must use
// chartColors() tokens (no hardcoded hexes).
// ----------------------------------------------------------------------------

export interface ChartThemeColors {
  /** --chart-1 … --chart-5 in order. */
  chart: string[];
  border: string;
  mutedForeground: string;
}

const FALLBACK_COLORS: ChartThemeColors = {
  chart: ["#3b82f6", "#e67e22", "#7c3aed", "#10b981", "#64748b"],
  border: "#e2e8f0",
  mutedForeground: "#64748b",
};

/**
 * Read the theme chart palette from CSS custom properties so new charts follow
 * the active (light/dark) theme. Falls back to static values during SSR.
 */
export function chartColors(): ChartThemeColors {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return FALLBACK_COLORS;
  }
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    chart: [1, 2, 3, 4, 5].map((index) => read(`--chart-${index}`, FALLBACK_COLORS.chart[index - 1])),
    border: read("--border", FALLBACK_COLORS.border),
    mutedForeground: read("--muted-foreground", FALLBACK_COLORS.mutedForeground),
  };
}

interface ChartCanvasProps {
  config: ChartConfiguration;
  className?: string;
  /**
   * Accessible name for the chart — Chart.js canvases are opaque to screen
   * readers, so the wrapper is exposed as role="img" when a label is given.
   */
  ariaLabel?: string;
  /**
   * Whether the surrounding tab panel is currently visible. Chart.js cannot
   * size itself inside a hidden panel, so the chart is resized whenever the
   * panel is re-activated.
   */
  active?: boolean;
}

export function ChartCanvas({ config, className, ariaLabel, active = true }: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, config);
    chartRef.current = chart;
    return () => {
      chartRef.current = null;
      chart.destroy();
    };
  }, [config]);

  useEffect(() => {
    if (active) chartRef.current?.resize();
  }, [active]);

  return (
    <div
      className={cn("relative min-h-0 flex-1", className)}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
