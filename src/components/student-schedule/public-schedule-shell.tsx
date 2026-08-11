"use client";

// ----------------------------------------------------------------------------
// Client shell of the public parent schedule page: owns the scroll region,
// the sticky header with the agenda/calendar toggle, and which view shows.
//
// Zero-flash by construction: view state starts null (= auto), and auto is
// rendered as responsive class pairs (resolveViewContainerClasses), so the
// SSR HTML alone selects the agenda below lg and the calendar at lg+ — no
// storage or matchMedia read happens before the first paint, and the first
// client render matches the server byte for byte. Only an explicit toggle
// (persisted) or a stored preference (applied in an effect) forces a view.
//
// The agenda and the desktop month grid arrive as server-rendered slots;
// only the dot grid renders here because its day taps need a callback.
// Scroll-to-today lives here too (it replaced agenda-today-scroller.tsx):
// scrollIntoView on a display:none subtree is a no-op, so the pending-scroll
// effect keyed on state runs after the commit that revealed the agenda.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDaysIcon, ListIcon } from "lucide-react";

import { ParentScheduleDotGrid } from "./parent-schedule-dot-grid";
import {
  readStoredScheduleView,
  resolveViewContainerClasses,
  writeStoredScheduleView,
  type ScheduleView,
} from "./schedule-view-preference";
import { PUBLIC_PAGE_COPY } from "@/lib/line/schedule-bot-copy";
import type { StudentSchedulePayload } from "@/lib/student-schedule/types";

/** Tailwind lg — must match the lg: variants in resolveViewContainerClasses. */
const DESKTOP_QUERY = "(min-width: 1024px)";

const SEGMENT_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium " +
  "text-muted-foreground outline-none transition-colors hover:text-foreground " +
  "focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm";

type PendingScroll = { kind: "today" } | { kind: "day"; dateKey: string };

export function PublicScheduleShell({
  payload,
  todayKey,
  headerRow,
  agenda,
  desktopCalendar,
  footer,
}: {
  payload: StudentSchedulePayload;
  todayKey: string;
  headerRow: ReactNode;
  agenda: ReactNode;
  desktopCalendar: ReactNode;
  footer: ReactNode;
}) {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | null>(null);
  const agendaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // One-time post-hydration sync from browser-only state. Reading
    // localStorage during render would desync SSR hydration, so the stored
    // preference can only be applied here — an intentional single cascade.
    const stored = readStoredScheduleView(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setView(stored);
    // Unless the stored preference is the calendar, aim at today: on a phone
    // the agenda is visible and scrolls; on desktop-auto it is display:none
    // and the scroll self-cancels as a no-op.
    if (stored !== "calendar") setPendingScroll({ kind: "today" });
    const mediaQuery = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mediaQuery.matches);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  // Keyed on pendingScroll so it runs after the commit that applied a view
  // change — the agenda has layout boxes by the time we scroll to it. The
  // state is deliberately never cleared: every request is a fresh object, so
  // identity alone re-fires the effect, and clearing here would be a
  // setState-in-effect cascade for nothing.
  useEffect(() => {
    if (!pendingScroll) return;
    const target =
      pendingScroll.kind === "today"
        ? document.getElementById("agenda-scroll-target")
        : agendaRef.current?.querySelector(`[data-date="${pendingScroll.dateKey}"]`);
    target?.scrollIntoView({ block: "start" });
  }, [pendingScroll]);

  const effectiveView =
    view ?? (isDesktop == null ? null : isDesktop ? "calendar" : "agenda");
  const classes = resolveViewContainerClasses(view);

  const choose = (next: ScheduleView) => {
    if (next === "agenda" && effectiveView !== "agenda") {
      setPendingScroll({ kind: "today" });
    }
    setView(next);
    writeStoredScheduleView(window.localStorage, next);
  };

  // Dot-grid taps navigate; they never write the stored preference.
  const jumpToDay = (dateKey: string) => {
    setView("agenda");
    setPendingScroll({ kind: "day", dateKey });
  };

  return (
    <div
      lang="th"
      className="font-thai min-h-0 w-full flex-1 overflow-y-auto text-base"
    >
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className={classes.header}>
          <div>{headerRow}</div>
          <div
            role="group"
            aria-label={PUBLIC_PAGE_COPY.viewToggleLabel}
            className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
          >
            <button
              type="button"
              aria-pressed={effectiveView === "agenda"}
              onClick={() => choose("agenda")}
              className={SEGMENT_CLASS}
            >
              <ListIcon aria-hidden className="size-4" />
              {PUBLIC_PAGE_COPY.viewAgenda}
            </button>
            <button
              type="button"
              aria-pressed={effectiveView === "calendar"}
              onClick={() => choose("calendar")}
              className={SEGMENT_CLASS}
            >
              <CalendarDaysIcon aria-hidden className="size-4" />
              {PUBLIC_PAGE_COPY.viewCalendar}
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-4">
        <div ref={agendaRef} data-testid="shell-agenda" className={classes.agenda}>
          {agenda}
        </div>
        <div data-testid="shell-calendar" className={classes.calendar}>
          {/* The month grid's own week-list branch is lg:hidden, so this
              wrapper leaves exactly the grid at lg+ and nothing below it.
              print: variants keep a forced-calendar print on the grid —
              the dot grid is navigation, not a document. */}
          <div className="hidden lg:block print:block">{desktopCalendar}</div>
          <div className="lg:hidden print:hidden">
            <ParentScheduleDotGrid
              payload={payload}
              todayKey={todayKey}
              onSelectDay={jumpToDay}
            />
          </div>
        </div>
        <div className="mx-auto w-full max-w-screen-sm">{footer}</div>
      </main>
    </div>
  );
}
