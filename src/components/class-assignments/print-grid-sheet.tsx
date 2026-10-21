import type { PrintDay } from "./print-pagination";
import type { PrintGridColumn } from "@/lib/classrooms/print-grid";
import { GRID_HOUR_HEIGHT_MM, GRID_RAIL_WIDTH_MM, GRID_UNIT_WIDTH_MM } from "@/lib/classrooms/print-grid";
import { formatHourLabel } from "@/lib/classrooms/hourly-summary";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { dateLabel } from "./classroom-print-document";
import styles from "./classroom-print.module.css";

/** Height of each column/rail header cell. Kept in sync with .gridColumnHead in classroom-print.module.css. */
const COLUMN_HEAD_HEIGHT_MM = 9;

export interface GridPage { columns: PrintGridColumn[]; hasSummaryPanel: boolean }

/** Room ordinals are global across the whole day's columns, not just this page's. */
function pageRangeLabel(day: PrintDay, page: GridPage): string {
  const allRooms = day.grid.columns.filter(c => c.kind === "room");
  const pageRooms = page.columns.filter(c => c.kind === "room");
  const parts: string[] = [];
  if (pageRooms.length) {
    const first = allRooms.indexOf(pageRooms[0]) + 1;
    const last = allRooms.indexOf(pageRooms[pageRooms.length - 1]) + 1;
    parts.push(first === last ? `Room ${first}` : `Rooms ${first}–${last}`);
  }
  if (page.columns.some(c => c.kind === "no_room")) parts.push("No room");
  if (page.columns.some(c => c.kind === "online")) parts.push("Online");
  return parts.length ? parts.join(" · ") : "Summary";
}

function columnHeadClassName(kind: PrintGridColumn["kind"]): string {
  if (kind === "no_room") return `${styles.gridColumnHead} ${styles.gridColumnHeadNoRoom}`;
  if (kind === "online") return `${styles.gridColumnHead} ${styles.gridColumnHeadOnline}`;
  return styles.gridColumnHead;
}

/** Colour by column kind: sky room, violet online booth, red no-room, slate online. needs_review overrides to amber inside a room column. */
function blockClassName(col: PrintGridColumn, status: string): string {
  if (col.kind === "no_room") return `${styles.gridBlock} ${styles.gridBlockNoRoom}`;
  if (col.kind === "online") return `${styles.gridBlock} ${styles.gridBlockOnline}`;
  if (status === "needs_review") return `${styles.gridBlock} ${styles.gridBlockReview}`;
  return `${styles.gridBlock} ${col.category === "online_only" ? styles.gridBlockBooth : styles.gridBlockRoom}`;
}

function GridColumn({ col, boundsStart, bodyHeightMm }: { col: PrintGridColumn; boundsStart: number; bodyHeightMm: number }) {
  return <div className={styles.gridColumn} style={{ width: `${col.units * GRID_UNIT_WIDTH_MM}mm` }}>
    <div className={columnHeadClassName(col.kind)}>
      <div className={styles.gridRoomName}>{col.title}</div>
      <div className={styles.gridRoomSub}>{col.subtitle}</div>
    </div>
    <div className={styles.gridColumnBody} style={{ height: `${bodyHeightMm}mm` }}>
      {col.blocks.map(block => {
        const laneWidth = (col.units * GRID_UNIT_WIDTH_MM - 1.0) / block.totalColumns;
        const top = (block.startMinute - boundsStart) / 60 * GRID_HOUR_HEIGHT_MM;
        const height = (block.endMinute - block.startMinute) / 60 * GRID_HOUR_HEIGHT_MM - 0.5;
        const left = 0.5 + block.column * laneWidth;
        const width = laneWidth - 0.4;
        return <div key={block.rowId} className={blockClassName(col, block.status)}
          style={{ top: `${top}mm`, height: `${height}mm`, left: `${left}mm`, width: `${width}mm` }}>
          <span className={styles.gridBlockTutor}>{block.tutor}</span>
          <span className={styles.gridBlockLabel}>{block.label}</span>
          <span className={styles.gridBlockTime}>{formatHourLabel(block.startMinute)}–{formatHourLabel(block.endMinute)}</span>
        </div>;
      })}
    </div>
  </div>;
}

function GridRail({ day, bodyHeightMm, roomCount }: { day: PrintDay; bodyHeightMm: number; roomCount: number }) {
  return <div className={styles.gridRail} style={{ width: `${GRID_RAIL_WIDTH_MM}mm` }}>
    <div className={styles.gridColumnHead}>
      <div className={styles.gridRoomName}>Time</div>
      <div className={styles.gridRoomSub}>classes · rooms needed</div>
    </div>
    <div className={styles.gridColumnBody} style={{ height: `${bodyHeightMm}mm` }}>
      {day.grid.hours.map(hour => {
        const top = (hour.hourStart - day.grid.bounds.startMinute) / 60 * GRID_HOUR_HEIGHT_MM;
        return <div key={hour.hourStart} className={styles.gridRailHour} style={{ top: `${top}mm`, height: `${GRID_HOUR_HEIGHT_MM}mm` }}>
          <strong className={styles.gridRailHourLabel}>{formatHourLabel(hour.hourStart)}</strong>
          <span className={styles.gridRailClasses}>{hour.classes} classes</span>
          <span className={`${styles.gridRailRooms}${hour.over ? ` ${styles.gridRailOver}` : ""}`}>{hour.roomsNeeded}/{roomCount} rooms</span>
          {hour.noRoom > 0 && <span className={styles.gridRailNoRoom}>{hour.noRoom} no room</span>}
        </div>;
      })}
    </div>
  </div>;
}

