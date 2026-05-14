import { getFloorPlanGeometry, sortRoomsByFloorPlan } from "./floor-plan";
import { NO_ROOM_AVAILABLE } from "./rooms";

export interface ClassroomVisualizationRoom {
  id: string;
  name: string;
  capacity: number;
  hasTv: boolean;
  category: "standard" | "overflow_only" | "online_only";
  active: boolean;
  sortOrder: number;
}

export interface ClassroomVisualizationRow {
  id: string;
  tutorDisplayName: string;
  startMinute: number;
  endMinute: number;
  sessionType: string | null;
  studentName: string | null;
  studentCount: number | null;
  subject: string | null;
  classType: string | null;
  title: string | null;
  minCapacity: number;
  overrideRoom: string | null;
  assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room";
  warnings: string[];
  publishStatus?: "not_published" | "skipped" | "success" | "failed";
}

export interface TimelineBounds {
  startMinute: number;
  endMinute: number;
  initialMinute: number;
}

export interface RoomOccupancySnapshot<TRow extends ClassroomVisualizationRow = ClassroomVisualizationRow> {
  room: ClassroomVisualizationRoom;
  activeRows: TRow[];
  load: number;
  loadRatio: number;
  status: "empty" | "occupied" | "full" | "over_capacity";
}

export interface RoomOccupancyState<TRow extends ClassroomVisualizationRow = ClassroomVisualizationRow> {
  currentMinute: number;
  rooms: Array<RoomOccupancySnapshot<TRow>>;
  reviewRows: TRow[];
}

export interface RoomCalendarEvent<TRow extends ClassroomVisualizationRow = ClassroomVisualizationRow> {
  id: string;
  row: TRow;
  roomName: string;
  isReview: boolean;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
  hasRoomConflict: boolean;
}

export interface HeatmapCell<TRow extends ClassroomVisualizationRow = ClassroomVisualizationRow> {
  id: string;
  roomName: string;
  startMinute: number;
  endMinute: number;
  rows: TRow[];
  load: number;
  loadRatio: number;
  active: boolean;
  isReview: boolean;
}

export const DEFAULT_TIMELINE_START_MINUTE = 7 * 60;
export const DEFAULT_TIMELINE_END_MINUTE = 21 * 60;
export const HEATMAP_BIN_MINUTES = 15;
export const REVIEW_LANE_ROOM_NAME = "Needs review";

export function buildTimelineBounds(
  rows: ClassroomVisualizationRow[],
  defaults: { startMinute?: number; endMinute?: number } = {},
): TimelineBounds {
  const defaultStart = defaults.startMinute ?? DEFAULT_TIMELINE_START_MINUTE;
  const defaultEnd = defaults.endMinute ?? DEFAULT_TIMELINE_END_MINUTE;
  if (rows.length === 0) {
    return {
      startMinute: defaultStart,
      endMinute: defaultEnd,
      initialMinute: defaultStart,
    };
  }

  const minStart = Math.min(...rows.map((row) => row.startMinute));
  const maxEnd = Math.max(...rows.map((row) => row.endMinute));
  return {
    startMinute: Math.min(defaultStart, minStart),
    endMinute: Math.max(defaultEnd, maxEnd),
    initialMinute: minStart,
  };
}

