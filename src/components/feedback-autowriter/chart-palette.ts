import { chartColors } from "@/components/sales-dashboard/chart-canvas";
import { chartPalette, type AutowriterChartColors } from "./chart-configs";

/**
 * Static approximations of `--conflict` and `--card`, used only while the CSS variables cannot be read (on the
 * server). Charts are drawn in the browser, so these never reach a painted chart.
 */
const FALLBACK = { conflict: "#dc5f4b", card: "#fdfcfa" };

/** The dashboard's chart palette from the active theme's CSS variables. Call it in the browser, inside `useMemo`. */
export function autowriterChartColors(): AutowriterChartColors {
  if (typeof window === "undefined" || typeof document === "undefined") return chartPalette(chartColors(), FALLBACK);
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return chartPalette(chartColors(), { conflict: read("--conflict", FALLBACK.conflict), card: read("--card", FALLBACK.card) });
}
