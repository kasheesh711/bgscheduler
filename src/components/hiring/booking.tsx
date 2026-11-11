"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, CircleCheck, Info, MapPin } from "lucide-react";
import type { Subject, Slot } from "@/lib/hiring/model";
import type { bookingView, visitView } from "@/lib/hiring/service";
import c from "./booking.module.css";
type View = Awaited<ReturnType<typeof bookingView>>;
type VisitView = Awaited<ReturnType<typeof visitView>>;
const LINE_URL = "https://lin.ee/OjMHF41";
const ZONE = { timeZone: "Asia/Bangkok" } as const;
const time = (value: string) =>
  new Date(value).toLocaleTimeString("en-GB", { ...ZONE, hour: "2-digit", minute: "2-digit" });
const day = (value: string) =>
  new Date(value).toLocaleDateString("en-GB", { ...ZONE, weekday: "long", day: "numeric", month: "long" });
const part = (value: string | Date, options: Intl.DateTimeFormatOptions) =>
  new Date(value).toLocaleDateString("en-GB", { ...ZONE, ...options });
const Help = () => (
  <p className={c.help}>
    For help or changes,{" "}
    <a href={LINE_URL} rel="noreferrer">
      contact BeGifted on LINE
    </a>
    .
  </p>
);

/** Server text is plain text. Only the known LINE address becomes a link, so no HTML comes through. */
function Linked({ text }: { text: string }) {
  const at = text.indexOf(LINE_URL);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <a href={LINE_URL} rel="noreferrer">
        {LINE_URL}
      </a>
      {text.slice(at + LINE_URL.length)}
    </>
  );
}

export function VisitNotice({ text }: { text: string }) {
  return (
    <div className={c.notice}>
      <Info aria-hidden />
      <p role="status">
        <Linked text={text} />
      </p>
    </div>
  );
}

/** The error sits directly above the button: on a phone the top of the page is out of sight after a failed booking. */
export function VisitConfirm({
  error,
  disabled,
  label,
  onConfirm,
  summary,
}: {
  error: string;
  disabled: boolean;
  label: string;
  onConfirm: () => void;
  summary?: ReactNode;
}) {
  return (
    <div className={c.confirm}>
      {summary}
      {error && (
        <p role="alert" className={c.alert}>
          {error}
        </p>
      )}
      <button type="button" className={c.button} disabled={disabled} onClick={onConfirm}>
        {label}
      </button>
    </div>
  );
}

const Saved = ({ children }: { children: ReactNode }) => (
  <p role="status" className={c.success}>
    <CircleCheck aria-hidden />
    <span>{children}</span>
  </p>
);

