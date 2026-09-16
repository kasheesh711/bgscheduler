"use client";
import { formatInTimeZone } from "date-fns-tz";
import { ZONE } from "@/lib/tutor-sit-ins/model";
export const control =
  "min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
export const panel = "rounded-xl border bg-card p-4 shadow-sm sm:p-6";
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch("/api/tutor-sit-ins" + path, {
    method: body === undefined && method === "POST" ? "GET" : method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || "The request failed. Please try again.");
  return value as T;
}
export const when = (date: string | null | undefined) =>
  date ? formatInTimeZone(new Date(date), ZONE, "d MMM yyyy, HH:mm") : "—";
export const slot = (start: string, end: string) =>
  when(start) + "–" + formatInTimeZone(new Date(end), ZONE, "HH:mm");
export function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={
        "rounded-lg border p-3 text-sm leading-relaxed " +
        (error
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-primary/20 bg-primary/5 text-foreground")
      }
    >
      {children}
    </div>
  );
}
const statusNames: Record<string, string> = {
  pending: "Awaiting a slot",
  needs_rescheduling: "Needs rescheduling",
  scheduled: "Confirmed",
  completed: "Completed",
  exempt: "Exempt",
  superseded: "Superseded by corrected coverage",
};
export function Status({ value }: { value: string }) {
  return (
    <span
      className={
        "inline-flex rounded-full border px-2.5 py-1 text-xs font-medium " +
        (value === "completed"
          ? "border-green-600/30 bg-green-600/10 text-green-800 dark:text-green-300"
          : value === "needs_rescheduling"
            ? "border-amber-600/30 bg-amber-600/10 text-amber-900 dark:text-amber-300"
            : "bg-muted text-foreground")
      }
    >
      {statusNames[value] || value.replaceAll("_", " ")}
    </span>
  );
}
export function Loading() {
  return (
    <div className="p-8 text-sm text-muted-foreground" role="status">
      Loading Tutor Sit-ins…
    </div>
  );
}

export function calendarDeliveryLabel(status: string) {
  return (
    (
      {
        pending: "Calendar queued",
        connection_required: "Connection required",
        synced: "Added",
        error: "Delivery issue",
        discrepancy: "Delivery issue",
        missed: "Delivery issue",
        cancel_pending: "Withdrawal queued",
        cancelled: "Withdrawn",
      } as Record<string, string>
    )[status] || "Calendar queued"
  );
}
