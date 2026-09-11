"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RoomTimeline } from "./mobile-workspace";
import { formatRoomMinute as time } from "@/lib/room-booking/model";
import type { RoomDayView } from "@/lib/room-booking/service";
import type {
  ClassroomRow,
  ClassroomRoom,
} from "@/components/class-assignments/types";
export interface AdminRoomReservation {
  id: string;
  date: string;
  roomId: string;
  lineUserId: string;
  canonicalKey: string;
  startMinute: number;
  endMinute: number;
  status: string;
  reason: string | null;
}
interface AdminRoomData {
  date: string;
  rooms: RoomDayView["rooms"];
  reservations: AdminRoomReservation[];
  checkedAt: string | null;
  lastError: string | null;
  availabilityStatus: RoomDayView["availabilityStatus"];
  uncertain: RoomDayView["uncertain"];
}
export function useAdminRoomReservations(date: string) {
  const [data, setData] = useState<AdminRoomData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!date) return;
    try {
      const res = await fetch(
        `/api/class-assignments/reservations?date=${date}`,
        { cache: "no-store" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Room reservations unavailable.",
      );
    }
  }, [date]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { data: data?.date === date ? data : null, error, refresh };
}
export function reservationDisplayRows(
  reservations: AdminRoomReservation[],
  rooms: ClassroomRoom[],
): ClassroomRow[] {
  return reservations
    .filter((r) => r.status === "confirmed")
    .flatMap((r) => {
      const room = rooms.find((room) => room.id === r.roomId);
      if (!room) return [];
      return [
        {
          id: `reservation:${r.id}`,
          canonicalKey: r.canonicalKey,
          runId: "",
          tutorDisplayName: r.canonicalKey,
          wiseTeacherId: "",
          wiseTeacherUserId: null,
          wiseSessionId: `reservation:${r.id}`,
          wiseClassId: null,
          startTime: `${r.date}T${time(r.startMinute)}:00+07:00`,
          endTime: `${r.date}T${time(r.endMinute)}:00+07:00`,
          weekday: new Date(`${r.date}T00:00:00+07:00`).getDay(),
          startMinute: r.startMinute,
          endMinute: r.endMinute,
          wiseStatus: "RESERVATION",
          sessionType: null,
          currentWiseLocation: null,
          studentName: null,
          studentCount: 1,
          subject: null,
          classType: null,
          title: "Standalone room reservation",
          minCapacity: 1,
          needsTv: false,
          preferredRoom: null,
          overrideRoom: null,
          assignedRoom: room.name,
          status: "assigned",
          warnings: [],
          publishStatus: "skipped",
          publishError: null,
        },
      ];
    });
}
export function AdminRoomReservations({
  data,
  error,
  refresh,
}: {
  data: AdminRoomData | null;
  error: string | null;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function cancel(id: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/class-assignments/reservations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setFailure(null);
      await refresh();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Cancellation failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="h-full space-y-4 overflow-auto rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Tutor room reservations</h2>
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {(error || failure) && (
        <p role="alert" className="text-sm text-destructive">
          {error || failure}
        </p>
      )}
      {data?.lastError && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Latest occupancy refresh: {data.lastError}
        </p>
      )}
      {data && (
        <p className="text-sm text-muted-foreground">
          {data.date} · Availability: {data.availabilityStatus} · Last checked:{" "}
          {data.checkedAt
            ? new Date(data.checkedAt).toLocaleString("en-GB", {
                timeZone: "Asia/Bangkok",
              })
            : "No verified update"}
        </p>
      )}
      {Boolean(data?.uncertain.length) && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          Room locations need checking:{" "}
          {data!.uncertain
            .map(
              (interval) =>
                `${time(interval.startMinute)}–${time(interval.endMinute)}`,
            )
            .join(", ")}
          . New bookings are blocked during these intervals.
        </p>
      )}
      {data && !data.reservations.length && (
        <p className="text-muted-foreground">
          No standalone reservations for this date.
        </p>
      )}
      {data?.reservations.map((r) => (
        <article
          key={r.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
        >
          <div>
            <p className="font-medium">
              {data.rooms.find((room) => room.id === r.roomId)?.name ??
                "Inactive room"}{" "}
              · {r.canonicalKey}
            </p>
            <p className="text-sm">
              {time(r.startMinute)}–{time(r.endMinute)} · {r.status}
            </p>
            {r.reason && (
              <p className="text-xs text-muted-foreground">{r.reason}</p>
            )}
          </div>
          {r.status === "confirmed" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void cancel(r.id)}
            >
              Cancel reservation
            </Button>
          )}
        </article>
      ))}
      {data && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Classes and reservations timetable
          </summary>
          <div className="mt-4">
            <RoomTimeline rooms={data.rooms} />
          </div>
        </details>
      )}
    </div>
  );
}
