"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Subject, Slot } from "@/lib/hiring/model";
import type { bookingView } from "@/lib/hiring/service";
type View = Awaited<ReturnType<typeof bookingView>>;
const time = (value: string) =>
  new Date(value).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });
export function HiringBooking({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [slot, setSlot] = useState<Slot | null>(null),
    [onsite, setOnsite] = useState(false),
    [commitment, setCommitment] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function load(chosen?: Subject[]) {
    setSlot(null);
    const params = new URLSearchParams();
    chosen?.forEach((s) => params.append("subject", s));
    const r = await fetch(`/api/hiring/book/${token}?${params}`, {
      cache: "no-store",
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    setView(body);
    setSubjects(body.selectedSubjects);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  async function changeSubjects(chosen: Subject[]) {
    setSubjects(chosen);
    setError("");
    setSaved(false);
    if (chosen.length)
      try {
        await load(chosen);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load times.");
      }
    else setSlot(null);
  }
  async function book() {
    if (!slot) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/hiring/book/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: slot.start,
          interviewerKey: slot.interviewerKey,
          subjects,
          onsiteConfirmed: onsite,
          teachingCommitmentConfirmed: commitment,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      await load(subjects);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm.");
      await load(subjects).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const selectionBooked =
    view &&
    subjects.some((subject) =>
      view.bookings.some(
        (booking) =>
          booking.kind === view.kind && booking.subjects.includes(subject),
      ),
    );
  return (
    <main className="h-full overflow-y-auto bg-background p-4 md:p-10">
      <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border bg-card p-5 md:p-8">
        <header>
          <p className="text-sm font-semibold text-primary">
            BeGifted Education
          </p>
          <h1 className="mt-2 text-2xl font-semibold">
            Book your{" "}
            {view?.kind === "mock"
              ? "mock teaching session"
              : "paper assessment"}
          </h1>
        </header>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-900">
            {error}
          </p>
        )}
        {saved && (
          <p
            role="status"
            className="rounded-lg bg-green-50 p-3 text-green-900"
          >
            Your appointment is confirmed. The details are below. Your
            confirmation email and calendar invitation will follow.
          </p>
        )}
        {!view ? (
          <p role="status">
            {error
              ? "Contact BeGifted if you need a new booking link."
              : "Loading available appointments…"}
          </p>
        ) : (
          <>
            <p>{view.location}</p>
            <p className="text-sm text-muted-foreground">
              All times are Bangkok time.{" "}
              {view.kind === "mock"
                ? "Choose one subject for each one-hour session. Times cover the next five business days, Monday–Friday, 10:00–16:00."
                : "Allow two hours for each subject. Choose your subjects before you choose a time."}
            </p>
            <fieldset>
              <legend className="mb-2 font-semibold">Subjects</legend>
              <div className="flex flex-wrap gap-3">
                {view.subjects.map((subject) => (
                  <label key={subject}>
                    <input
                      className="mr-2"
                      type={view.kind === "mock" ? "radio" : "checkbox"}
                      name="subjects"
                      disabled={
                        busy ||
                        view.bookings.some(
                          (b) =>
                            b.kind === view.kind &&
                            b.subjects.includes(subject),
                        )
                      }
                      checked={subjects.includes(subject)}
                      onChange={(e) =>
                        changeSubjects(
                          view.kind === "mock"
                            ? [subject]
                            : e.target.checked
                              ? [...subjects, subject]
                              : subjects.filter((v) => v !== subject),
                        )
                      }
                    />
                    {subject}
                  </label>
                ))}
              </div>
            </fieldset>
            {view.bookings.length > 0 && (
              <section>
                <h2 className="font-semibold">Your confirmed appointments</h2>
                {view.bookings.map((b) => (
                  <p className="mt-2 rounded-lg border p-3" key={b.id}>
                    {b.subjects.join(", ")} ·{" "}
                    {new Date(b.start).toLocaleDateString("en-GB", {
                      timeZone: "Asia/Bangkok",
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}{" "}
                    · {time(b.start)}–{time(b.end)}
                    {b.interviewer ? ` · ${b.interviewer}` : ""}
                  </p>
                ))}
              </section>
            )}
            {!view.enabled ? (
              <p role="status">
                Booking is temporarily paused. Please contact BeGifted.
              </p>
            ) : selectionBooked ? (
              <p role="status">
                These subjects already have a confirmed appointment. Select
                another subject if needed.
              </p>
            ) : (
              <>
                <fieldset>
                  <legend className="mb-2 font-semibold">
                    Available appointments
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {subjects.length > 0 &&
                      view.slots.map((s) => (
                        <label
                          key={`${s.start}:${s.interviewerKey}`}
                          className={`cursor-pointer rounded-lg border p-3 ${slot?.start === s.start && slot.interviewerKey === s.interviewerKey ? "border-primary bg-primary/5" : ""}`}
                        >
                          <input
                            type="radio"
                            name="slot"
                            className="mr-2"
                            checked={
                              slot?.start === s.start &&
                              slot.interviewerKey === s.interviewerKey
                            }
                            onChange={() => setSlot(s)}
                          />
                          {new Date(s.start).toLocaleDateString("en-GB", {
                            timeZone: "Asia/Bangkok",
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                          })}
                          <span className="ml-5 block">
                            {time(s.start)}–{time(s.end)}
                            {s.interviewerKey ? ` · ${s.interviewerKey}` : ""}
                          </span>
                        </label>
                      ))}
                  </div>
                </fieldset>
                {(!subjects.length || !view.slots.length) && (
                  <p role="status">
                    {!subjects.length
                      ? "Select at least one subject."
                      : "There are no open appointments for this selection. Please try again later or contact BeGifted."}
                  </p>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={onsite}
                    onChange={(e) => setOnsite(e.target.checked)}
                  />
                  <span>I will attend onsite at the address above.</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={commitment}
                    onChange={(e) => setCommitment(e.target.checked)}
                  />
                  <span>
                    I can teach onsite on Saturday or Sunday and on at least one
                    weekday after 15:00.
                  </span>
                </label>
                <Button
                  className="w-full"
                  disabled={
                    busy || !slot || !onsite || !commitment || !subjects.length
                  }
                  onClick={book}
                >
                  {busy ? "Confirming…" : "Confirm appointment"}
                </Button>
              </>
            )}
            <p className="text-sm text-muted-foreground">
              For help or changes,{" "}
              <a
                className="underline"
                href="https://lin.ee/OjMHF41"
                rel="noreferrer"
              >
                contact BeGifted on LINE
              </a>
              .
            </p>
          </>
        )}
      </div>
    </main>
  );
}
