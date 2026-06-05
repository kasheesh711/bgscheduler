// Progress Tests — bilingual (Thai + English) parent outreach message.
//
// Thai is placed first because the recipients are Thai-speaking parents. The
// builder fills per-row values (student, cycle position, recommended slots) and
// concatenates TH then EN for one-click copy into the parent's LINE chat. Slot
// labels (date/time/room) are language-neutral and shared by both.

import { PROGRESS_TEST_THRESHOLD } from "./config";
import type { RecommendedTestSlot } from "./types";

/** Inputs for the per-row parent message. */
export interface ParentMessageInput {
  studentName: string;
  /** Position within the current cycle (e.g. 6 of 8). */
  count: number;
  slots: RecommendedTestSlot[];
}

/** Renders the recommended slots as an indented bullet list. */
function bullets(slots: RecommendedTestSlot[]): string {
  return slots.map((slot) => `   • ${slot.label}`).join("\n");
}

/**
 * Builds the bilingual parent outreach message (Thai, then English) for one-click
 * copy. Embeds the student, cycle position, and the room-verified after-class
 * slots, then the three options (after class / at home / a time that suits the
 * parent). Falls back gracefully when no after-class slot is free.
 *
 * @returns the combined "TH\n\nEN" message string.
 */
export function buildParentMessage(input: ParentMessageInput): string {
  const { studentName, count, slots } = input;
  const hasSlots = slots.length > 0;

  // --- Thai (primary) ---
  const thOption1 = hasSlots
    ? `1) สอบต่อหลังเลิกเรียน (มีห้องว่างรองรับแล้ว):\n${bullets(slots)}`
    : `1) สอบต่อหลังเลิกเรียน — ทางเราจะจัดหาห้องว่างและยืนยันเวลาให้ค่ะ`;
  const th = [
    `สวัสดีค่ะ คุณผู้ปกครองน้อง ${studentName}`,
    ``,
    `น้อง ${studentName} เรียนครบ ${count} จาก ${PROGRESS_TEST_THRESHOLD} คาบแล้ว ทางเราขอนัดทำ Progress Test (แบบทดสอบวัดผลความก้าวหน้า) เพื่อติดตามพัฒนาการของน้องค่ะ มีตัวเลือกให้คุณผู้ปกครองดังนี้ค่ะ`,
    ``,
    thOption1,
    ``,
    `2) ทำที่บ้าน — ทางเราจัดส่งข้อสอบให้ ไม่ต้องนัดเวลาค่ะ`,
    ``,
    `3) เลือกเวลาที่สะดวก — แจ้งวันและเวลาที่สะดวกกลับมาได้เลย เดี๋ยวทางเราจัดให้ค่ะ`,
    ``,
    `รบกวนคุณผู้ปกครองแจ้งตัวเลือกที่สะดวกกลับมาด้วยนะคะ ขอบคุณค่ะ`,
    `— ทีม BeGifted`,
  ].join("\n");

  // --- English ---
  const enOption1 = hasSlots
    ? `1) Right after a class (a room is already free):\n${bullets(slots)}`
    : `1) Right after one of their classes — we'll find a free room and confirm a time.`;
  const en = [
    `Hello! This is BeGifted, regarding ${studentName}.`,
    ``,
    `${studentName} has now completed ${count} of ${PROGRESS_TEST_THRESHOLD} classes, so it's time to schedule a Progress Test to check in on their progress. Here are a few options:`,
    ``,
    enOption1,
    ``,
    `2) At home — we'll send the test over, no booking needed.`,
    ``,
    `3) A time that suits you — just reply with a preferred day and time and we'll arrange it.`,
    ``,
    `Please let us know which option works best. Thank you!`,
    `— The BeGifted Team`,
  ].join("\n");

  return `${th}\n\n${en}`;
}
