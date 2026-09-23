import { physicalRoom } from "./room-policy";
import { computeOverlapColumns } from "@/lib/calendar/overlap-layout";
import {
  summarizeClassroomHours, summarizeClassroomDay, formatClassroomDaySummary,
  type ClassroomHourItem, type ClassroomHourSummary, type ClassroomDaySummary,
} from "./hourly-summary";

// Layout constants — proven to fit A4 landscape at the approved (Kevin-verified) render.
export const GRID_UNIT_WIDTH_MM = 15.2;
export const GRID_RAIL_WIDTH_MM = 23;
export const GRID_HOUR_HEIGHT_MM = 12.2;
export const GRID_SUMMARY_PANEL_WIDTH_MM = 62;
export const GRID_NO_ROOM_COLUMN_UNITS = 4;
export const GRID_UNITS_PER_PAGE = 17;        // rail 23mm + 17 × 15.2mm columns ≈ A4-landscape usable width
export const GRID_SUMMARY_PANEL_UNITS = 5;    // ceil(62 / 15.2) — reserves ≥62mm of trailing width on page 1
export const GRID_DEFAULT_START_MINUTE = 8 * 60;
export const GRID_DEFAULT_END_MINUTE = 21 * 60;
export const GRID_FLOOR_MINUTE = 7 * 60;
export const GRID_CEIL_MINUTE = 21 * 60;

export interface PrintGridSourceBlock {
  rowId: string;
  tutorDisplayName: string;
  startMinute: number;
  endMinute: number;
  /** Display text; only matched against the catalog when status is assigned/needs_review. */
  room: string;
  status: string; // "assigned" | "needs_review" | "no_room" | "remote"
  students: string[];
}

export interface PrintGridRoom {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
  hasTv?: boolean;
  category?: "standard" | "overflow_only" | "online_only";
}

export interface PrintGridBlock {
  rowId: string;
  startMinute: number;
  endMinute: number;
  tutor: string;
  label: string;
  status: string;
  column: number;
  totalColumns: number;
}

export interface PrintGridColumn {
  key: string;
  kind: "room" | "no_room" | "online";
  title: string;
  subtitle: string;
  units: number;
  category?: "standard" | "overflow_only" | "online_only";
  blocks: PrintGridBlock[];
}

export interface PrintGrid {
  bounds: { startMinute: number; endMinute: number };
  columns: PrintGridColumn[]; // rooms (given order) then No room then Online — never reordered
  hours: ClassroomHourSummary[];
  day: ClassroomDaySummary;
  daySummaryLine: string;
  cancelledCount: number;
}

/** "Tutor Name (Nickname)" -> "Nickname"; else the first word of the name; empty -> "—". */
export function studentNickname(name: string): string {
  const match = /\(([^)]+)\)/.exec(name);
  if (match) return match[1].trim();
  return name.trim().split(/\s+/)[0] || "—";
}

export function blockLabel(students: string[]): string {
  if (!students.length) return "—";
  const label = studentNickname(students[0]);
  return students.length > 1 ? `${label} +${students.length - 1}` : label;
}

function computeBounds(blocks: PrintGridSourceBlock[]): { startMinute: number; endMinute: number } {
  let start = GRID_DEFAULT_START_MINUTE;
  let end = GRID_DEFAULT_END_MINUTE;
  for (const block of blocks) {
    start = Math.min(start, Math.max(GRID_FLOOR_MINUTE, Math.floor(block.startMinute / 60) * 60));
    end = Math.max(end, Math.min(GRID_CEIL_MINUTE, Math.ceil(block.endMinute / 60) * 60));
  }
  return { startMinute: start, endMinute: end };
}

