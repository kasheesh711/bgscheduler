import { createHash } from "crypto";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import {
  fetchLineProfile,
  sendLineRoomMessages,
  type LineRoomMessage,
} from "@/lib/line/client";
import { isScheduleBotAdmin } from "@/lib/line/schedule-bot";
import { physicalRoom } from "@/lib/classrooms/room-policy";
import {
  approvedRoomTutor,
  createRoomReservation,
  cancelRoomReservation,
  getRoomDayView,
  mintRoomLink,
  type RoomDayView,
} from "./service";
import {
  formatRoomMinute as time,
  parseRoomTime,
  roomMinute,
  roomDate,
  roomBookingDates,
  validateRoomDate,
  overlaps,
  validateRoomInterval,
  ROOM_CLOSE,
  ROOM_OPEN,
  RoomBookingError,
  type RoomBotEvent,
} from "./model";

export const ROOM_HELP =
  "Rooms today and tomorrow · 07:00–21:00 Bangkok\n/room — my day and free rooms\n/room free 14:00 15:00\n/room book Focus 14:00 15:00\n/room tomorrow\n/room tomorrow free 14:00 15:00\n/room tomorrow book Focus 14:00 15:00\n/room bookings\n/room cancel <booking-id>\n/room web — private mobile timetable\nUse 15-minute steps. A scheduled class takes priority; we will notify you.";
export const isRoomText = (text: string) =>
  /^\/room(?:\s|$)/i.test(text.trim());