const Fact = ({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) => (
  <div className={c.fact}>
    {icon}
    <div>
      <span className={c.factLabel}>{label}</span>
      {children}
    </div>
  </div>
);

/** When the times were checked against live Wise. Nothing shows when the list came from the Wise copy. */
const Live = ({ at }: { at: string | null }) => (at ? <span className={c.live}>Live schedule, checked {time(at)}</span> : null);

/** Days first, then the times of one day: a long list of times does not fit a phone. Real radio inputs keep the keyboard and screen readers working. */
function Picker<T extends { date: string }>({
  legend,
  checkedAt,
  items,
  keyOf,
  selected,
  onSelect,
  tile,
}: {
  legend: string;
  checkedAt: string | null;
  items: T[];
  keyOf: (item: T) => string;
  selected: string;
  onSelect: (item: T) => void;
  tile: (item: T) => ReactNode;
}) {
  const days = [...new Set(items.map((i) => i.date))].sort();
  const [picked, setPicked] = useState("");
  const active = days.includes(picked) ? picked : (items.find((i) => keyOf(i) === selected)?.date ?? days[0]);
  if (!days.length) return null;
  return (
    <fieldset className={c.step}>
      <legend className={c.stepHead}>
        <span className={c.stepTitle}>{legend}</span>
        <Live at={checkedAt} />
      </legend>
      <div className={c.days}>
        {days.map((date) => {
          const noon = `${date}T12:00:00+07:00`;
          const count = items.filter((i) => i.date === date).length;
          return (
            <button key={date} type="button" className={c.day} aria-pressed={date === active} onClick={() => setPicked(date)}>
              <span>{part(noon, { weekday: "short" })}</span>
              <b>{part(noon, { day: "numeric" })}</b>
              <span>{part(noon, { month: "short" })}</span>
              <i>
                {count} {count === 1 ? "time" : "times"}
              </i>
            </button>
          );
        })}
      </div>
      <div className={c.tiles}>
        {items
          .filter((i) => i.date === active)
          .map((item) => (
            <label key={keyOf(item)} className={c.tile}>
              <input
                type="radio"
                name="slot"
                className={c.hidden}
                checked={selected === keyOf(item)}
                onChange={() => onSelect(item)}
              />
              {tile(item)}
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function Checks({
  onsite,
  commitment,
  setOnsite,
  setCommitment,
}: {
  onsite: boolean;
  commitment: boolean;
  setOnsite: (v: boolean) => void;
  setCommitment: (v: boolean) => void;
}) {
  const row = (checked: boolean, set: (v: boolean) => void, text: string) => (
    <label className={c.check}>
      <input type="checkbox" className={c.hidden} checked={checked} onChange={(e) => set(e.target.checked)} />
      <span className={c.box} aria-hidden>
        <Check />
      </span>
      <span>{text}</span>
    </label>
  );
  return (
    <div className={c.checks}>
      {row(onsite, setOnsite, "I will attend onsite at the address above.")}
      {row(commitment, setCommitment, "I can teach onsite on Saturday or Sunday and on at least one weekday after 15:00.")}
    </div>
  );
}

/** One subject and one visit. The server assigns the head, so a time appears once and names no one. */
export function VisitBooking({
  token,
  view,
  reload,
}: {
  token: string;
  view: VisitView;
  reload: () => Promise<void>;
}) {
  const [moving, setMoving] = useState(false),
    [chosen, setStart] = useState(""),
    [onsite, setOnsite] = useState(false),
    [commitment, setCommitment] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  // The list reloads on its own, so a chosen time that has gone is no longer chosen.
  const slot = view.slots.find((s) => s.examStart === chosen);
  const start = slot?.examStart ?? "";
  async function book() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const r = await fetch(`/api/hiring/book/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start,
          subject: view.subject,
          onsiteConfirmed: onsite,
          teachingCommitmentConfirmed: commitment,
          ...(view.visit ? { move: true } : {}),
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      await reload();
      setSaved(
        view.visit
          ? "Your visit has moved. The new times are below. A confirmation email and calendar invitations will follow."
          : "Your visit is confirmed. The details are below. A confirmation email and calendar invitations will follow.",
      );
      setMoving(false);
      setStart("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm.");
      // That time may be gone, so the candidate chooses again from the fresh list.
      setStart("");
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  // The server sends a notice for an empty list. The fallback keeps the page from ever showing nothing.
  const notice =
    view.notice ?? (view.slots.length ? null : `There are no open visit times at the moment. Contact BeGifted on LINE: ${LINE_URL}`);
  const showForm = (!view.visit || moving) && !notice;
  return (
    <>
      {saved && <Saved>{saved}</Saved>}
      <div className={c.facts}>
        <Fact icon={<BookOpen aria-hidden />} label="Subject">
          <span className={c.subject}>{view.subject}</span>
        </Fact>
        <Fact icon={<MapPin aria-hidden />} label="Where">
          {view.location}
        </Fact>
        <div className={c.plan}>
          <span>
            Exam<small>2 hours</small>
          </span>
          <span>
            Mock teaching<small>1 hour</small>
          </span>
        </div>
        <p className={c.note}>One visit: a 2-hour exam, then a 1-hour mock teaching session. All times are Bangkok time.</p>
      </div>
      {view.visit && (
        <section>
          <div className={c.stepHead}>
            <h2 className={c.stepTitle}>Your booked visit</h2>
            <span className={c.badge}>
              <Check aria-hidden size={14} /> Confirmed
            </span>
          </div>
          <div className={c.ticket}>
            <div className={c.ticketDate}>
              <span>{part(view.visit.examStart, { weekday: "short" })}</span>
              <b>{part(view.visit.examStart, { day: "numeric" })}</b>
              <span>{part(view.visit.examStart, { month: "short" })}</span>
            </div>
            <div className={c.ticketBody}>
              <span>{day(view.visit.examStart)}</span>
              <div className={c.ticketRow}>
                <span>Exam</span>
                <strong>
                  {time(view.visit.examStart)}–{time(view.visit.mockStart)}
                </strong>
              </div>
              <div className={c.ticketRow}>
                <span>Mock teaching with {view.visit.head}</span>
                <strong>
                  {time(view.visit.mockStart)}–{time(view.visit.mockEnd)}
                </strong>
              </div>
            </div>
          </div>
          {view.canMove && !moving && (
            <div className={c.move}>
              <p className={c.note}>You can move this visit once, up to 24 hours before it starts.</p>
              <button type="button" className={c.ghost} disabled={busy || !view.slots.length} onClick={() => setMoving(true)}>
                Move this visit
              </button>
              {!view.slots.length && <p className={c.note}>You cannot move it now, because no other time is open.</p>}
            </div>
          )}
        </section>
      )}
      {notice && <VisitNotice text={notice} />}
      {/* With no form on the page, a failed booking still shows its error here. */}
      {!showForm && error && (
        <p role="alert" className={c.alert}>
          {error}
        </p>
      )}
      {showForm && (
        <>
          <Picker
            legend={view.visit ? "Choose a new time" : "Choose a time"}
            checkedAt={view.checkedAt}
            items={view.slots}
            keyOf={(s) => s.examStart}
            selected={start}
            onSelect={(s) => setStart(s.examStart)}
            tile={(s) => (
              <>
                <span className={c.tileTime}>{time(s.examStart)}</span>
                <span className={c.tileLines}>
                  <span className={c.tileLine}>
                    <span>Exam</span>
                    <span>
                      {time(s.examStart)}–{time(s.mockStart)}
                    </span>
                  </span>
                  <span className={c.tileLine}>
                    <span>Mock teaching</span>
                    <span>
                      {time(s.mockStart)}–{time(s.mockEnd)}
                    </span>
                  </span>
                </span>
              </>
            )}
          />
          <Checks onsite={onsite} commitment={commitment} setOnsite={setOnsite} setCommitment={setCommitment} />
          {moving && (
            <button
              type="button"
              className={c.ghost}
              disabled={busy}
              onClick={() => {
                setMoving(false);
                setStart("");
                setError("");
              }}
            >
              Keep my current time
            </button>
          )}
          <VisitConfirm
            error={error}
            disabled={busy || !start || !onsite || !commitment}
            label={busy ? "Confirming…" : view.visit ? "Confirm new time" : "Confirm visit"}
            onConfirm={book}
            summary={
              slot && (
                <p className={c.summary}>
                  <span>{day(slot.examStart)}</span>
                  <b>
                    {time(slot.examStart)}–{time(slot.mockEnd)}
                  </b>
                </p>
              )
            }
          />
        </>
      )}
      {!notice && <Help />}
    </>
  );
}

const slotKey = (s: Slot) => `${s.start}:${s.interviewerKey}:${s.subjects.join(",")}`;

export const BookingLoading = () => (
  <div className={c.skeleton}>
    <p role="status" className={c.hidden}>
      Loading available appointments…
    </p>
    <i />
    <i />
    <i />
    <i />
  </div>
);

export function BookingShell({ kind, children }: { kind?: "visit" | "mock" | "paper"; children: ReactNode }) {
  return (
    <main className={c.page}>
      <header className={c.hero}>
        <div className={c.heroInner}>
          <p className={c.brand}>BeGifted Education</p>
          <h1 className={c.title}>
            Book your <em>{kind === "visit" ? "onsite visit" : kind === "mock" ? "mock teaching session" : kind === "paper" ? "paper assessment" : "assessment"}</em>
          </h1>
        </div>
      </header>
      <div className={c.sheet}>
        <div className={c.card}>{children}</div>
      </div>
    </main>
  );
}

export function HiringBooking({ token }: { token: string }) {
  const [view, setView] = useState<View | VisitView | null>(null),
    [subjects, setSubjects] = useState<Subject[]>([]),
    [slot, setSlot] = useState<Slot | null>(null),
    [onsite, setOnsite] = useState(false),
    [commitment, setCommitment] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function load(chosen?: Subject[]) {
    const params = new URLSearchParams();
    chosen?.forEach((s) => params.append("subject", s));
    const r = await fetch(`/api/hiring/book/${token}?${params}`, {
      cache: "no-store",
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    setView(body);
    setSubjects(body.selectedSubjects ?? []);
    // A chosen time stays chosen only while the new list still has it.
    setSlot((prev) => (prev && (body.slots as Slot[] | undefined)?.some((s) => "start" in s && slotKey(s) === slotKey(prev)) ? prev : null));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // A page left open shows old times, so the list reloads when the candidate comes back to the tab.
  const visit = view?.kind === "visit";
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible" || !view || (!visit && !subjects.length)) return;
      load(visit ? undefined : subjects).catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [token, view, visit, subjects]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const old = view && view.kind !== "visit" ? view : null;
  const selectionBooked =
    !!old && subjects.some((subject) => old.bookings.some((booking) => booking.kind === old.kind && booking.subjects.includes(subject)));
  const form = !!old && old.enabled && !selectionBooked;
  return (
    <BookingShell kind={view?.kind}>
      {/* With the form on the page, the error shows above its button. */}
      {error && !form && (
        <p role="alert" className={c.alert}>
          <Linked text={error} />
        </p>
      )}
      {saved && <Saved>Your appointment is confirmed. The details are below. Your confirmation email and calendar invitation will follow.</Saved>}
      {!view ? (
        error ? (
          !error.includes(LINE_URL) && <VisitNotice text="Contact BeGifted if you need a new booking link." />
        ) : (
          <BookingLoading />
        )
      ) : view.kind === "visit" ? (
        <VisitBooking token={token} view={view} reload={() => load()} />
      ) : (
        <>
          <div className={c.facts}>
            <Fact icon={<MapPin aria-hidden />} label="Where">
              {view.location}
            </Fact>
            <p className={c.note}>
              All times are Bangkok time.{" "}
              {view.kind === "mock"
                ? "Choose one subject for each one-hour session. Times cover the next five business days, Monday–Friday, 10:00–16:00."
                : "Allow two hours for each subject. Choose your subjects before you choose a time."}
            </p>
          </div>
          <fieldset className={c.step}>
            <legend className={c.stepHead}>
              <span className={c.stepTitle}>Subjects</span>
            </legend>
            <div className={c.pills}>
              {view.subjects.map((subject) => (
                <label key={subject} className={c.pill}>
                  <input
                    className={c.hidden}
                    type={view.kind === "mock" ? "radio" : "checkbox"}
                    name="subjects"
                    disabled={busy || view.bookings.some((b) => b.kind === view.kind && b.subjects.includes(subject))}
                    checked={subjects.includes(subject)}
                    onChange={(e) =>
                      changeSubjects(
                        view.kind === "mock" ? [subject] : e.target.checked ? [...subjects, subject] : subjects.filter((v) => v !== subject),
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
              <h2 className={c.stepTitle}>Your confirmed appointments</h2>
              {view.bookings.map((b) => (
                <p className={c.booking} key={b.id}>
                  <span>
                    {b.subjects.join(", ")} · {day(b.start)}
                    {b.interviewer ? ` · ${b.interviewer}` : ""}
                  </span>
                  <b>
                    {time(b.start)}–{time(b.end)}
                  </b>
                </p>
              ))}
            </section>
          )}
          {!view.enabled ? (
            <VisitNotice text="Booking is temporarily paused. Please contact BeGifted." />
          ) : selectionBooked ? (
            <VisitNotice text="These subjects already have a confirmed appointment. Select another subject if needed." />
          ) : (
            <>
              {subjects.length > 0 && (
                <Picker
                  legend="Available appointments"
                  checkedAt={view.checkedAt}
                  items={view.slots}
                  keyOf={slotKey}
                  selected={slot ? slotKey(slot) : ""}
                  onSelect={setSlot}
                  tile={(s) => (
                    <>
                      <span className={c.tileTime}>{time(s.start)}</span>
                      <span className={c.tileLines}>
                        <span className={c.tileLine}>
                          <span>{s.interviewerKey ? `With ${s.interviewerKey}` : "Until"}</span>
                          <span>{time(s.end)}</span>
                        </span>
                      </span>
                    </>
                  )}
                />
              )}
              {(!subjects.length || !view.slots.length) && (
                <VisitNotice
                  text={
                    !subjects.length
                      ? "Select at least one subject."
                      : "There are no open appointments for this selection. Please try again later or contact BeGifted."
                  }
                />
              )}
              <Checks onsite={onsite} commitment={commitment} setOnsite={setOnsite} setCommitment={setCommitment} />
              <VisitConfirm
                error={error}
                disabled={busy || !slot || !onsite || !commitment || !subjects.length}
                label={busy ? "Confirming…" : "Confirm appointment"}
                onConfirm={book}
                summary={
                  slot && (
                    <p className={c.summary}>
                      <span>{day(slot.start)}</span>
                      <b>
                        {time(slot.start)}–{time(slot.end)}
                      </b>
                    </p>
                  )
                }
              />
            </>
          )}
          <Help />
        </>
      )}
    </BookingShell>
  );
}
