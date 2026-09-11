"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ClassroomPrintReport, ClassroomPrintView } from "@/lib/classrooms/print-report";
import { Button } from "@/components/ui/button";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { buildPrintCards, paginatePrintCards, type PrintCard, type PrintBlock, type PrintPage } from "./print-pagination";
import styles from "./classroom-print.module.css";

function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00+07:00`));
}

function Students({ block }: { block: PrintBlock }) {
  return <>
    <span className={styles.note} data-students-continued hidden={!block.continued}>Students continued</span>
    {block.students.length ? <ul className={styles.students} data-student-list>{block.students.map((name, index) => <li key={`${block.studentOffset + index}:${name}`}>{name}</li>)}</ul>
      : <span className={styles.note}>{block.rosterStatus === "verified" ? "No students enrolled" : "Student list unavailable"}</span>}
  </>;
}

function BlockNotes({ block }: { block: PrintBlock }) {
  return <div data-block-notes hidden={block.continued}>
    {block.roomChange && <span className={styles.change}>Room change</span>}
    {block.outsideUsualRooms && <span className={styles.note}>Outside usual rooms</span>}
    {block.publication === "draft" && <span className={styles.note}>Draft · awaiting publish</span>}
    {block.publication === "failed" && <span className={styles.problem}>Publish failed · check with team</span>}
    {block.publication === "needs_review" && <span className={styles.problem}>Check with the team</span>}
    {block.notes.map((note, index) => <span key={index} className={styles.problem}>{note}</span>)}
  </div>;
}

export function ClassroomPrintCard({ card }: { card: PrintCard }) {
  const teacher = card.kind === "tutor";
  return <section className={`${styles.teacher} ${teacher ? "" : styles.room}`} data-print-card={card.id}>
    <header><h2>{card.title}<small data-card-continued hidden={!card.continued}> · continued</small></h2><p>{card.subtitle}</p></header>
    {!card.blocks.length ? <p className={styles.empty}>No classes scheduled.</p> : <table>
      <thead><tr><th>Time</th>{teacher ? <th>Classroom / Students</th> : <><th>Tutor{card.kind === "exceptions" && " / Saved room"}</th><th>Students</th></>}</tr></thead>
      <tbody>{card.blocks.map(block => <tr key={`${block.rowId}:${block.studentOffset}`} data-block-row={block.rowId}>
        <td>{block.startTime}–{block.endTime}</td>
        {teacher ? <td><strong>{block.room}</strong><Students block={block} /><BlockNotes block={block} /></td>
          : <><td><strong>{block.tutorDisplayName}</strong>{card.kind === "exceptions" && <span className={styles.note}>Saved room: {block.room}</span>}</td>
            <td><Students block={block} /><BlockNotes block={block} /></td></>}
      </tr>)}</tbody>
    </table>}
  </section>;
}

/** Measure the rendered styles, including continuation headings and Thai wrapping. */
function measureCard(card: PrintCard, source: HTMLElement, host: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelector<HTMLElement>("[data-card-continued]")!.hidden = !card.continued;
  const rows = new Map([...clone.querySelectorAll<HTMLTableRowElement>("[data-block-row]")].map(row => [row.dataset.blockRow!, row]));
  const tbody = clone.querySelector("tbody");
  if (tbody) {
    tbody.replaceChildren();
    for (const block of card.blocks) {
      const row = rows.get(block.rowId)!.cloneNode(true) as HTMLElement;
      row.querySelectorAll("[data-student-list] li").forEach((li, index) => {
        if (index < block.studentOffset || index >= block.studentOffset + block.students.length) li.remove();
      });
      row.querySelector<HTMLElement>("[data-students-continued]")!.hidden = !block.continued;
      row.querySelector<HTMLElement>("[data-block-notes]")!.hidden = block.continued;
      tbody.append(row);
    }
  }
  host.append(clone);
  const height = clone.getBoundingClientRect().height;
  clone.remove();
  return height;
}

export function ClassroomPrintUnavailable({ message }: { message: string }) {
  return <div role="alert"><p className="my-4">{message}</p><Button onClick={() => window.location.reload()}>Retry roster refresh</Button></div>;
}

export function ClassroomPrintDocument({ report: initialReport, missingDates = [], view: initialView = "tutors" }: {
  report: ClassroomPrintReport; missingDates?: string[]; view?: ClassroomPrintView;
}) {
  const [report, setReport] = useState(initialReport);
  const [view, setView] = useState(initialView);
  const root = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const pendingPrint = useRef<ClassroomPrintReport | null>(null);
  const request = useRef<AbortController | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<{ report: ClassroomPrintReport; view: ClassroomPrintView; pages: PrintPage[]; error?: string } | null>(null);
  const dayCards = useMemo(() => buildPrintCards(report, view), [report, view]);
  const ready = layout?.report === report && layout.view === view && !layout.error;
  const pages = ready ? layout.pages : [];

  useEffect(() => {
    let canceled = false;
    void document.fonts.ready.then(() => {
      if (canceled || !measure.current) return;
      try {
        const elements = new Map([...measure.current.querySelectorAll<HTMLElement>("[data-print-card]")].map(el => [el.dataset.printCard!, el]));
        const pages = paginatePrintCards(dayCards, card => {
          const source = elements.get(card.id)!;
          return measureCard(card, source, source.parentElement!);
        }, 137 * 96 / 25.4);
        if (!canceled) setLayout({ report, view, pages });
      } catch (cause) {
        if (!canceled) setLayout({ report, view, pages: [], error: cause instanceof Error ? cause.message : "Could not prepare printable pages." });
      }
    });
    return () => { canceled = true; };
  }, [dayCards, report, view]);

  useEffect(() => {
    const afterPrint = () => { root.current?.removeAttribute("data-print-approved"); };
    window.addEventListener("afterprint", afterPrint);
    return () => { window.removeEventListener("afterprint", afterPrint); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!ready || pendingPrint.current !== report || report.refreshFailed) return;
    let canceled = false;
    void (async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(img => img.decode().catch(() => undefined)));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (canceled || !root.current) return;
      pendingPrint.current = null;
      root.current.dataset.printApproved = "true";
      try { window.print(); }
      catch { root.current.removeAttribute("data-print-approved"); setError("Printing could not start. Please retry."); }
    })();
    return () => { canceled = true; };
  }, [ready, report]);

  async function refresh(print: boolean) {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setRefreshing(true); setError(null); pendingPrint.current = null;
    root.current?.removeAttribute("data-print-approved");
    try {
      const query = new URLSearchParams({ runIds: report.days.map(day => day.runId).join(",") });
      const response = await fetch(`/api/class-assignments/print-report?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Student rosters could not be refreshed. Retry before printing.");
      }
      const next = await response.json() as ClassroomPrintReport;
      setReport(next);
      if (next.refreshFailed) setError("Some student rosters could not be refreshed from Wise. Retry before printing.");
      else if (print) pendingPrint.current = next;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Roster refresh failed. Please retry.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }

  const warning = error ?? layout?.error ?? (report.refreshFailed ? "Some student rosters could not be refreshed from Wise. Retry before printing." : null);
  return <main ref={root} className={`begifted ${styles.root}`}>
    {/* Safari can fall back to the app's unnamed @page rule. Mount this override
        with the report so its landscape margins do not affect other reports. */}
    <style>{"@page { size: A4 landscape; margin: 0; }"}</style>
    <div className={styles.toolbar}><Link href="/class-assignments">← Class Assignments</Link>
      <label>Print by <select aria-label="Print grouping" value={view} disabled={refreshing} onChange={event => {
        const next = event.target.value as ClassroomPrintView; setView(next);
        root.current?.removeAttribute("data-print-approved"); pendingPrint.current = null;
        const url = new URL(window.location.href); url.searchParams.set("view", next); window.history.replaceState(null, "", url);
      }}><option value="tutors">By tutor</option><option value="rooms">By room</option></select></label>
      <span>A4 landscape · Rosters checked {formatBangkokDateTime(report.rosterCheckedAt)}</span>
      <Button disabled={!ready || refreshing} onClick={() => void refresh(true)}>{refreshing ? "Refreshing rosters…" : ready ? "Print / Save PDF" : "Preparing pages…"}</Button>
    </div>
    {warning && <div className={styles.missing} role="alert">{warning} <Button disabled={refreshing} onClick={() => void refresh(false)}>Retry roster refresh</Button></div>}
    {missingDates.length > 0 && <p className={styles.missing} role="status">No saved assignments for {missingDates.join(", ")}. These days are not included.</p>}
    <p className={styles.printNotice}>Use the Print / Save PDF button on this page to refresh student rosters before printing.</p>
    <div ref={measure} className={styles.measure} aria-hidden="true">{dayCards.flatMap(({ cards }) => cards.map(card => <div key={card.id} style={{ width: card.kind === "tutor" ? "134.5mm" : "277mm" }}><ClassroomPrintCard card={card} /></div>))}</div>
    <div className={styles.sheets}>{pages.map((page, index) => <article key={`${page.day.runId}:${index}`} className={styles.sheet} data-print-sheet>
      <header className={styles.pageHeader}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-horizontal.png" alt="BeGifted Education" width="130" height="51" />
        <div><p className={styles.eyebrow}>DAILY CLASSROOMS · ตารางห้องเรียน</p><h1>{dateLabel(page.day.date)}</h1></div>
        <span className={page.day.draft || report.refreshFailed ? styles.draft : styles.approved}>{page.day.draft || report.refreshFailed ? "DRAFT / CHECK ASSIGNMENTS" : "SAVED CLASSROOM PLAN"}</span>
      </header>
      {!page.columns.some(cards => cards.length) ? <p>No classes in this saved run.</p> : <div className={page.fullWidth ? styles.singleColumn : styles.columns}>{page.columns.map((cards, column) => <div key={column}>{cards.map((card, part) => <ClassroomPrintCard key={`${card.id}:${part}`} card={card} />)}</div>)}</div>}
      <footer className={styles.footer}><span>BeGifted Education · All times Bangkok<br />Generated {formatBangkokDateTime(report.generatedAt)}<br />Rosters checked {formatBangkokDateTime(report.rosterCheckedAt)}</span>
        <span>{page.day.date} · Revision {page.day.revision}<br />Page {index + 1} of {pages.length} · Check the date before use</span></footer>
    </article>)}</div>
  </main>;
}