const uuidPattern =
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const retryUuid = (event: string, suffix: string) => {
  const hex = createHash("sha256").update(`${event}:${suffix}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

async function action(
  db: Database,
  event: RoomBotEvent,
  command: string,
  label: string,
  picker = false,
) {
  const [row] = await db
    .insert(s.roomActions)
    .values({
      lineUserId: event.userId,
      scope: event.scope,
      command,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    })
    .returning();
  return picker
    ? { type: "datetimepicker", label, data: `room:${row.id}`, mode: "time" }
    : { type: "postback", label, data: `room:${row.id}` };
}
async function menu(
  db: Database,
  event: RoomBotEvent,
  text: string,
  date = roomDate(),
): Promise<LineRoomMessage> {
  const choices = [
    ...(date === roomDate() ? [[`${date} now`, "Free now"]] : []),
    [`${date} choose`, "Choose time"],
    [roomBookingDates()[0], "Today"],
    [roomBookingDates()[1], "Tomorrow"],
    ["bookings", "My bookings"],
    ["web", "Mobile timetable"],
  ];
  const items = [];
  for (const [command, label] of choices)
    items.push({
      type: "action",
      action: await action(db, event, command, label),
    });
  return { type: "text", text: text.slice(0, 4800), quickReply: { items } };
}
async function availableCards(
  db: Database,
  event: RoomBotEvent,
  view: RoomDayView,
  start: string,
  end: string,
  page = 0,
): Promise<LineRoomMessage[]> {
  const startMinute = start === "now" ? view.nowMinute : parseRoomTime(start);
  const endMinute = parseRoomTime(end);
  validateRoomInterval(
    view.date,
    { startMinute, endMinute },
    new Date(),
    start === "now",
  );
  if (!view.fresh)
    return [
      await menu(
        db,
        event,
        "Availability unavailable. Waiting for a complete room update; no rooms can be booked yet.",
        view.date,
      ),
    ];
  if (
    view.uncertain.some((block) => overlaps(block, { startMinute, endMinute }))
  )
    return [
      await menu(
        db,
        event,
        `Availability needs checking for ${view.date} ${time(startMinute)}–${end}. Ask an admin or choose another time.`,
        view.date,
      ),
    ];
  const rooms = view.rooms.filter((r) =>
    r.free.some(
      (f) => f.startMinute <= startMinute && f.endMinute >= endMinute,
    ),
  );
  if (!rooms.length)
    return [
      await menu(
        db,
        event,
        `No room is free for ${view.date} ${time(startMinute)}–${end}. Try another time.`,
        view.date,
      ),
    ];
  page = Math.max(0, Math.min(page, Math.floor((rooms.length - 1) / 6)));
  const bubbles = [];
  for (const room of rooms.slice(page * 6, page * 6 + 6)) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: room.name, weight: "bold", wrap: true },
          {
            type: "text",
            text: `${view.date} ${time(startMinute)}–${end} · ${room.capacity} seats${room.hasTv ? " · TV" : ""}`,
            size: "sm",
            wrap: true,
          },
          {
            type: "text",
            text:
              room.category === "online_only" ? "Online booth" : "Available",
            size: "sm",
            color: "#126DCE",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: await action(
              db,
              event,
              `${view.date} book ${room.id} ${start} ${end}`,
              "Book",
            ),
          },
        ],
      },
    });
  }
  const messages: LineRoomMessage[] = [
    {
      type: "flex",
      altText: `${view.date} · ${rooms.length} free rooms, ${time(startMinute)}–${end}. Use /room book <room> ${start} ${end}.`,
      contents: { type: "carousel", contents: bubbles },
    },
  ];
  if ((page + 1) * 6 < rooms.length)
    messages.push({
      type: "text",
      text: `Showing ${page * 6 + 1}–${Math.min((page + 1) * 6, rooms.length)} of ${rooms.length} rooms.`,
      quickReply: {
        items: [
          {
            type: "action",
            action: await action(
              db,
              event,
              `${view.date} free ${start} ${end} ${page + 1}`,
              "More rooms",
            ),
          },
        ],
      },
    });
  return messages;
}

export async function routeRoomCommand(db: Database, event: RoomBotEvent) {
  let command = event.text.replace(/^\/room\s*/i, "").trim();
  if (event.scope !== "dm" && !/^setup (on|off)$/i.test(command)) {
    const [group] = await db
      .select()
      .from(s.roomBookingGroups)
      .innerJoin(
        s.lineGroupSettings,
        eq(s.lineGroupSettings.groupId, s.roomBookingGroups.groupId),
      )
      .where(
        and(
          eq(s.roomBookingGroups.groupId, event.scope),
          eq(s.roomBookingGroups.enabled, true),
          eq(s.lineGroupSettings.audience, "staff"),
        ),
      );
    if (!group) return;
  }
  if (Date.now() - new Date(event.receivedAt).getTime() > 5 * 60_000)
    throw new RoomBookingError(
      "OLD_COMMAND",
      "This room request has expired. Send /room again.",
    );
  let actionId: string | null = null;
  if (event.text.startsWith("room:")) {
    actionId = event.text.slice(5);
    if (!uuidPattern.test(actionId))
      throw new RoomBookingError(
        "BUTTON_EXPIRED",
        "This button has expired. Send /room again.",
      );
    const [saved] = await db
      .select()
      .from(s.roomActions)
      .where(
        and(
          eq(s.roomActions.id, actionId),
          eq(s.roomActions.lineUserId, event.userId),
          eq(s.roomActions.scope, event.scope),
          gt(s.roomActions.expiresAt, new Date()),
        ),
      );
    if (!saved)
      throw new RoomBookingError(
        "BUTTON_EXPIRED",
        "This button belongs to another tutor or has expired. Send /room again.",
      );
    command = saved.command;
    if (event.params?.time) command += ` ${event.params.time}`;
  }
  let date = roomDate();
  const dated = /^(tomorrow|today|\d{4}-\d{2}-\d{2})(?:\s+|$)/i.exec(command);
  if (dated) {
    date =
      dated[1].toLowerCase() === "tomorrow"
        ? roomBookingDates()[1]
        : dated[1].toLowerCase() === "today"
          ? roomDate()
          : dated[1];
    validateRoomDate(date);
    command = command.slice(dated[0].length).trim();
  }
  const respond = (messages: LineRoomMessage[]) =>
    sendLineRoomMessages({
      to: event.scope === "dm" ? event.userId : event.scope,
      replyToken: event.replyToken,
      messages,
      retryKey: retryUuid(event.eventId, "reply"),
    });
  const setup = /^setup (on|off)$/i.exec(command);
  if (setup) {
    if (!isScheduleBotAdmin(event.userId) || event.scope === "dm") return;
    const [group] = await db
      .select()
      .from(s.lineGroupSettings)
      .where(eq(s.lineGroupSettings.groupId, event.scope));
    const enabled = setup[1].toLowerCase() === "on";
    if (enabled && group?.audience !== "staff") {
      await respond([
        {
          type: "text",
          text: "Set this group to staff with /schedule setup staff first.",
        },
      ]);
      return;
    }
    await db
      .insert(s.roomBookingGroups)
      .values({ groupId: event.scope, enabled, updatedBy: event.userId })
      .onConflictDoUpdate({
        target: s.roomBookingGroups.groupId,
        set: { enabled, updatedBy: event.userId, updatedAt: new Date() },
      });
    await respond([
      {
        type: "text",
        text: enabled
          ? "Tutor room commands enabled in this group."
          : "Tutor room commands disabled in this group.",
      },
    ]);
    return;
  }
  if (event.scope !== "dm") {
    const [group] = await db
      .select()
      .from(s.roomBookingGroups)
      .innerJoin(
        s.lineGroupSettings,
        eq(s.lineGroupSettings.groupId, s.roomBookingGroups.groupId),
      )
      .where(
        and(
          eq(s.roomBookingGroups.groupId, event.scope),
          eq(s.roomBookingGroups.enabled, true),
          eq(s.lineGroupSettings.audience, "staff"),
        ),
      );
    if (!group) return;
  }
  let tutor;
  try {
    tutor = await approvedRoomTutor(db, event.userId);
  } catch (error) {
    if (!(error instanceof RoomBookingError)) throw error;
    if (event.scope === "dm") {
      const [existing] = await db
        .select()
        .from(s.roomTutorLinks)
        .where(eq(s.roomTutorLinks.lineUserId, event.userId));
      if (!existing) {
        const profile = await fetchLineProfile(event.userId).catch(() => null);
        await db
          .insert(s.roomTutorLinks)
          .values({
            lineUserId: event.userId,
            displayName:
              profile?.displayName ?? `LINE user ${event.userId.slice(-6)}`,
          })
          .onConflictDoNothing();
      }
      await respond([
        {
          type: "text",
          text: "Your tutor account needs admin approval in Tutor Profiles. Once approved, send /room again.",
        },
      ]);
    } else
      await respond([
        {
          type: "text",
          text: "Please message the bot privately with /room so an admin can link your tutor account.",
        },
      ]);
    return;
  }
  if (command === "help") {
    await respond([await menu(db, event, ROOM_HELP)]);
    return;
  }
  if (command === "web") {
    const token = await mintRoomLink(db, event.userId);
    const base = (
      process.env.APP_BASE_URL ?? "https://bgscheduler.vercel.app"
    ).replace(/\/+$/, "");
    await sendLineRoomMessages({
      to: event.userId,
      replyToken: event.scope === "dm" ? event.replyToken : null,
      retryKey: retryUuid(event.eventId, "web"),
      messages: [
        {
          type: "text",
          text: `Your private room timetable (valid for 60 minutes or until midnight):\n${base}/room/${token}\nThis personal link allows room booking. Keep it private.`,
        },
      ],
    });
    if (event.scope !== "dm")
      await respond([
        { type: "text", text: "I sent your private timetable by DM." },
      ]);
    return;
  }
  const cancel = /^cancel ([\w-]+)$/i.exec(command);
  if (cancel) {
    if (!uuidPattern.test(cancel[1]))
      throw new RoomBookingError(
        "NOT_FOUND",
        "Use the complete booking ID shown by /room bookings.",
        400,
      );
    const cancelled = await cancelRoomReservation(db, cancel[1], {
      userId: event.userId,
    });
    await respond([
      await menu(
        db,
        event,
        `Reservation on ${cancelled.date} cancelled. The remaining time is now available.`,
        cancelled.date,
      ),
    ]);
    return;
  }
  const confirm = /^confirm ([\w-]+)$/i.exec(command);
  if (confirm) {
    if (!uuidPattern.test(confirm[1]))
      throw new RoomBookingError(
        "BUTTON_EXPIRED",
        "Invalid confirmation.",
        400,
      );
    const [saved] = await db
      .select()
      .from(s.roomActions)
      .where(
        and(
          eq(s.roomActions.id, confirm[1]),
          eq(s.roomActions.lineUserId, event.userId),
          eq(s.roomActions.scope, event.scope),
          gt(s.roomActions.expiresAt, new Date()),
        ),
      );
    const parsed =
      saved &&
      /^reserve ([\w-]+) (now|\d{2}:\d{2}) (\d{2}:\d{2}) (\d{4}-\d{2}-\d{2})$/.exec(
        saved.command,
      );
    if (!parsed)
      throw new RoomBookingError(
        "BUTTON_EXPIRED",
        "This confirmation has expired. Start a new booking.",
      );
    let reservation;
    try {
      reservation = await createRoomReservation(db, event.userId, {
        roomId: parsed[1],
        startMinute:
          parsed[2] === "now" ? roomMinute() : parseRoomTime(parsed[2]),
        endMinute: parseRoomTime(parsed[3]),
        date: parsed[4],
        immediate: parsed[2] === "now",
        idempotencyKey: saved.id,
        source: "line",
      });
    } catch (error) {
      if (
        !(error instanceof RoomBookingError) ||
        error.code !== "ROOM_CONFLICT"
      )
        throw error;
      const current = await getRoomDayView(
        db,
        event.userId,
        new Date(),
        parsed[4],
      );
      const alternatives = await availableCards(
        db,
        event,
        current,
        parsed[2],
        parsed[3],
      );
      await respond([
        {
          type: "text",
          text: "That room was taken before your confirmation. Choose an alternative and confirm a new booking.",
        },
        ...alternatives,
      ]);
      return;
    }
    await respond([
      await menu(
        db,
        event,
        `Reservation ${reservation.status}: ${reservation.date} · ${time(reservation.startMinute)}–${time(reservation.endMinute)}\nBooking ID: ${reservation.id}`,
        reservation.date,
      ),
    ]);
    return;
  }
  if (command === "choose") {
    await respond([
      {
        type: "text",
        text: `Choose a start time for ${date} (07:00–21:00, 15-minute steps).`,
        quickReply: {
          items: [
            {
              type: "action",
              action: await action(
                db,
                event,
                `${date} choose-end`,
                "Start time",
                true,
              ),
            },
          ],
        },
      },
    ]);
    return;
  }
  const startChoice = /^choose-end (\d{2}:\d{2})$/.exec(command);
  if (startChoice) {
    parseRoomTime(startChoice[1]);
    await respond([
      {
        type: "text",
        text: `${date} · Start: ${startChoice[1]}. Choose an end time.`,
        quickReply: {
          items: [
            {
              type: "action",
              action: await action(
                db,
                event,
                `${date} free ${startChoice[1]}`,
                "End time",
                true,
              ),
            },
          ],
        },
      },
    ]);
    return;
  }
  const view = await getRoomDayView(db, event.userId, new Date(), date);
  if (command === "bookings") {
    const views = await Promise.all(
      roomBookingDates().map((day) =>
        day === view.date
          ? view
          : getRoomDayView(db, event.userId, new Date(), day),
      ),
    );
    const active = views
      .flatMap((day) => day.reservations)
      .filter(
        (r) =>
          r.status === "confirmed" &&
          (r.date > view.todayDate || r.endMinute > view.nowMinute),
      )
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute,
      );
    const text =
      active
        .map(
          (r) =>
            `${r.date} · ${r.roomName} · ${time(r.startMinute)}–${time(r.endMinute)}\n/room cancel ${r.id}`,
        )
        .join("\n\n") ||
      "You have no upcoming room reservations today or tomorrow.";
    const items = [];
    for (const r of active.slice(0, 8))
      items.push({
        type: "action",
        action: await action(
          db,
          event,
          `cancel ${r.id}`,
          `Cancel ${time(r.startMinute)}`,
        ),
      });
    await respond([
      {
        type: "text",
        text: text.slice(0, 4800),
        ...(items.length ? { quickReply: { items } } : {}),
      },
    ]);
    return;
  }
  const book = /^book (.+) (now|\d{2}:\d{2}) (\d{2}:\d{2})$/i.exec(command);
  if (book) {
    const room = view.rooms.filter(
      (r) => r.id === book[1] || physicalRoom(r.name) === physicalRoom(book[1]),
    );
    if (room.length !== 1)
      throw new RoomBookingError(
        "UNKNOWN_ROOM",
        "Use an exact room name from /room free, or choose a room button.",
        400,
      );
    const immediate = book[2].toLowerCase() === "now";
    const interval = {
      startMinute: immediate ? roomMinute() : parseRoomTime(book[2]),
      endMinute: parseRoomTime(book[3]),
    };
    validateRoomInterval(view.date, interval, new Date(), immediate);
    if (view.fresh && view.uncertain.some((block) => overlaps(block, interval)))
      throw new RoomBookingError(
        "UNRESOLVED_ROOMS",
        "Availability needs checking for this time. Ask an admin or choose another time.",
      );
    if (
      !view.fresh ||
      !room[0].free.some(
        (f) =>
          f.startMinute <= interval.startMinute &&
          f.endMinute >= interval.endMinute,
      )
    )
      throw new RoomBookingError(
        "ROOM_UNAVAILABLE",
        "That interval is not currently available. Send /room to refresh.",
      );
    const [pending] = await db
      .insert(s.roomActions)
      .values({
        lineUserId: event.userId,
        scope: event.scope,
        command: `reserve ${room[0].id} ${immediate ? "now" : book[2]} ${book[3]} ${view.date}`,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .returning();
    await respond([
      {
        type: "text",
        text: `Reserve ${room[0].name}\n${view.date} ${time(interval.startMinute)}–${book[3]} Bangkok\nA scheduled class takes priority.\n/room confirm ${pending.id}`,
        quickReply: {
          items: [
            {
              type: "action",
              action: await action(
                db,
                event,
                `confirm ${pending.id}`,
                "Confirm booking",
              ),
            },
          ],
        },
      },
    ]);
    return;
  }
  const free = /^free (now|\d{2}:\d{2}) (\d{2}:\d{2})(?: (\d+))?$/i.exec(
    command,
  );
  if (free) {
    await respond(
      await availableCards(
        db,
        event,
        view,
        free[1].toLowerCase(),
        free[2],
        Number(free[3] ?? 0),
      ),
    );
    return;
  }
  if (command === "now") {
    if (view.date !== view.todayDate)
      throw new RoomBookingError(
        "INVALID_IMMEDIATE",
        "Start now is available for today only.",
        400,
      );
    const start = Math.max(ROOM_OPEN, view.nowMinute);
    const end = Math.min(ROOM_CLOSE, Math.ceil((start + 60) / 15) * 15);
    await respond(
      await availableCards(
        db,
        event,
        view,
        view.nowMinute < ROOM_OPEN ? time(ROOM_OPEN) : "now",
        time(end),
      ),
    );
    return;
  }
  if (command) {
    await respond([await menu(db, event, ROOM_HELP)]);
    return;
  }
  const freeNow = view.fresh
    ? view.rooms.flatMap((room) => {
        const from =
          view.date === view.todayDate
            ? Math.max(ROOM_OPEN, view.nowMinute)
            : ROOM_OPEN;
        const slot = room.free.find((slot) =>
          view.date === view.todayDate
            ? slot.startMinute <= from && slot.endMinute > from
            : slot.endMinute > from,
        );
        return slot
          ? [
              `${room.name} · ${view.date === view.todayDate ? "free until" : `free ${time(slot.startMinute)}–`} ${time(slot.endMinute)}`,
            ]
          : [];
      })
    : [];
  const uncertainNow =
    view.date === view.todayDate &&
    view.uncertain.some(
      (block) =>
        block.startMinute <= view.nowMinute && block.endMinute > view.nowMinute,
    );
  const classes = view.classes.map(
    (c) =>
      `${time(c.startMinute)}–${time(c.endMinute)} · ${c.room}${c.roomSource === "classroom_plan" ? " (Class Assignments)" : ""}${c.plannedRoom ? ` (planned: ${c.plannedRoom})` : ""}`,
  );
  const reservations = view.reservations
    .filter((r) => r.status === "confirmed")
    .map((r) => `${time(r.startMinute)}–${time(r.endMinute)} · ${r.roomName}`);
  await respond([
    await menu(
      db,
      event,
      `${tutor.displayName} · ${view.date}\n\nMy classes\n${classes.join("\n") || "No classes found in the latest room update."}\n\nMy reservations\n${reservations.join("\n") || "None"}\n\n${view.fresh ? (uncertainNow ? "Availability needs checking" : "Free rooms") : "Availability unavailable"}\n${freeNow.join("\n") || (view.fresh ? (uncertainNow ? "A class needs its room checked. Ask an admin or choose another time." : "No rooms free for this time. Choose another interval.") : "Waiting for a complete room update.")}\n\n${view.checkedAt ? `Last checked ${new Date(view.checkedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} Bangkok` : "No verified room update yet."}`,
      view.date,
    ),
  ]);
}

export async function processRoomEvent(db: Database, eventId: string) {
  const [claimed] = await db
    .update(s.roomCommandEvents)
    .set({
      status: "processing",
      claimedUntil: new Date(Date.now() + 90_000),
      attempts: sql`${s.roomCommandEvents.attempts}+1`,
    })
    .where(
      and(
        eq(s.roomCommandEvents.eventId, eventId),
        or(
          eq(s.roomCommandEvents.status, "pending"),
          and(
            eq(s.roomCommandEvents.status, "processing"),
            lt(s.roomCommandEvents.claimedUntil, new Date()),
          ),
        ),
      ),
    )
    .returning();
  if (!claimed) return;
  try {
    try {
      await routeRoomCommand(db, claimed.payload);
    } catch (error) {
      if (!(error instanceof RoomBookingError)) throw error;
      await sendLineRoomMessages({
        to:
          claimed.payload.scope === "dm"
            ? claimed.payload.userId
            : claimed.payload.scope,
        replyToken: claimed.payload.replyToken,
        messages: [{ type: "text", text: error.message }],
        retryKey: retryUuid(eventId, "error"),
      });
    }
    await db
      .update(s.roomCommandEvents)
      .set({ status: "done", lastError: null, claimedUntil: null })
      .where(eq(s.roomCommandEvents.eventId, eventId));
  } catch {
    await db
      .update(s.roomCommandEvents)
      .set({
        status: "pending",
        claimedUntil: null,
        lastError: "Room command failed; retry pending",
      })
      .where(eq(s.roomCommandEvents.eventId, eventId));
  }
}
export async function retryRoomEvents(db: Database) {
  const rows = await db
    .select({ id: s.roomCommandEvents.eventId })
    .from(s.roomCommandEvents)
    .where(
      or(
        eq(s.roomCommandEvents.status, "pending"),
        and(
          eq(s.roomCommandEvents.status, "processing"),
          lt(s.roomCommandEvents.claimedUntil, new Date()),
        ),
      ),
    )
    .limit(2);
  for (const row of rows) await processRoomEvent(db, row.id);
}
