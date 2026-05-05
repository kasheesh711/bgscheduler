import { Video, MapPin, HelpCircle } from "lucide-react";

/**
 * Modality UX mapping for session cards (MOD-04, D-12..D-16).
 * Icon choice: high+online → Video; high+onsite → MapPin; low OR unknown → HelpCircle.
 * Popover label follows D-15 exactly; no corroboration-suffix on high per D-16.
 * Low-confidence renders identical to unknown per D-14 (Pitfall 3 hard rule).
 * Medium confidence is type-reserved by Phase 6 but no resolver emits it today; until a producer exists,
 * medium intentionally follows the high-confidence display branch.
 */
export function modalityDisplay(
  modality: "online" | "onsite" | "unknown",
  confidence: "high" | "medium" | "low",
): { Icon: typeof Video; label: string; ariaLabel: string } {
  if (confidence === "low") {
    // Low → identical to unknown visually (HelpCircle). Popover reveals inference.
    const label = modality === "online"
      ? "Likely online — unconfirmed"
      : modality === "onsite"
        ? "Likely onsite — unconfirmed"
        : "Unknown";
    return { Icon: HelpCircle, label, ariaLabel: label };
  }
  if (modality === "online") return { Icon: Video, label: "Online", ariaLabel: "Online" };
  if (modality === "onsite") return { Icon: MapPin, label: "Onsite", ariaLabel: "Onsite" };
  return { Icon: HelpCircle, label: "Unknown", ariaLabel: "Unknown" };
}