export function minuteToTimeLabel(minute: number): string {
  const clamped = Math.max(0, minute);
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function overlapsMinute(row: Pick<ClassroomVisualizationRow, "startMinute" | "endMinute">, minute: number): boolean {
  return row.startMinute <= minute && minute < row.endMinute;
}

export function overlapsRange(
  row: Pick<ClassroomVisualizationRow, "startMinute" | "endMinute">,
  startMinute: number,
  endMinute: number,
): boolean {
  return row.startMinute < endMinute && startMinute < row.endMinute;
}

export function getActiveRooms<T extends ClassroomVisualizationRoom>(rooms: T[]): T[] {
  return sortRoomsByFloorPlan(rooms.filter((room) => room.active));
}

export function shouldRouteRowToReview(
  row: ClassroomVisualizationRow,
  activeRoomNames: Set<string>,
): boolean {
  if (row.status !== "assigned") return true;
  if (row.assignedRoom === NO_ROOM_AVAILABLE) return true;
  if (!activeRoomNames.has(row.assignedRoom)) return true;
  if (!getFloorPlanGeometry(row.assignedRoom)) return true;
  return row.warnings.length > 0;
}

function activeRoomNameForRow(
  row: ClassroomVisualizationRow,
  activeRoomNames: Set<string>,
): string | null {
  return shouldRouteRowToReview(row, activeRoomNames) ? null : row.assignedRoom;
}

export function rowLoad(row: ClassroomVisualizationRow): number {
  const count = Number(row.studentCount);
  if (Number.isFinite(count) && count > 0) return count;
  return Math.max(1, row.minCapacity);
}

function loadRatio(load: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return load / capacity;
}

function occupancyStatus(load: number, capacity: number): RoomOccupancySnapshot["status"] {
  if (load <= 0) return "empty";
  if (capacity > 0 && load > capacity) return "over_capacity";
  if (capacity > 0 && load === capacity) return "full";
  return "occupied";
}

export function buildRoomOccupancyState<TRow extends ClassroomVisualizationRow>(
  rows: TRow[],
  rooms: ClassroomVisualizationRoom[],
  currentMinute: number,
): RoomOccupancyState<TRow> {
  const activeRooms = getActiveRooms(rooms);
  const activeRoomNames = new Set(activeRooms.map((room) => room.name));
  const byRoom = new Map(activeRooms.map((room) => [room.name, [] as TRow[]]));
  const reviewRows: TRow[] = [];

  for (const row of rows) {
    if (!overlapsMinute(row, currentMinute)) continue;
    const roomName = activeRoomNameForRow(row, activeRoomNames);
    if (!roomName) {
      reviewRows.push(row);
      continue;
    }
    byRoom.get(roomName)?.push(row);
  }

  return {
    currentMinute,
    rooms: activeRooms.map((room) => {
      const activeRows = byRoom.get(room.name) ?? [];
      const load = activeRows.reduce((sum, row) => sum + rowLoad(row), 0);
      return {
        room,
        activeRows,
        load,
        loadRatio: loadRatio(load, room.capacity),
        status: occupancyStatus(load, room.capacity),
      };
    }),
    reviewRows,
  };
}

export function buildHeatmapCells<TRow extends ClassroomVisualizationRow>(
  rows: TRow[],
  rooms: ClassroomVisualizationRoom[],
  bounds: TimelineBounds,
  binMinutes = HEATMAP_BIN_MINUTES,
): Array<HeatmapCell<TRow>> {
  const activeRooms = getActiveRooms(rooms);
  const activeRoomNames = new Set(activeRooms.map((room) => room.name));
  const cells: Array<HeatmapCell<TRow>> = [];

  for (const room of activeRooms) {
    for (let minute = bounds.startMinute; minute < bounds.endMinute; minute += binMinutes) {
      const endMinute = Math.min(minute + binMinutes, bounds.endMinute);
      const roomRows = rows.filter(
        (row) =>
          activeRoomNameForRow(row, activeRoomNames) === room.name &&
          overlapsRange(row, minute, endMinute),
      );
      const load = roomRows.reduce((sum, row) => sum + rowLoad(row), 0);
      cells.push({
        id: `${room.name}-${minute}`,
        roomName: room.name,
        startMinute: minute,
        endMinute,
        rows: roomRows,
        load,
        loadRatio: loadRatio(load, room.capacity),
        active: roomRows.length > 0,
        isReview: false,
      });
    }
  }

  const reviewRows = rows.filter((row) => shouldRouteRowToReview(row, activeRoomNames));
  if (reviewRows.length > 0) {
    for (let minute = bounds.startMinute; minute < bounds.endMinute; minute += binMinutes) {
      const endMinute = Math.min(minute + binMinutes, bounds.endMinute);
      const rowsInBin = reviewRows.filter((row) => overlapsRange(row, minute, endMinute));
      cells.push({
        id: `review-${minute}`,
        roomName: REVIEW_LANE_ROOM_NAME,
        startMinute: minute,
        endMinute,
        rows: rowsInBin,
        load: rowsInBin.reduce((sum, row) => sum + rowLoad(row), 0),
        loadRatio: rowsInBin.length > 0 ? 1 : 0,
        active: rowsInBin.length > 0,
        isReview: true,
      });
    }
  }

  return cells;
}

export function buildRoomCalendarEvents<TRow extends ClassroomVisualizationRow>(
  rows: TRow[],
  rooms: ClassroomVisualizationRoom[],
): Array<RoomCalendarEvent<TRow>> {
  const activeRooms = getActiveRooms(rooms);
  const activeRoomNames = new Set(activeRooms.map((room) => room.name));
  const roomNames = activeRooms.map((room) => room.name);
  if (rows.some((row) => shouldRouteRowToReview(row, activeRoomNames))) {
    roomNames.push(REVIEW_LANE_ROOM_NAME);
  }

  const events: Array<RoomCalendarEvent<TRow>> = [];

  for (const roomName of roomNames) {
    const isReview = roomName === REVIEW_LANE_ROOM_NAME;
    const roomRows = rows
      .filter((row) => {
        const resolvedRoom = activeRoomNameForRow(row, activeRoomNames);
        return isReview ? resolvedRoom === null : resolvedRoom === roomName;
      })
      .sort((a, b) => {
        if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
        if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
        return a.tutorDisplayName.localeCompare(b.tutorDisplayName);
      });

    const laneEnds: number[] = [];
    const roomEvents: Array<RoomCalendarEvent<TRow>> = [];
    for (const row of roomRows) {
      let lane = laneEnds.findIndex((endMinute) => endMinute <= row.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(row.endMinute);
      } else {
        laneEnds[lane] = row.endMinute;
      }

      roomEvents.push({
        id: row.id,
        row,
        roomName,
        isReview,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        lane,
        laneCount: 1,
        hasRoomConflict: false,
      });
    }

    const laneCount = Math.max(1, laneEnds.length);
    for (const event of roomEvents) {
      events.push({
        ...event,
        laneCount,
        hasRoomConflict: laneCount > 1,
      });
    }
  }

  return events;
}

export function groupCellsByRoom<TRow extends ClassroomVisualizationRow>(
  cells: Array<HeatmapCell<TRow>>,
): Array<{ roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }> {
  const grouped = new Map<string, { roomName: string; cells: Array<HeatmapCell<TRow>>; isReview: boolean }>();
  for (const cell of cells) {
    const group = grouped.get(cell.roomName) ?? {
      roomName: cell.roomName,
      cells: [],
      isReview: cell.isReview,
    };
    group.cells.push(cell);
    group.isReview = group.isReview || cell.isReview;
    grouped.set(cell.roomName, group);
  }
  return [...grouped.values()];
}
