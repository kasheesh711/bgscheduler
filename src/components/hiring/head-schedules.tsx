"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { localDate, shiftDate, weekStart, ZONE, type HiringConfig } from "@/lib/hiring/model";
import type { HeadBlock, HeadWeek } from "@/lib/hiring/head-schedule";
import css from "./dashboard.module.css";

// The calendar runs 09:00 to 19:00 at 56 px an hour.
const FIRST = 9 * 60;
const LAST = 19 * 60;
const PX = 56;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const HOURS = Array.from({ length: 11 }, (_, i) => i + 9);
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const y = (m: number) => ((m - FIRST) / 60) * PX;
const dayLabel = (date: string) => `${DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]} ${Number(date.slice(8))}`;
const rangeLabel = (start: string) => {
  const part = (date: string, month: boolean) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", ...(month && { month: "short" }), timeZone: "UTC" });
  const end = shiftDate(start, 4);
  return `${part(start, start.slice(5, 7) !== end.slice(5, 7))}–${part(end, true)} ${end.slice(0, 4)}`;
};
const at = (iso: string) => formatInTimeZone(new Date(iso), ZONE, "EEE d MMM, HH:mm");

const KIND: Record<HeadBlock["kind"], { title: string; css: string }> = {
  wise: { title: "Wise class", css: css.bWise },
  leave: { title: "Leave", css: css.bWise },
  sit_in: { title: "Sit-in", css: css.bSitIn },
  mock: { title: "Mock", css: css.bMock },
  exam: { title: "Exam · head not needed", css: css.bExam },
};