function SummaryPanel({ day, roomCount }: { day: PrintDay; roomCount: number }) {
  const noRoomCol = day.grid.columns.find(c => c.kind === "no_room")!;
  return <aside className={styles.gridPanel}>
    <h2 className={styles.gridPanelHeading}>By the hour</h2>
    <table className={styles.gridPanelTable}>
      <thead><tr><th>Hour</th><th>Classes</th><th>Rooms</th><th>No room</th></tr></thead>
      <tbody>{day.grid.hours.map(hour => <tr key={hour.hourStart} className={hour.over ? styles.gridPanelOverRow : undefined}>
        <td>{formatHourLabel(hour.hourStart)}</td><td>{hour.classes}</td><td>{hour.roomsNeeded}/{roomCount}</td><td>{hour.noRoom || ""}</td>
      </tr>)}</tbody>
    </table>
    <h2 className={`${styles.gridPanelHeading} ${styles.gridPanelHeadingWarn}`}>Still need a room ({noRoomCol.blocks.length})</h2>
    <ul className={styles.gridPanelList}>{noRoomCol.blocks.map(block => <li key={block.rowId} className={styles.gridPanelListItem}>
      <strong>{formatHourLabel(block.startMinute)}–{formatHourLabel(block.endMinute)}</strong> {block.tutor} · {block.label}
    </li>)}</ul>
  </aside>;
}

export function ClassroomPrintGridSheet({ day, page, pageIndex, pageCount, generatedAt, rosterCheckedAt }: {
  day: PrintDay; page: GridPage; pageIndex: number; pageCount: number; generatedAt: string; rosterCheckedAt: string;
}) {
  const bodyHeightMm = (day.grid.bounds.endMinute - day.grid.bounds.startMinute) / 60 * GRID_HOUR_HEIGHT_MM;
  const roomCount = day.grid.columns.filter(c => c.kind === "room").length;
  const columnsWidthMm = page.columns.reduce((sum, col) => sum + col.units * GRID_UNIT_WIDTH_MM, 0);
  const hourCount = day.grid.hours.length;

  return <article className={`${styles.sheet} ${styles.gridSheet}`} data-print-sheet>
    <header className={styles.gridHeader}>
      <div>
        <div className={styles.gridEyebrow}>BeGifted · Daily classrooms · ALL ROOMS</div>
        <h1 className={styles.gridDateHeading}>{dateLabel(day.date)}</h1>
        <div className={styles.gridSummaryLine}>{day.grid.daySummaryLine}</div>
        {pageIndex === 0 && day.grid.cancelledCount > 0 && <div className={styles.gridCancelledNote}>{day.grid.cancelledCount} cancelled in Wise not shown</div>}
      </div>
      <div className={styles.gridHeaderRight}>
        <div className={styles.gridPageInfo}>Page {pageIndex + 1} of {pageCount}</div>
        <div className={styles.gridRangeLabel}>{pageRangeLabel(day, page)}</div>
      </div>
    </header>
    <div className={styles.gridWrap}>
      {columnsWidthMm > 0 && <div className={styles.gridLines} style={{ top: `${COLUMN_HEAD_HEIGHT_MM}mm`, left: `${GRID_RAIL_WIDTH_MM}mm`, width: `${columnsWidthMm}mm`, height: `${bodyHeightMm}mm` }}>
        {Array.from({ length: hourCount + 1 }, (_, i) => <div key={i} className={styles.gridLine} style={{ top: `${i * GRID_HOUR_HEIGHT_MM}mm` }} />)}
      </div>}
      <div className={styles.gridFlow}>
        <GridRail day={day} bodyHeightMm={bodyHeightMm} roomCount={roomCount} />
        {page.columns.map(col => <GridColumn key={col.key} col={col} boundsStart={day.grid.bounds.startMinute} bodyHeightMm={bodyHeightMm} />)}
      </div>
      {page.hasSummaryPanel && <SummaryPanel day={day} roomCount={roomCount} />}
    </div>
    <footer className={styles.footer}>
      <span>BeGifted Education · All times Bangkok<br />Generated {formatBangkokDateTime(generatedAt)}<br />Rosters checked {formatBangkokDateTime(rosterCheckedAt)}</span>
      <span>{day.date} · Revision {day.revision}<br />Page {pageIndex + 1} of {pageCount} · Check the date before use</span>
    </footer>
  </article>;
}
