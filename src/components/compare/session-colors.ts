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

export function rgba(color: string, alpha: number): string {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function sessionBgColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.28)";
  return rgba(tutorColor ?? "#888888", 0.28);
}

export function sessionFrameColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.35)";
  return rgba(tutorColor ?? "#888888", 0.35);
}

export function sessionTextColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "#dc2626";
  return tutorColor ?? "#888888";
}

/** Tutor lane colors: sky blue, amber, purple */
export const TUTOR_COLORS = ["#3b82f6", "#e67e22", "#7c3aed"];

export function sessionBorderStyle(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  const color = isConflict ? "#ef4444" : (tutorColor ?? "#888888");
  return `3px solid ${color}`;
}
