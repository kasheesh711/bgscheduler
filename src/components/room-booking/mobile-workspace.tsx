"use client";
import { useCallback, useEffect, useState } from "react";
import { DoorOpen, CalendarDays, Clock3, RefreshCw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { RoomDayView } from "@/lib/room-booking/service";
import {
  formatRoomMinute as time,
  parseRoomTime,
  ROOM_OPEN,
  ROOM_CLOSE,
} from "@/lib/room-booking/model";

export function RoomTimeline({ rooms }: { rooms: RoomDayView["rooms"] }) {
  return (
    <div className="space-y-4" aria-label="Room timetable">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>07:00</span>
        <span>14:00</span>
        <span>21:00</span>
      </div>
      {rooms.map((room) => (
        <div key={room.id}>
          <div className="mb-1 flex justify-between gap-2 text-sm">
            <span className="font-medium">{room.name}</span>
            <span className="text-muted-foreground">
              {room.category === "online_only"
                ? "Online booth"
                : `${room.capacity} seats`}
            </span>
          </div>
          <div
            className="relative h-7 overflow-hidden rounded bg-muted"
            aria-label={`${room.name} occupancy`}
          >
            {room.blocks.map((b, i) => {
              const start = Math.max(ROOM_OPEN, b.startMinute),
                end = Math.min(ROOM_CLOSE, b.endMinute);
              return end > start ? (
                <div
                  key={i}
                  title={`${b.kind === "class" ? "Class" : "Room reservation"}: ${time(b.startMinute)}–${time(b.endMinute)}`}
                  aria-label={`${b.kind === "class" ? "Class" : "Room reservation"} ${time(b.startMinute)}–${time(b.endMinute)}`}
                  className={`absolute inset-y-0 border-r border-background ${b.kind === "class" ? "bg-primary/60" : "bg-amber-500/80"}`}
                  style={{
                    left: `${((start - ROOM_OPEN) / (ROOM_CLOSE - ROOM_OPEN)) * 100}%`,
                    width: `${((end - start) / (ROOM_CLOSE - ROOM_OPEN)) * 100}%`,
                  }}
                />
              ) : null;
            })}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Blue: class · Amber: room reservation. Use the availability list to
        check a complete time interval.
      </p>
    </div>
  );
}
export function RoomMobileWorkspace({
  token,
  initial,
}: {
  token: string;
  initial: RoomDayView;
}) {
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState("rooms");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [immediate, setImmediate] = useState(initial.nowMinute >= ROOM_OPEN);
  const [start, setStart] = useState(
    time(
      Math.min(
        ROOM_CLOSE - 15,
        Math.max(ROOM_OPEN, Math.ceil(initial.nowMinute / 15) * 15),
      ),
    ),
  );
  const [end, setEnd] = useState(
    time(
      Math.min(
        ROOM_CLOSE,
        Math.max(ROOM_OPEN, Math.ceil(initial.nowMinute / 15) * 15) + 60,
      ),
    ),
  );
  const [selected, setSelected] = useState<{
    roomId: string;
    name: string;
    key: string;
  } | null>(null);
  const request = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const response = await fetch(path, {
        ...options,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          setExpired(true);
        throw new Error(body.error ?? "Unable to update rooms.");
      }
      return body;
    },
    [token],
  );
  const refresh = useCallback(async () => {
    try {
      setView(await request("/api/room/availability"));
    } catch (e) {
      setView((v) => ({ ...v, fresh: false }));
      setError(e instanceof Error ? e.message : "Could not refresh rooms.");
    }
  }, [request]);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);
  let from = 0,
    to = 0;
  try {
    from = immediate ? view.nowMinute : parseRoomTime(start);
    to = parseRoomTime(end);
  } catch {
    /* Invalid inputs disable booking. */
  }
  const valid =
    from >= Math.max(ROOM_OPEN, view.nowMinute) &&
    to <= ROOM_CLOSE &&
    to - from >= 15 &&
    (immediate || from % 15 === 0) &&
    to % 15 === 0;
  const available =
    view.fresh && valid
      ? view.rooms.filter((r) =>
          r.free.some((f) => f.startMinute <= from && f.endMinute >= to),
        )
      : [];
  async function book() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request("/api/room/reservations", {
        method: "POST",
        body: JSON.stringify({
          roomId: selected.roomId,
          date: view.date,
          startMinute: from,
          endMinute: to,
          immediate,
          idempotencyKey: selected.key,
        }),
      });
      setNotice(
        `${selected.name} ${result.reservation.status} · ${time(result.reservation.startMinute)}–${time(result.reservation.endMinute)}`,
      );
      setSelected(null);
      setTab("bookings");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/room/reservations/${id}`, { method: "DELETE" });
      setNotice("Reservation cancelled. The remaining time is available.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancellation failed.");
    } finally {
      setBusy(false);
    }
  }
  if (expired)
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="max-w-sm rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold">Open a new room link</h1>
          <p className="mt-3 text-muted-foreground">
            This link has expired or your access has changed. Send{" "}
            <strong>/room web</strong> privately in LINE.
          </p>
        </div>
      </main>
    );
  return (
    <main
      lang="en"
      className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground"
    >
      <div className="mx-auto max-w-2xl px-4 pb-12 pt-5 sm:px-6">
        <header className="mb-6 border-b pb-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                BeGifted · Tutor rooms
              </p>
              <h1 className="mt-2 text-2xl font-semibold">
                A room for your day
              </h1>
            </div>
            <DoorOpen className="size-8 shrink-0 text-primary" aria-hidden />
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <div>
              <p className="font-medium">{view.tutorName}</p>
              <p className="text-sm text-muted-foreground">
                {view.date} · 07:00–21:00 Bangkok
              </p>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="size-11 text-foreground"
              aria-label="Refresh room availability"
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </header>
        {notice && (
          <p
            role="status"
            className="mb-4 flex gap-2 rounded-lg border bg-primary/5 p-3 text-sm"
          >
            <Check className="size-4 shrink-0" />
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-destructive p-3 text-sm"
          >
            {error}
          </p>
        )}
        {!view.fresh && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-amber-500 bg-amber-500/10 p-3 text-sm"
          >
            Availability unavailable. Waiting for a complete room update. You
            can still cancel your reservations.
          </p>
        )}
        {!view.writesEnabled && (
          <p className="mb-4 text-sm text-muted-foreground">
            Booking is not enabled yet. Your timetable is available for review.
          </p>
        )}
        <nav
          aria-label="Room views"
          className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
        >
          {[
            ["day", "My day"],
            ["rooms", "Available rooms"],
            ["bookings", "My bookings"],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant={tab === id ? "default" : "ghost"}
              className={`h-auto min-h-11 whitespace-normal px-2 text-xs sm:text-sm ${tab === id ? "text-primary-foreground" : "text-foreground"}`}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>
        {tab === "day" && (
          <section aria-label="My classes" className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <CalendarDays className="size-5" />
              Today’s classes
            </h2>
            {!view.classes.length && (
              <p className="rounded-lg border p-4 text-muted-foreground">
                No classes found in the latest room update.
              </p>
            )}
            {view.classes.map((c, i) => (
              <article
                key={i}
                className="flex gap-4 rounded-lg border bg-card p-4"
              >
                <p className="shrink-0 font-mono text-sm">
                  {time(c.startMinute)}
                  <br />
                  <span className="text-muted-foreground">
                    {time(c.endMinute)}
                  </span>
                </p>
                <div>
                  <h3 className="font-semibold">{c.room}</h3>
                  {c.plannedRoom && (
                    <p className="text-sm text-muted-foreground">
                      Planned room: {c.plannedRoom} · awaiting Wise publication
                    </p>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
        {tab === "rooms" && (
          <section className="space-y-5">
            <div className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 font-semibold">
                <Clock3 className="size-4" />
                When do you need a room?
              </h2>
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={immediate}
                  onChange={(e) => {
                    setImmediate(e.target.checked);
                    setSelected(null);
                  }}
                />
                Start now
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-sm">
                  From
                  <Input
                    type="time"
                    className="h-11 text-foreground [color-scheme:light] dark:[color-scheme:dark]"
                    value={start}
                    step={900}
                    min="07:00"
                    max="20:45"
                    disabled={immediate}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  Until
                  <Input
                    type="time"
                    className="h-11 text-foreground [color-scheme:light] dark:[color-scheme:dark]"
                    value={end}
                    step={900}
                    min="07:15"
                    max="21:00"
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
              </div>
              {!valid && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Choose at least 15 minutes today, ending by 21:00.
                </p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {available.length} {available.length === 1 ? "room" : "rooms"}{" "}
                available
              </h2>
              <span className="text-sm text-muted-foreground">
                {valid ? `${time(from)}–${time(to)}` : "Choose a time"}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {available.map((room) => (
                <article
                  key={room.id}
                  className="rounded-xl border bg-card p-4"
                >
                  <div className="mb-3">
                    <h3 className="font-semibold">{room.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {room.category === "online_only"
                        ? "Online booth"
                        : `${room.capacity} seats`}
                      {room.hasTv ? " · TV" : ""}
                    </p>
                  </div>
                  <Button
                    className="h-11 w-full"
                    disabled={busy || !view.writesEnabled}
                    onClick={() => {
                      setError(null);
                      setSelected({
                        roomId: room.id,
                        name: room.name,
                        key: crypto.randomUUID(),
                      });
                    }}
                  >
                    Book room
                  </Button>
                </article>
              ))}
            </div>
            {view.fresh && valid && !available.length && (
              <p className="rounded-lg border p-4 text-muted-foreground">
                No room is free for this entire interval. Try a different time.
              </p>
            )}
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-medium">
                All rooms · today’s timetable
              </summary>
              <div className="mt-4">
                <RoomTimeline rooms={view.rooms} />
              </div>
            </details>
          </section>
        )}
        {tab === "bookings" && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">My reservations</h2>
            {!view.reservations.length && (
              <p className="rounded-lg border p-4 text-muted-foreground">
                No reservations today. Choose a free room to get started.
              </p>
            )}
            {view.reservations.map((r) => (
              <article key={r.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{r.roomName}</h3>
                    <p className="mt-1 font-mono text-sm">
                      {time(r.startMinute)}–{time(r.endMinute)}
                    </p>
                  </div>
                  <span className="rounded bg-muted px-2 py-1 text-xs capitalize">
                    {r.status === "confirmed" && r.endMinute <= view.nowMinute
                      ? "Ended"
                      : r.status}
                  </span>
                </div>
                {r.reason && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {r.reason}
                  </p>
                )}
                {r.status === "confirmed" && r.endMinute > view.nowMinute && (
                  <Button
                    variant="outline"
                    className="mt-3 h-11 text-foreground"
                    disabled={busy}
                    onClick={() => void cancel(r.id)}
                  >
                    Cancel reservation
                  </Button>
                )}
              </article>
            ))}
          </section>
        )}
        <footer className="mt-6 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            {view.checkedAt
              ? `Last checked ${new Date(view.checkedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })} Bangkok.`
              : "No verified room update yet."}
          </p>
          <p className="mt-2">
            Teaching classes take priority. If a later Wise class needs your
            room, we’ll release your reservation and notify you in LINE.
          </p>
          <p className="mt-2">
            This is your private booking link. Send /room web in LINE when it
            expires.
          </p>
        </footer>
      </div>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogContent className="text-foreground">
          <DialogHeader>
            <DialogTitle>Reserve {selected?.name}</DialogTitle>
            <DialogDescription>
              Today, {time(from)}–{time(to)} Bangkok. A later Wise class may
              take priority; we’ll notify you in LINE.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11 text-foreground"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Back
            </Button>
            <Button
              className="h-11"
              disabled={busy || !view.fresh || !valid}
              onClick={() => void book()}
            >
              {busy ? "Booking…" : "Confirm booking"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
