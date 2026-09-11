import type { ClassroomPrintReport, ClassroomPrintView } from "@/lib/classrooms/print-report";

export type PrintDay = ClassroomPrintReport["days"][number];
export type PrintBlock = PrintDay["rooms"][number]["blocks"][number] & { studentOffset: number; continued: boolean };
export interface PrintCard {
  id: string;
  kind: "tutor" | "room" | "exceptions";
  title: string;
  subtitle: string;
  blocks: PrintBlock[];
  continued: boolean;
}
export interface PrintPage { day: PrintDay; columns: PrintCard[][]; fullWidth: boolean }

export function buildPrintCards(report: ClassroomPrintReport, view: ClassroomPrintView) {
  const blocks = (rows: PrintDay["exceptions"]): PrintBlock[] => rows.map(row => ({ ...row, studentOffset: 0, continued: false }));
  return report.days.map(day => {
    const cards: PrintCard[] = view === "tutors"
      ? day.tutors.map(tutor => ({ id: `${day.runId}:tutor:${tutor.canonicalKey}`, kind: "tutor", title: tutor.tutorDisplayName,
        subtitle: `Usual rooms: ${tutor.usualRooms.map(room => `${room}${tutor.unavailableRooms.includes(room) ? " (unavailable)" : ""}`).join(" · ") || "Not yet established"}`,
        blocks: blocks(tutor.blocks), continued: false }))
      : day.rooms.map(room => ({ id: `${day.runId}:room:${room.id}`, kind: "room", title: room.name,
        subtitle: `Room schedule · ${room.capacity} places`, blocks: blocks(room.blocks), continued: false }));
    const exceptions = view === "rooms" ? day.roomExceptions : day.exceptions;
    if (exceptions.length) cards.push({ id: `${day.runId}:exceptions`, kind: "exceptions", title: "Schedule exceptions",
      subtitle: "Check these classes with the team and regenerate assignments where indicated.", blocks: blocks(exceptions), continued: false });
    return { day, cards };
  });
}

/** Split large rosters across pages without losing a student or reducing the font size. */
export function splitPrintCard(card: PrintCard, measure: (card: PrintCard) => number, limit: number) {
  const chunks: Array<{ card: PrintCard; height: number }> = [];
  let current: PrintBlock[] = [];
  const candidate = (blocks: PrintBlock[]): PrintCard => ({ ...card, continued: chunks.length > 0, blocks });
  function flush() {
    const part = candidate(current);
    chunks.push({ card: part, height: measure(part) });
    current = [];
  }
  if (!card.blocks.length) return [{ card, height: measure(card) }];
  for (const block of card.blocks) {
    let offset = 0;
    while (true) {
      const piece = (count: number): PrintBlock => ({ ...block, students: block.students.slice(offset, offset + count), studentOffset: offset, continued: offset > 0 });
      const remaining = block.students.length - offset;
      if (measure(candidate([...current, piece(remaining)])) <= limit) { current.push(piece(remaining)); break; }
      if (current.length) { flush(); continue; }
      let low = 1, high = remaining, fit = 0;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        if (measure(candidate([piece(count)])) <= limit) { fit = count; low = count + 1; }
        else high = count - 1;
      }
      if (!fit) throw new Error("A class cannot fit safely on the page. Please ask the team to review the print layout.");
      current.push(piece(fit)); flush(); offset += fit;
      if (offset >= block.students.length) break;
    }
  }
  if (current.length) flush();
  return chunks;
}

export function paginatePrintCards(days: ReturnType<typeof buildPrintCards>, measure: (card: PrintCard) => number, limit: number): PrintPage[] {
  const pages: PrintPage[] = [];
  for (const { day, cards } of days) {
    let page: PrintPage = { day, columns: [[], []], fullWidth: false }, column = 0, used = 0;
    for (const card of cards) {
      if (card.kind !== "tutor" && page.columns.some(items => items.length)) {
        pages.push(page); page = { day, columns: [[], []], fullWidth: false }; column = 0; used = 0;
      }
      for (const chunk of splitPrintCard(card, measure, limit)) {
        if (card.kind !== "tutor") { pages.push({ day, columns: [[chunk.card]], fullWidth: true }); continue; }
        if (used && used + chunk.height > limit) {
          if (column === 0) column = 1;
          else { pages.push(page); page = { day, columns: [[], []], fullWidth: false }; column = 0; }
          used = 0;
        }
        page.columns[column].push(chunk.card); used += chunk.height + 10;
      }
    }
    if (page.columns.some(items => items.length) || !cards.length) pages.push(page);
  }
  return pages;
}
