import type { CompareSessionBlock } from "@/lib/search/types";

const ONLINE_PATTERNS = ["http", "online", "learn.", "zoom", "meet.google", "google meet", "virtual"];
const ONSITE_PATTERNS = ["onsite", "in person"];

function hexToRgb(color: string): [number, number, number] {
  const normalized = color.replace("#", "");
  const hex = normalized.length === 3
    ? normalized
        .split("")
        .map((char) => `${char}${char}`)
        .join("")
    : normalized;

  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return [136, 136, 136];
  }

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function rgba(color: string, alpha: number): string {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fallbackSessionMode(
  sessionType?: string,
  location?: string,
): CompareSessionBlock["modality"] {
  const normalizedType = sessionType?.trim().toLowerCase();
  if (normalizedType === "online" || normalizedType === "virtual") {
    return "online";
  }
  if (
    normalizedType === "onsite" ||
    normalizedType === "in-person" ||
    normalizedType === "offline"
  ) {
    return "onsite";
  }

  const normalizedLocation = location?.trim().toLowerCase();
  if (
    normalizedLocation &&
    ONLINE_PATTERNS.some((pattern) => normalizedLocation.includes(pattern))
  ) {
    return "online";
  }
  if (
    normalizedLocation &&
    ONSITE_PATTERNS.some((pattern) => normalizedLocation.includes(pattern))
  ) {
    return "onsite";
  }

  return "unknown";
}

export function sessionDisplayMode(
  modality: CompareSessionBlock["modality"],
  sessionType?: string,
  location?: string,
): CompareSessionBlock["modality"] {
  return modality === "unknown"
    ? fallbackSessionMode(sessionType, location)
    : modality;
}

export function sessionBgColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.18)";
  return rgba(tutorColor ?? "#888888", 0.18);
}

export function sessionFrameColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.22)";
  return rgba(tutorColor ?? "#888888", 0.22);
}

export function sessionTextColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "#dc2626";
  return tutorColor ?? "#888888";
}

export function sessionBorderStyle(
  tutorColor: string | undefined,
  isConflict: boolean,
  modality: CompareSessionBlock["modality"],
  sessionType?: string,
  location?: string,
): string {
  const color = isConflict ? "#ef4444" : (tutorColor ?? "#888888");
  const style = sessionDisplayMode(modality, sessionType, location) === "online"
    ? "dashed"
    : "solid";
  return `3px ${style} ${color}`;
}