/** One head's week: banners, the calendar, the legend. Opens a candidate from a mock block. */
export function HeadCalendar({ week, onOpen }: { week: HeadWeek; onOpen: (candidateId: string) => void }) {
  const clashes = week.visits.filter((v) => v.clash);
  const officeDays = week.days.flatMap((d, i) => (d.office ? [`${DAYS[i]} ${d.office.start}–${d.office.end}`] : []));
  return (
    <>
      <p className={css.headNote}>
        {officeDays.length ? `Office days: ${officeDays.join(" · ")}.` : "No office days this week."} Classes and leave come from Wise.
      </p>
      {week.stale && (
        <p role="status" className={`${css.headBanner} ${css.headBannerStale}`}>
          Wise data for this head is old or incomplete, so classes and leave may be missing. Check Wise before you rely on this week.
        </p>
      )}
      {clashes.length > 0 && (
        <div role="alert" className={`${css.headBanner} ${css.headBannerClash}`}>
          {clashes.map((v) => (
            <p key={v.candidateId + v.mockStart}>
              {at(v.mockStart)}: a Wise class, leave or sit-in overlaps the mock with {v.candidate}. The app did not move the visit. Staff must act.
            </p>
          ))}
        </div>
      )}
      <div className={css.calScroll}>
        <div className={css.cal}>
          <div />
          {week.days.map((d) => (
            <div key={d.date} className={css.calDayHead}>
              {dayLabel(d.date)} {!d.office && <span className={css.calDayTag}>Not in office</span>}
            </div>
          ))}
          <div className={css.calHours} aria-hidden="true">
            {HOURS.map((h) => (
              <span key={h} className={css.hourLabel} style={{ top: y(h * 60) }}>
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {week.days.map((d) => (
            <div key={d.date} className={`${css.calDay} ${d.office ? "" : css.calOff}`}>
              {d.office && (
                <div
                  className={css.calBand}
                  style={{
                    top: y(Math.max(FIRST, minute(d.office.start))),
                    height: Math.max(0, y(Math.min(LAST, minute(d.office.end))) - y(Math.max(FIRST, minute(d.office.start)))),
                  }}
                />
              )}
              {HOURS.map((h) => (
                <div key={h} className={css.hourLine} style={{ top: y(h * 60) }} aria-hidden="true" />
              ))}
              {d.blocks.flatMap((b, i) => {
                const from = Math.max(FIRST, minute(b.start));
                const to = Math.min(LAST, minute(b.end));
                if (to <= from) return [];
                const kind = KIND[b.kind];
                const title = b.clash ? "Mock · clash" : kind.title;
                const sub = b.candidate ? (b.subject ? `${b.candidate} · ${b.subject}` : b.candidate) : "";
                const props = {
                  className: `${css.blk} ${b.clash ? css.bClash : kind.css}`,
                  style: { top: y(from) + 1, height: Math.max(14, y(to) - y(from) - 2) },
                  "aria-label": `${title}${sub ? `, ${sub}` : ""}, ${b.start} to ${b.end}`,
                };
                const body = (
                  <>
                    <span className={css.blkTitle}>{title}</span>
                    {sub}
                  </>
                );
                return [
                  b.kind === "mock" && b.candidateId ? (
                    <button key={i} type="button" {...props} onClick={() => onOpen(b.candidateId!)}>
                      {body}
                    </button>
                  ) : (
                    <div key={i} {...props} role="img">
                      {body}
                    </div>
                  ),
                ];
              })}
            </div>
          ))}
        </div>
      </div>
      <div className={css.headLegend}>
        <span><i style={{ background: "#fffdf9", boxShadow: "inset 0 0 0 1px var(--stone)" }} />Free in office hours</span>
        <span><i style={{ background: "var(--ink)" }} />Mock (head busy)</span>
        <span><i style={{ boxShadow: "inset 0 0 0 1px var(--stone-dark)" }} />Exam (does not need the head)</span>
        <span><i style={{ background: "var(--stone)" }} />Wise class or leave</span>
        <span><i style={{ background: "var(--stone-dark)" }} />Sit-in</span>
        <span><i style={{ background: "var(--danger)" }} />Clash</span>
        <span>Stripes: not in the office</span>
      </div>
    </>
  );
}

type Booking = { kind: string; status: string; interviewerKey: string | null; startTime: unknown };

/** The Head schedules view: a head switch, a week switch that cannot go back, and the head's visits. */
export function HeadSchedules({
  heads,
  bookings,
  onOpenCandidate,
}: {
  heads: HiringConfig["interviewers"];
  bookings: Booking[];
  onOpenCandidate: (candidateId: string) => void;
}) {
  const current = weekStart(localDate(new Date()));
  const [key, setKey] = useState(heads[0]?.canonicalKey ?? "");
  const [start, setStart] = useState(current);
  // The result carries the head and week it answers, so a slow answer for an old choice never shows.
  const [result, setResult] = useState<{ key: string; start: string; week: HeadWeek | null; error: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    fetch(`/api/hiring?head=${encodeURIComponent(key)}&weekStart=${start}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        setResult({ key, start, week: value, error: "" });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResult({ key, start, week: null, error: e instanceof Error ? e.message : "Could not load this week." });
      });
    return () => controller.abort();
  }, [key, start]);

  if (!heads.length)
    return <p className={css.loading}>Add heads of department in Rules and setup to see their schedules.</p>;
  const answer = result?.key === key && result.start === start ? result : null;
  const week = answer?.week ?? null;
  const count = (head: string) =>
    bookings.filter(
      (b) =>
        b.status === "confirmed" &&
        b.kind === "mock" &&
        b.interviewerKey === head &&
        weekStart(localDate(new Date(String(b.startTime)))) === start,
    ).length;

  return (
    <div className={css.heads}>
      <section className={css.headsMain} aria-label="Head schedule">
        <div className={css.headsBar}>
          <div className={css.headTabs} role="group" aria-label="Choose a head of department">
            {heads.map((h) => (
              <button
                key={h.canonicalKey}
                type="button"
                className={css.headTab}
                aria-pressed={key === h.canonicalKey}
                onClick={() => setKey(h.canonicalKey)}
              >
                {h.canonicalKey} <span className={css.tabCount}>{count(h.canonicalKey)}</span>
              </button>
            ))}
          </div>
          <div className={css.weekNav}>
            {/* Wise omits past sessions, so the first week is the current one. */}
            <button type="button" className={css.navButton} disabled={start <= current} onClick={() => setStart(shiftDate(start, -7))}>
              Previous
            </button>
            <span className={css.weekLabel}>{rangeLabel(start)}</span>
            <button type="button" className={css.navButton} onClick={() => setStart(shiftDate(start, 7))}>
              Next
            </button>
          </div>
        </div>
        {answer?.error && (
          <p role="alert" className={css.alert}>
            {answer.error}
          </p>
        )}
        {week ? (
          <HeadCalendar week={week} onOpen={onOpenCandidate} />
        ) : (
          !answer && (
            <p role="status" className={css.loading}>
              Loading schedule…
            </p>
          )
        )}
      </section>
      <section className={css.headsSide} aria-label="Visits this week">
        <h2 className={css.headName}>{week?.name ?? key}</h2>
        {week && <p className={css.railLede}>{week.subjects.join(", ")}</p>}
        <h3 className={css.railTitle}>Visits in this week</h3>
        {week?.visits.map((v) => (
          <div key={v.candidateId + v.mockStart} className={css.headVisit}>
            <button type="button" onClick={() => onOpenCandidate(v.candidateId)}>
              {v.candidate}
            </button>
            <div className={css.railMeta}>{v.subject}</div>
            <div>Exam {at(v.examStart)}</div>
            <div>Mock {at(v.mockStart)}</div>
            {v.clash && <span className={css.clashWord}>Clash with Wise, leave or a sit-in</span>}
          </div>
        ))}
        {week && !week.visits.length && <p className={css.railLede}>No visits in this week.</p>}
        {week && (
          <div className={css.headMocks}>
            <span className={css.railMeta}>Mocks this week</span>
            <span className={css.num}>
              {week.mocks} of {week.limit}
            </span>
          </div>
        )}
        <p className={css.railMeta}>Change days and limits in Rules and setup.</p>
      </section>
    </div>
  );
}
