import { Video, MapPin, HelpCircle } from "lucide-react";

/**
 * Modality UX mapping for session cards (MOD-04, D-12..D-16).
 * Icon choice: high+online → Video; high+onsite → MapPin; low OR unknown → HelpCircle.
 * Popover label follows D-15 exactly; no corroboration-suffix on high per D-16.
 * Low-confidence renders identical to unknown per D-14 (Pitfall 3 hard rule).
 *
 * TODO(future phase): when `medium` tier is first emitted (per 06-CONTEXT.md D-03),
 * extend this helper to branch on `confidence === "medium"` with corroborated-signal phrasing.
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