export function buildPrintGrid(blocks: PrintGridSourceBlock[], catalog: PrintGridRoom[], cancelledCount: number): PrintGrid {
  const columns: PrintGridColumn[] = catalog.map(room => ({
    key: room.id, kind: "room", title: room.name,
    subtitle: room.category === "online_only" ? "online booth" : `${room.hasTv ? "TV · " : ""}${room.capacity} seats`,
    units: 1, category: room.category, blocks: [],
  }));
  const noRoomCol: PrintGridColumn = { key: "no-room", kind: "no_room", title: "No room (0)", subtitle: "needs a room", units: GRID_NO_ROOM_COLUMN_UNITS, blocks: [] };
  const onlineCol: PrintGridColumn = { key: "online", kind: "online", title: "Online (no room)", subtitle: "tutor off-site", units: 1, blocks: [] };
  const byKey = new Map([...columns, noRoomCol, onlineCol].map(col => [col.key, col]));

  const classified: ClassroomHourItem[] = [];
  for (const block of blocks) {
    let target: PrintGridColumn;
    let needsCentreRoom: boolean;
    let placed: boolean;
    if (block.status === "remote") {
      target = onlineCol; needsCentreRoom = false; placed = false;
    } else {
      const matched = catalog.find(room => physicalRoom(room.name) === physicalRoom(block.room));
      if ((block.status === "assigned" || block.status === "needs_review") && matched) {
        target = byKey.get(matched.id)!; needsCentreRoom = true; placed = true;
      } else {
        target = noRoomCol; needsCentreRoom = true; placed = false;
      }
    }
    target.blocks.push({
      rowId: block.rowId, startMinute: block.startMinute, endMinute: block.endMinute,
      tutor: block.tutorDisplayName, label: blockLabel(block.students), status: block.status, column: 0, totalColumns: 1,
    });
    classified.push({ startMinute: block.startMinute, endMinute: block.endMinute, needsCentreRoom, placed });
  }
  noRoomCol.title = `No room (${noRoomCol.blocks.length})`;

  for (const col of [...columns, noRoomCol, onlineCol]) {
    col.blocks.sort((a, b) => a.startMinute - b.startMinute || a.tutor.localeCompare(b.tutor));
    const lanes = computeOverlapColumns(col.blocks.map(b => ({ startMinute: b.startMinute, endMinute: b.endMinute })));
    lanes.forEach((lane, i) => { col.blocks[i].column = lane.column; col.blocks[i].totalColumns = lane.totalColumns; });
  }

  const bounds = computeBounds(blocks);
  const roomCount = catalog.length; // includes online-booth rooms — matches the approved "only 24 rooms" denominator
  const hours = summarizeClassroomHours(classified, { ...bounds, roomCount });
  const day = summarizeClassroomDay(classified, { ...bounds, roomCount });
  return { bounds, columns: [...columns, noRoomCol, onlineCol], hours, day, daySummaryLine: formatClassroomDaySummary(day), cancelledCount };
}

export function splitGridColumnsIntoPages(
  columns: PrintGridColumn[], unitsPerPage: number = GRID_UNITS_PER_PAGE, summaryPanelUnits: number = GRID_SUMMARY_PANEL_UNITS,
): { columns: PrintGridColumn[]; hasSummaryPanel: boolean }[] {
  const pages: PrintGridColumn[][] = [];
  let page: PrintGridColumn[] = [];
  let used = 0;
  let isFirst = true;
  for (const col of columns) {
    const budget = isFirst ? unitsPerPage - summaryPanelUnits : unitsPerPage;
    if (page.length > 0 && used + col.units > budget) {
      pages.push(page);
      page = []; used = 0; isFirst = false;
    }
    page.push(col); used += col.units;
  }
  if (page.length > 0) pages.push(page);
  const hasSummaryPanel = pages.length > 0 && (unitsPerPage - pages[0].reduce((sum, col) => sum + col.units, 0)) >= summaryPanelUnits;
  const out: { columns: PrintGridColumn[]; hasSummaryPanel: boolean }[] = pages.map((cols, i) => ({ columns: cols, hasSummaryPanel: i === 0 && hasSummaryPanel }));
  if (!hasSummaryPanel) out.splice(1, 0, { columns: [], hasSummaryPanel: true }); // dedicated summary-only sheet
  return out;
}
