"use client";
import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CalendarData } from "@/lib/tutor-sit-ins/client-types";
import { api, control, Notice, panel } from "./shared";
export function CalendarSettings() {
  const [data, setData] = useState<CalendarData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState("primary"),
    [selected, setSelected] = useState<string[]>(["primary"]);
  async function load() {
    try {
      const result = await api<CalendarData>("/calendar");
      setData(result);
      if (result.connected) {
        setDestination(result.calendarId);
        setSelected(result.busyCalendarIds);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function action(
    kind: "connect" | "save" | "disconnect",
    provider: "google" | "microsoft" = data?.connected
      ? data.provider
      : "google",
  ) {
    setBusy(true);
    setError("");
    try {
      if (kind === "connect") {
        const result = await api<{ url: string }>("/calendar/connect", {
          provider,
        });
        window.location.assign(result.url);
        return;
      }
      if (kind === "save" && data?.connected)
        await api(
          "/calendar",
          {
            calendarId: destination,
            busyCalendarIds: selected,
            expectedRevision: data.revision,
          },
          "PATCH",
        );
      if (kind === "disconnect") await api("/calendar", undefined, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={panel}>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <CalendarDays className="size-5 text-primary" />
        Your calendar
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect one Google or Outlook account and select the calendars to check.
        Your teaching and personal time stay protected; personal event details
        stay private.
      </p>
      {error && (
        <div className="mt-4">
          <Notice error>{error}</Notice>
        </div>
      )}
      {data?.connected ? (
        <div className="mt-4 space-y-4">
          <p className="break-all text-sm">
            {data.provider === "microsoft" ? "Outlook" : "Google"} connected as{" "}
            <strong>{data.accountEmail}</strong>
          </p>
          {data.error && <Notice error>{data.error}</Notice>}
          {!!data.calendars.length && (
            <>
              <label className="block text-sm font-medium">
                Observation calendar
                <select
                  className={control + " mt-1"}
                  value={
                    destination === "primary"
                      ? data.calendars.find((c) => c.primary)?.id || "primary"
                      : destination
                  }
                  onChange={(e) => setDestination(e.target.value)}
                >
                  {data.calendars
                    .filter((c) => c.accessRole === "owner")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? " (primary)" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">
                  Calendars to check for conflicts
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.calendars.map((c) => (
                    <label
                      key={c.id}
                      className="flex min-h-10 items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={
                          !!c.primary ||
                          selected.includes(c.id) ||
                          c.id === destination
                        }
                        disabled={c.primary || c.id === destination || busy}
                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, c.id]
                              : v.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.summary}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your primary and observation calendars are always checked.
                </p>
              </fieldset>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !data.calendars.length}
              onClick={() => void action("save")}
            >
              Save calendars
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void action("connect")}
            >
              Reconnect {data.provider === "microsoft" ? "Outlook" : "Google"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void action("disconnect")}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {(data?.availableProviders || ["google"]).map((provider) => (
            <Button
              key={provider}
              variant={provider === "google" ? "default" : "outline"}
              disabled={busy || !data}
              onClick={() => void action("connect", provider)}
            >
              {busy
                ? "Opening…"
                : provider === "google"
                  ? "Connect Google Calendar"
                  : "Connect Outlook Calendar"}
            </Button>
          ))}
          {data && !data.availableProviders.includes("microsoft") && (
            <p className="w-full text-sm text-muted-foreground">
              Outlook Calendar setup is in progress. Email sign-in is available
              independently.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
