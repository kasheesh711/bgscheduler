"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ClassroomPrintReport } from "@/lib/classrooms/print-report";
import { Button } from "@/components/ui/button";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import styles from "./classroom-print.module.css";

type Day = ClassroomPrintReport["days"][number];
type Teacher = Day["tutors"][number];
interface Card { id: string; teacher: Teacher; continued: boolean }
interface Page { day: Day; columns: [Card[], Card[]] }

function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00+07:00`));
}

function TeacherCard({ card }: { card: Card }) {
  return <section className={styles.teacher} data-print-card={card.id}>
    <header><h2>{card.teacher.tutorDisplayName}{card.continued && <small> · continued</small>}</h2>
      <p>Usual rooms: {card.teacher.usualRooms.map(room => `${room}${card.teacher.unavailableRooms?.includes(room) ? " (unavailable)" : ""}`).join(" · ") || "Not yet established"}</p></header>
    <table><thead><tr><th>Time</th><th>Classroom</th></tr></thead><tbody>
      {card.teacher.blocks.map(block => <tr key={block.rowId}>
        <td>{block.startTime}–{block.endTime}</td><td><strong>{block.room}</strong>
          {block.roomChange && <span className={styles.change}>Room change</span>}
          {block.outsideUsualRooms && <span className={styles.note}>Outside usual rooms</span>}
          {block.publication === "draft" && <span className={styles.note}>Draft · awaiting publish</span>}
          {block.publication === "failed" && <span className={styles.problem}>Publish failed · check with team</span>}
          {block.publication === "needs_review" && <span className={styles.problem}>Check with the team</span>}
        </td>
      </tr>)}
    </tbody></table>
  </section>;
}

export function ClassroomPrintDocument({ report, missingDates = [] }: { report: ClassroomPrintReport; missingDates?: string[] }) {
  const measure = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [ready, setReady] = useState(false);
  const dayCards = useMemo(() => report.days.map(day => ({ day, cards: day.tutors.map(teacher => ({
    id: `${day.runId}:${teacher.canonicalKey}`, teacher, continued: false,
  })) })), [report]);
  useEffect(() => {
    let canceled = false;
    void document.fonts.ready.then(() => {
      if (canceled || !measure.current) return;
      const elements = new Map([...measure.current.querySelectorAll<HTMLElement>("[data-print-card]")].map(el => [el.dataset.printCard!, el]));
      const maxHeight = 148 * 96 / 25.4;
      const next: Page[] = [];
      for (const { day, cards } of dayCards) {
        let page: Page = { day, columns: [[], []] }, column = 0, used = 0;
        const chunks = cards.flatMap(card => {
          const element = elements.get(card.id)!;
          const height = element.getBoundingClientRect().height;
          if (height <= maxHeight) return [{ card, height }];
          const rowHeights = [...element.querySelectorAll("tbody tr")].map(row => row.getBoundingClientRect().height);
          // Reserve an extra line for the continuation label on long teacher names.
          const heading = height - rowHeights.reduce((sum, value) => sum + value, 0) + 24;
          const split: Array<{ card: Card; height: number }> = [];
          for (let start = 0; start < card.teacher.blocks.length;) {
            let end = start, size = heading;
            while (end < rowHeights.length && (end === start || size + rowHeights[end] <= maxHeight)) size += rowHeights[end++];
            split.push({ card: { ...card, id: `${card.id}:${start}`, continued: start > 0,
              teacher: { ...card.teacher, blocks: card.teacher.blocks.slice(start, end) } }, height: size });
            start = end;
          }
          return split;
        });
        for (const { card, height } of chunks) {
          if (used > 0 && used + height > maxHeight) {
            if (column === 0) column = 1;
            else { next.push(page); page = { day, columns: [[], []] }; column = 0; }
            used = 0;
          }
          page.columns[column].push(card); used += height + 10;
        }
        next.push(page);
      }
      setPages(next); setReady(true);
    });
    return () => { canceled = true; };
  }, [dayCards]);
  return <main className={`begifted ${styles.root}`}>
    <div className={styles.toolbar}><Link href="/class-assignments">← Class Assignments</Link>
      <span>A4 landscape · Print or Save as PDF</span>
      <Button disabled={!ready} onClick={async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(img => img.decode().catch(() => undefined)));
        window.print();
      }}>{ready ? "Print / Save PDF" : "Preparing pages…"}</Button>
    </div>
    {missingDates.length > 0 && <p className={styles.missing} role="status">No saved assignments for {missingDates.join(", ")}. These days are not included.</p>}
    <div ref={measure} className={styles.measure} aria-hidden="true">{dayCards.flatMap(({ cards }) => cards.map(card => <TeacherCard key={card.id} card={card} />))}</div>
    <div className={styles.sheets}>{pages.map((page, index) => <article key={`${page.day.runId}:${index}`} className={styles.sheet} data-print-sheet>
      <header className={styles.pageHeader}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-horizontal.png" alt="BeGifted Education" width="130" height="51" />
        <div><p className={styles.eyebrow}>DAILY CLASSROOMS · ตารางห้องเรียน</p><h1>{dateLabel(page.day.date)}</h1></div>
        <span className={page.day.draft ? styles.draft : styles.approved}>{page.day.draft ? "DRAFT / CHECK ASSIGNMENTS" : "SAVED CLASSROOM PLAN"}</span>
      </header>
      {page.day.tutors.length === 0 ? <p>No classes in this saved run.</p> : <div className={styles.columns}>{page.columns.map((cards, column) => <div key={column}>{cards.map(card => <TeacherCard key={card.id} card={card} />)}</div>)}</div>}
      <footer className={styles.footer}><span>BeGifted Education · All times Bangkok<br />Generated {formatBangkokDateTime(report.generatedAt)}</span>
        <span>{page.day.date} · Revision {page.day.revision}<br />Page {index + 1} of {pages.length} · Check the date before use</span></footer>
    </article>)}</div>
  </main>;
}
