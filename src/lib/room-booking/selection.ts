import { overlaps, parseRoomTime, ROOM_OPEN, ROOM_CLOSE } from "./model";
import type { RoomDayView } from "./service";

/** Shared presentation rules: uncertainty is different from zero free rooms. */
export function roomSelection(
  view: RoomDayView,
  date: string,
  start: string,
  end: string,
  immediate: boolean,
) {
  let from = 0,
    to = 0;
  try {
    from = immediate ? view.nowMinute : parseRoomTime(start);
    to = parseRoomTime(end);
  } catch {
    /* Invalid times remain unbookable. */
  }
  const today = date === view.todayDate;
  const valid =
    (!immediate || today) &&
    [view.todayDate, view.tomorrowDate].includes(date) &&
    from >= Math.max(ROOM_OPEN, today ? view.nowMinute : ROOM_OPEN) &&
    to <= ROOM_CLOSE &&
    to - from >= 15 &&
    (immediate || from % 15 === 0) &&
    to % 15 === 0;
  const status =
    view.date !== date
      ? "loading"
      : !valid
        ? "invalid"
        : !view.fresh
          ? "unavailable"
          : view.uncertain.some((block) =>
                overlaps(block, { startMinute: from, endMinute: to }),
              )
            ? "unresolved"
            : "ready";
  const available =
    status === "ready"
      ? view.rooms.filter((room) =>
          room.free.some(
            (slot) => slot.startMinute <= from && slot.endMinute >= to,
          ),
        )
      : [];
  return { from, to, valid, status, available };
}
