"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, CircleCheck, FileSignature, Info, MapPin, Video } from "lucide-react";
import { mockCanFollow, phoneSchema, type Subject, type Slot } from "@/lib/hiring/model";
import type { bookingView, callView, contractView, visitView } from "@/lib/hiring/service";
import { PreScreenQuestions } from "./questions";
import c from "./booking.module.css";
import cs from "./candidate.module.css";
type View = Awaited<ReturnType<typeof bookingView>>;
type VisitView = Awaited<ReturnType<typeof visitView>>;
type CallView = Awaited<ReturnType<typeof callView> | ReturnType<typeof contractView>>;
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
    Need help?{" "}
    <a href={LINE_URL} rel="noreferrer">
      Contact BeGifted on LINE
    </a>
    .
  </p>
);

/** Server text is plain text. Only the known LINE address becomes a link, so no HTML comes through. */
function Linked({ text }: { text: string }) {
  // "Contact BeGifted on LINE: <address>" reads better as one link with those words (Fable r1).
  const named = "Contact BeGifted on LINE: " + LINE_URL;
  const i = text.indexOf(named);
  if (i >= 0)
    return (
      <>
        {text.slice(0, i)}
        <a href={LINE_URL} rel="noreferrer">
          Contact BeGifted on LINE
        </a>
        {text.slice(i + named.length) || "."}
      </>
    );
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
  missing,
  compact,
}: {
  error: string;
  disabled: boolean;
  label: string;
  onConfirm: () => void;
  summary?: ReactNode;
  /** What still stops the button, said beside it (Fable r3). */
  missing?: string;
  /** On a phone, the summary and the button share one row (Sol r5). */
  compact?: boolean;
}) {
  return (
    <div className={c.confirm} data-confirm="" data-compact={compact || undefined}>
      {summary}
      {missing && !error && <p className={c.note}>Still needed: {missing}.</p>}
      {error && (
        <p role="alert" className={c.alert}>
          <Linked text={error} />
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
const Live = ({ at }: { at: string | null }) => (at ? <span className={c.live}>Checked live, {time(at)}</span> : null);

const NOON = (date: string) => `${date}T12:00:00+07:00`;
const plusDays = (date: string, n: number) => new Date(Date.parse(NOON(date)) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday of the Bangkok week of a date. */
const mondayOf = (date: string) => plusDays(date, -((new Date(NOON(date)).getUTCDay() + 6) % 7));
const hourOf = (value: string) => Number(new Date(value).toLocaleTimeString("en-GB", { ...ZONE, hour: "2-digit", hour12: false }).slice(0, 2));
const PARTS = [
  { name: "Morning", until: 12 },
  { name: "Afternoon", until: 17 },
  { name: "Evening", until: 24 },
];

/**
 * One week of days, then the times of one day grouped by part of the day (Mobbin: Preply, Alan). Four weeks of dates do
 * not fit a phone in one list. Real radio inputs keep the keyboard and screen readers working.
 */
function Picker<T extends { date: string }>({
  id,
  hint,
  legend,
  checkedAt,
  items,
  keyOf,
  startOf,
  selected,
  onSelect,
  tile,
  compact,
  initialDate,
  zoneNote = true,
  liveDates = [],
  currentKey,
}: {
  /** The booked time while moving: marked "Current" and not open, so the one move is not spent on it (Opus r5). */
  currentKey?: string;
  /** The dates the live Wise read covered; only these say "checked live". */
  liveDates?: string[];
  /** "Bangkok time" under the week; said once on a page with two lists. */
  zoneNote?: boolean;
  /** The day to open on, such as the booked test day while moving. */
  initialDate?: string;
  /** The page can focus or scroll to this list. */
  id?: string;
  hint?: string;
  legend: string;
  /** When the first days were checked against live Wise; later days come from the Wise copy (PR #371). */
  checkedAt: string | null;
  /** Many short times in a day (the HR call): three time-only tiles in a row. */
  compact?: boolean;
  items: T[];
  keyOf: (item: T) => string;
  startOf: (item: T) => string;
  selected: string;
  onSelect: (item: T) => void;
  tile: (item: T) => ReactNode;
}) {
  const days = [...new Set(items.map((i) => i.date))].sort();
  const weeks = [...new Set(days.map(mondayOf))];
  const chosenDate = items.find((i) => keyOf(i) === selected)?.date ?? (initialDate && days.includes(initialDate) ? initialDate : undefined);
  const [weekPicked, setWeek] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const week = weekPicked && weeks.includes(weekPicked) ? weekPicked : chosenDate ? mondayOf(chosenDate) : weeks[0];
  const inWeek = days.filter((d) => mondayOf(d) === week);
  const active = inWeek.includes(picked) ? picked : chosenDate && inWeek.includes(chosenDate) ? chosenDate : inWeek[0];
  if (!days.length) return null;
  const at = weeks.indexOf(week);
  const shown = items.filter((i) => i.date === active);
  const label = (date: string, options: Intl.DateTimeFormatOptions) => part(NOON(date), options);
  return (
    <fieldset className={c.step} id={id} tabIndex={-1}>
      <legend className={c.stepHead}>
        <span className={c.stepTitle}>{legend}</span>
        <Live at={checkedAt && liveDates.includes(active) ? checkedAt : null} />
      </legend>
      {hint && <p className={c.note}>{hint}</p>}
      {weeks.length > 1 && (
        <div className={cs.weekNav}>
          <button type="button" className={cs.arrow} aria-label="Previous week" disabled={at <= 0} onClick={() => setWeek(weeks[at - 1])}>
            <ChevronLeft aria-hidden size={20} />
          </button>
          <b aria-live="polite">
            {label(week, { day: "numeric", month: "short" })} – {label(plusDays(week, 6), { day: "numeric", month: "short" })}
            {zoneNote && <small>Bangkok time</small>}
          </b>
          <button type="button" className={cs.arrow} aria-label="Next week" disabled={at >= weeks.length - 1} onClick={() => setWeek(weeks[at + 1])}>
            <ChevronRight aria-hidden size={20} />
          </button>
        </div>
      )}
      <div className={cs.dates}>
        {Array.from({ length: 7 }, (_, i) => plusDays(week, i)).map((date) => {
          const count = items.filter((i) => i.date === date).length;
          return (
            <button
              key={date}
              type="button"
              className={cs.date}
              disabled={!count}
              aria-pressed={date === active}
              aria-label={`${label(date, { weekday: "long", day: "numeric", month: "long" })}, ${count} ${count === 1 ? "time" : "times"}`}
              onClick={() => setPicked(date)}
            >
              <span>{label(date, { weekday: "short" })}</span>
              <b>{label(date, { day: "numeric" })}</b>
              <i />
            </button>
          );
        })}
      </div>
      {PARTS.map((p, n) => {
        const times = shown.filter((i) => hourOf(startOf(i)) < p.until && hourOf(startOf(i)) >= (PARTS[n - 1]?.until ?? 0));
        if (!times.length) return null;
        return (
          <div key={p.name} className={cs.part}>
            <span className={cs.partName}>{p.name}</span>
            <div className={cs.times} data-compact={compact || undefined}>
              {times.map((item) => (
                <label key={keyOf(item)} className={cs.time}>
                  <input
                    type="radio"
                    name={legend}
                    className={c.hidden}
                    disabled={keyOf(item) === currentKey}
                    checked={selected === keyOf(item)}
                    onChange={() => onSelect(item)}
                  />
                  {tile(item)}
                  {keyOf(item) === currentKey && <small className={cs.current}>Current</small>}
                  <Check aria-hidden size={16} className={cs.timeCheck} />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Bring a part of the page into view, smoothly unless the candidate asked for less motion. */
export function reveal(id: string, focus = false, tries = 20) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    // The part may render a frame or two after a reload.
    if (!el) return void (tries > 0 && reveal(id, focus, tries - 1));
    el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (focus) el.focus({ preventScroll: true });
  });
}

/**
 * One column on a phone (top, then main, then side). From 1024 px the main part is on the left and the top and side
 * parts stay in view on the right (Fable r1: use the width at 1280).
 */
export function Layout({ top, main, side }: { top: ReactNode; main: ReactNode; side: ReactNode }) {
  return (
    <div className={cs.layout} data-wide-layout="">
      <div className={cs.main}>{main}</div>
      <div className={cs.rail}>
        <div className={cs.top}>{top}</div>
        {side && <div className={cs.side}>{side}</div>}
      </div>
    </div>
  );
}

/** What the visit is: the test, then the mock teaching if the candidate passes. Plain text, not tabs (Fable r2). */
const VisitPlan = () => (
  <ol className={cs.plan}>
    <li>
      <b>Test</b>
      <span>2 hours</span>
    </li>
    <li>
      <b>Mock teaching</b>
      <span>1 hour, if you pass</span>
    </li>
  </ol>
);

/** Questions → Times → Booked, so a candidate always sees where they are. */
function Steps({ at }: { at: 0 | 1 | 2 | 3 }) {
  return (
    <ol className={cs.steps} aria-label="Steps">
      {["Questions", "Times", "Booked"].map((name, i) => (
        <li key={name} data-state={i < at ? "done" : i === at ? "now" : undefined} aria-current={i === at ? "step" : undefined}>
          {i < at ? <Check aria-hidden size={14} /> : <span aria-hidden>{i + 1}</span>}
          {name}
        </li>
      ))}
    </ol>
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
      {row(onsite, setOnsite, "I will come to the address above.")}
      {row(commitment, setCommitment, "I can teach onsite at weekends and on a weekday after 15:00.")}
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
    // Ticked for the candidate when the saved answers already meet the rule; it stays editable (Fable r3).
    [commitment, setCommitment] = useState(view.timeRuleMet),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  // The list reloads on its own, so a chosen time that has gone is no longer chosen.
  const slot = view.slots.find((s) => s.examStart === chosen);
  const start = slot?.examStart ?? "";
  // A two-day link: the mock teaching is a second choice, after the chosen test (same day after grading, or a later day). With no test chosen
  // (also after a booking) no mock is chosen.
  const [mockChosen, setMock] = useState("");
  const laterMocks = slot ? view.mockSlots.filter((m) => mockCanFollow(slot.examEnd, m.start)) : [];
  const mock = laterMocks.find((m) => m.start === mockChosen);
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
          ...(view.twoDay ? { mockStart: mock?.start } : {}),
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
          ? "Moved. Email and calendar invites are on their way."
          : "Booked. Email and calendar invites are on their way.",
      );
      setMoving(false);
      setStart("");
      // The ticket replaces the lists: start the candidate at their booked visit (Sol r3).
      reveal("booked-visit", true);
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
    view.notice ?? (view.slots.length ? null : `No test times are open at the moment. Contact BeGifted on LINE: ${LINE_URL}`);
  const showForm = (!view.visit || moving) && !notice;
  const keep = moving && (
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
      {view.twoDay ? "Keep my current times" : "Keep my current time"}
    </button>
  );
  // A "Next steps" link before booking opens: the answers come first.
  if (view.waiting)
    return (
      <>
        {view.waiting === "answers" && (
          <PreScreenQuestions
            token={token}
            filePath={view.portfolioPath ?? ""}
            reload={reload}
            knownDegree={view.knownDegree}
            testSubjects={view.testSubjects}
            top={
              <>
                <Steps at={0} />
                <VisitPlan />
              </>
            }
          />
        )}
      </>
    );
  const short = (value: string) => part(value, { weekday: "short", day: "numeric", month: "short" });
  // A move to the same times would use up the one move for nothing (Sol r5).
  const unchanged = !!view.visit && moving && start === view.visit.examStart && (!view.twoDay || mock?.start === view.visit.mockStart);
  return (
    <>
      <Layout
        top={
          <>
            {view.twoDay && <Steps at={view.visit ? (moving ? 2 : 3) : 1} />}
            {saved && <Saved>{saved}</Saved>}
            <div className={c.facts}>
              <Fact icon={<BookOpen aria-hidden />} label="Subject">
                <span className={c.subject}>{view.subject}</span>
              </Fact>
              <Fact icon={<MapPin aria-hidden />} label="Where">
                {view.location}
              </Fact>
              {!view.twoDay && (
                <p className={c.note}>
                  {view.paired ? "We grade your test in 5 to 10 minutes. If you pass, the mock teaching interview follows on the same day." : "We will contact you after we grade your paper."} All
                  times are Bangkok time.
                </p>
              )}
            </div>
          </>
        }
        main={
          <>
            {view.visit && (
              <section className={cs.booked}>
                <div className={c.stepHead}>
                  <h2 className={c.stepTitle} id="booked-visit" tabIndex={-1}>
                    Your booked visit
                  </h2>
                  <span className={c.badge}>
                    <Check aria-hidden size={14} /> {moving ? "Current booking" : "Confirmed"}
                  </span>
                </div>
                <div className={c.ticket}>
                  <div className={c.ticketDate}>
                    <span>{part(view.visit.examStart, { weekday: "short" })}</span>
                    <b>{part(view.visit.examStart, { day: "numeric" })}</b>
                    <span>{part(view.visit.examStart, { month: "short" })}</span>
                    {/* A two-day visit shows its second day on the stub too (Opus r4). */}
                    {view.visit.mockStart && short(view.visit.mockStart) !== short(view.visit.examStart) && (
                      <i className={cs.stubSecond}>+ {part(view.visit.mockStart, { day: "numeric", month: "short" })}</i>
                    )}
                  </div>
                  <div className={cs.legs}>
                    <div>
                      <span>Test</span>
                      <b>{short(view.visit.examStart)}</b>
                      <small>
                        {time(view.visit.examStart)}–{time(view.visit.examEnd)}
                      </small>
                    </div>
                    {view.visit.mockStart && view.visit.mockEnd && (
                      <div>
                        <span>Mock teaching</span>
                        <b>{short(view.visit.mockStart)}</b>
                        <small>
                          {time(view.visit.mockStart)}–{time(view.visit.mockEnd)}
                          {view.visit.head && ` · ${view.visit.head}`}
                        </small>
                        <small>If you pass the test</small>
                      </div>
                    )}
                  </div>
                </div>
                {!view.canMove && !notice && <p className={c.note}>This visit can no longer be moved online.</p>}
                {view.canMove && !moving && (
                  <div className={c.move}>
                    <p className={c.note}>You can move this visit once, up to 24 hours before it starts.</p>
                    <button
                      type="button"
                      className={c.ghost}
                      disabled={busy || !view.slots.length}
                      onClick={() => {
                        setMoving(true);
                        setSaved("");
                        reveal("times-start");
                      }}
                    >
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
            {/* The list can empty while the candidate is moving: the way back stays on the page. */}
            {!showForm && keep}
            {showForm && (
              <Picker
                id="times-start"
                hint={view.twoDay ? "2 hours" : undefined}
                initialDate={view.visit ? part(view.visit.examStart, { year: "numeric", month: "2-digit", day: "2-digit" }).split("/").reverse().join("-") : undefined}
                legend={view.visit ? "New test time" : view.twoDay ? "Test time" : "Choose a time"}
                checkedAt={view.checkedAt}
                liveDates={view.liveDates}
                currentKey={moving ? view.visit?.examStart : undefined}
                items={view.slots}
                keyOf={(s) => s.examStart}
                startOf={(s) => s.examStart}
                selected={start}
                onSelect={(s) => {
                  setStart(s.examStart);
                  // The mock list opens below the test list: bring it into view (Sol r1).
                  if (view.twoDay && !slot) reveal("mock-start");
                }}
                tile={(s) => (
                  <>
                    <b>
                      {time(s.examStart)}–{time(s.mockEnd ?? s.examEnd)}
                    </b>
                    {s.mockEnd && <small>with mock teaching</small>}
                  </>
                )}
              />
            )}
            {showForm && view.twoDay && !slot && (
              <section className={c.step} aria-labelledby="mock-wait">
                <h2 className={c.stepTitle} id="mock-wait">
                  Mock teaching time
                </h2>
                <p className={c.note}>1 hour, if you pass. Choose a test time first.</p>
              </section>
            )}
            {showForm && view.twoDay && slot && (
              <Picker
                zoneNote={false}
                id="mock-start"
                legend="Mock teaching time"
                hint="1 hour · weekdays"
                checkedAt={null}
                items={laterMocks}
                keyOf={(m) => m.start}
                startOf={(m) => m.start}
                selected={mock?.start ?? ""}
                onSelect={(m) => setMock(m.start)}
                tile={(m) => (
                  <b>
                    {time(m.start)}–{time(m.end)}
                  </b>
                )}
              />
            )}
          </>
        }
        side={
          showForm && (
            <>
              <Checks onsite={onsite} commitment={commitment} setOnsite={setOnsite} setCommitment={setCommitment} />
              {moving && <p className={c.note}>This is your one move.</p>}
              {keep}
              <VisitConfirm
                error={error}
                missing={[!start && "a test time", unchanged && "times that differ from your booking", view.twoDay && !mock && "a mock teaching time", (!onsite || !commitment) && "both boxes"].filter(Boolean).join(", ")}
                disabled={busy || !start || (view.twoDay && !mock) || !onsite || !commitment || unchanged}
                label={busy ? "Confirming…" : view.visit ? (view.twoDay ? "Confirm new times" : "Confirm new time") : view.twoDay ? "Confirm both times" : "Confirm visit"}
                onConfirm={book}
                summary={
                  slot && (
                    <div className={cs.chosen}>
                      <div>
                        <span>Test</span>
                        <b>
                          {short(slot.examStart)}, {time(slot.examStart)}
                        </b>
                      </div>
                      {view.twoDay && (
                        <div>
                          <span>Mock teaching, if you pass</span>
                          <b>{mock ? `${short(mock.start)}, ${time(mock.start)}` : "Choose a time"}</b>
                        </div>
                      )}
                    </div>
                  )
                }
              />
            </>
          )
        }
      />
      {/* While choosing, LINE help sits in the notices and errors; the footer comes back once a visit is booked (Sol r4–r5). */}
      {!notice && !showForm && <Help />}
    </>
  );
}

/** R1: HR Interview on Google Meet (or contract signing): one time, and a backup phone number for R1. */
export function CallBooking({ token, view, reload }: { token: string; view: CallView; reload: () => Promise<void> }) {
  const [moving, setMoving] = useState(false),
    [chosen, setStart] = useState(""),
    [phone, setPhone] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  const contract = view.kind === "contract";
  const appointment = contract ? "contract signing" : "R1 interview";
  // The list reloads on its own, so a chosen time that has gone is no longer chosen.
  const slot = view.slots.find((s) => s.start === chosen);
  const start = slot?.start ?? "";
  // The server checks the number again; this only keeps the button off until it can pass.
  const phoneOk = contract || phoneSchema.safeParse(phone).success;
  async function book() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const r = await fetch(`/api/hiring/book/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contract ? { start } : { start, phone, ...(view.call ? { move: true } : {}) }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      await reload();
      setSaved(
        view.call
          ? "Your R1 interview has moved. The new time is below. A confirmation email and a calendar invitation with the Google Meet link will follow."
          : `Your ${appointment} is confirmed. A confirmation email and a calendar invitation${contract ? "" : " with the Google Meet link"} will follow.`,
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
    view.notice ?? (view.call || view.slots.length ? null : `There are no open ${appointment} times at the moment. Contact BeGifted on LINE: ${LINE_URL}`);
  const showForm = (!view.call || moving) && !notice;
  const keep = moving && (
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
  );
  return (
    <>
      {saved && <Saved>{saved}</Saved>}
      <div className={c.facts}>
        <Fact icon={contract ? <FileSignature aria-hidden /> : <Video aria-hidden />} label={contract ? "Contract signing" : "R1: HR Interview"}>
          {view.minutes} minutes {contract ? "with our team" : "on Google Meet with our HR team"}
        </Fact>
        {view.kind === "contract" ? <Fact icon={<MapPin aria-hidden />} label="Where">{view.location}</Fact> : <p className={c.note}>Google Calendar sends you the Google Meet link.</p>}
      </div>
      {view.call && (
        <section>
          <div className={c.stepHead}>
            <h2 className={c.stepTitle}>Your booked {appointment}</h2>
            <span className={c.badge}>
              <Check aria-hidden size={14} /> Confirmed
            </span>
          </div>
          <div className={c.ticket}>
            <div className={c.ticketDate}>
              <span>{part(view.call.start, { weekday: "short" })}</span>
              <b>{part(view.call.start, { day: "numeric" })}</b>
              <span>{part(view.call.start, { month: "short" })}</span>
            </div>
            <div className={c.ticketBody}>
              <span>{day(view.call.start)}</span>
              <div className={c.ticketRow}>
                <span>{contract ? "Onsite" : "Google Meet"}</span>
                <strong>
                  {time(view.call.start)}–{time(view.call.end)}
                </strong>
              </div>
            </div>
          </div>
          {!view.canMove && !notice && <p className={c.note}>To change this visit, contact BeGifted on LINE.</p>}
          {view.canMove && !moving && (
            <div className={c.move}>
              <p className={c.note}>You can move this {appointment} once, before it starts.</p>
              <button type="button" className={c.ghost} disabled={busy || !view.slots.length} onClick={() => setMoving(true)}>
                Move this {appointment}
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
      {/* The list can empty while the candidate is moving: the way back stays on the page. */}
      {!showForm && keep}
      {showForm && (
        <>
          <Picker
            compact
            legend={view.call ? "Choose a new time" : "Choose a time"}
            checkedAt={null}
            items={view.slots}
            keyOf={(s) => s.start}
            startOf={(s) => s.start}
            selected={start}
            onSelect={(s) => setStart(s.start)}
            tile={(s) => <b>{time(s.start)}</b>}
          />
          {!contract && <label className={c.field}>
            <span className={c.stepTitle}>Your phone number (backup)</span>
            <input
              className={c.input}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              maxLength={40}
              placeholder="+66 81 234 5678"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <span className={c.note}>We use this number only if the video call fails. Include the country code if it is not a Thai number.</span>
          </label>}
          {keep}
          <VisitConfirm
            error={error}
            disabled={busy || !start || !phoneOk}
            label={busy ? "Confirming…" : view.call ? "Confirm new time" : `Confirm ${appointment}`}
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

export function BookingShell({
  kind,
  children,
  bare = false,
  booked = false,
}: {
  kind?: "visit" | "mock" | "paper" | "brief" | "call" | "contract" | "onboarding" | "paper-check";
  children: ReactNode;
  bare?: boolean;
  /** Booked: the title says "Your …", not "Book your …". */
  booked?: boolean;
}) {
  return (
    <main className={c.page} data-brief={kind === "brief" || kind === "paper-check" ? "" : undefined} data-bare={bare ? "" : undefined}>
      {/* `bare`: the page is open inside the head's Hiring screen, which has its own header. */}
      {!bare && <header className={c.hero} data-brief={kind === "brief" || kind === "paper-check" ? "" : undefined} data-wide={kind === "paper-check" ? "" : undefined}>
        <div className={c.heroInner}>
          <p className={c.brand}>BeGifted Education</p>
          <h1 className={c.title}>
            {kind === "onboarding" ? "Tutor " : kind === "brief" ? "Interview " : kind === "paper-check" ? "Paper " : kind && !booked ? "Book your " : "Your "}
            <em>{kind === "onboarding" ? "onboarding" : kind === "brief" ? "brief" : kind === "paper-check" ? "check" : kind === "contract" ? "contract signing" : kind === "call" ? "R1: HR Interview" : kind === "visit" ? "onsite visit" : kind === "mock" ? "mock teaching session" : kind === "paper" ? "paper assessment" : "booking"}</em>
          </h1>
        </div>
      </header>}
      <div className={c.sheet}>
        <div className={c.card}>{children}</div>
      </div>
    </main>
  );
}

export function HiringBooking({ token }: { token: string }) {
  const [view, setView] = useState<View | VisitView | CallView | null>(null),
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
  // One list with no subject choice: the visit and the HR call.
  const visit = view?.kind === "visit" || view?.kind === "call" || view?.kind === "contract";
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
  const old = view && view.kind !== "visit" && view.kind !== "call" && view.kind !== "contract" ? view : null;
  const selectionBooked =
    !!old && subjects.some((subject) => old.bookings.some((booking) => booking.kind === old.kind && booking.subjects.includes(subject)));
  const form = !!old && old.enabled && !selectionBooked;
  return (
    <BookingShell kind={view?.kind} booked={!!view && (("visit" in view && !!view.visit) || ("call" in view && !!view.call))}>
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
        // A new key when the questions give way to the times, so the times start from the fresh view (code review r4).
        <VisitBooking key={view.waiting ?? "times"} token={token} view={view} reload={() => load()} />
      ) : (view.kind === "call" || view.kind === "contract") ? (
        <CallBooking token={token} view={view} reload={() => load()} />
      ) : (
        <>
          <div className={c.facts}>
            <Fact icon={<MapPin aria-hidden />} label="Where">
              {view.location}
            </Fact>
            <p className={c.note}>
              All times are Bangkok time.{" "}
              {view.kind === "mock"
                ? "Choose one subject for each one-hour session. Times cover the next four weeks, Monday–Friday, 10:00–16:00."
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
                  startOf={(slot) => slot.start}
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
