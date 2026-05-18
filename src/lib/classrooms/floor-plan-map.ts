import {
  FLOOR_PLAN_ROOMS,
  FLOOR_PLAN_VIEWBOX,
  type FloorPlanRoomGeometry,
} from "./floor-plan";

const BRAND_BLUE = "#2563eb";
const BRAND_BLUE_DARK = "#1e40af";
const BRAND_ORANGE = "#f97316";
const BRAND_WHITE = "#ffffff";
const BORDER = "#bfdbfe";
const TEXT = "#0f172a";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function selectedRoomOrder(roomNames: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const roomName of roomNames) {
    const normalized = roomName.trim();
    if (!normalized || result.has(normalized)) continue;
    result.set(normalized, result.size + 1);
  }
  return result;
}

function roomText(geometry: FloorPlanRoomGeometry, highlighted: boolean): string {
  const lineHeight = geometry.labelLines.length > 2 ? 22 : 24;
  const fontSize = geometry.labelLines.some((line) => line.length > 12) ? 23 : 26;
  const y = geometry.labelY - ((geometry.labelLines.length - 1) * lineHeight) / 2;
  return `
    <text x="${geometry.labelX}" y="${y}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="${highlighted ? BRAND_WHITE : TEXT}">
      ${geometry.labelLines.map((line, index) => `
        <tspan x="${geometry.labelX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>
      `).join("")}
    </text>`;
}

function roomMarker(geometry: FloorPlanRoomGeometry, order: number): string {
  const cy = Math.max(geometry.labelY - 72, 65);
  return `
    <g>
      <circle cx="${geometry.labelX}" cy="${cy}" r="33" fill="${BRAND_BLUE_DARK}" stroke="${BRAND_WHITE}" stroke-width="7" />
      <text x="${geometry.labelX}" y="${cy + 11}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="31" font-weight="800" fill="${BRAND_WHITE}">${order}</text>
    </g>`;
}

export function renderFloorPlanMapSvg(roomNames: string[] = []): string {
  const selected = selectedRoomOrder(roomNames);

  const rooms = FLOOR_PLAN_ROOMS.map((geometry) => {
    const order = selected.get(geometry.roomName);
    const highlighted = Boolean(order);
    const fill = highlighted
      ? BRAND_ORANGE
      : geometry.assignable
        ? BRAND_WHITE
        : "#e0f2fe";
    const stroke = highlighted ? BRAND_BLUE_DARK : BORDER;
    const strokeWidth = highlighted ? 8 : 4;
    return `
      <g aria-label="${escapeXml(geometry.label)}">
        <path d="${geometry.d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />
        ${roomText(geometry, highlighted)}
        ${order ? roomMarker(geometry, order) : ""}
      </g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${FLOOR_PLAN_VIEWBOX}" width="1600" height="900" role="img" aria-label="BeGifted floor plan">
  <rect x="0" y="0" width="1600" height="900" rx="26" fill="${BRAND_WHITE}" />
  <rect x="28" y="28" width="1544" height="844" rx="24" fill="#eff6ff" stroke="${BRAND_BLUE}" stroke-width="4" />
  <path d="M245 220h855M430 815h620M470 220v260M1090 220v540" fill="none" stroke="${BRAND_BLUE}" stroke-width="5" stroke-dasharray="14 14" opacity="0.35" />
  ${rooms}
</svg>`;
}
