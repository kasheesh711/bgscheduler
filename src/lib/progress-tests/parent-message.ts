// Progress Tests — bilingual (English + Thai) parent outreach message.
//
// DRAFT WORDING — the EN/TH lines below are placeholders to be replaced with the
// team's final copy before going live (see the plan's "Open input"). The builder
// fills per-row values and concatenates EN then TH for one-click copy into the
// parent's LINE chat.

import { PROGRESS_TEST_THRESHOLD } from "./config";
import type { RecommendedTestSlot } from "./types";

/** Inputs for the per-row parent message. */
export interface ParentMessageInput {
  studentName: string;
  /** Position within the current cycle (e.g. 6 of 8). */
  count: number;
  subject: string;
  slots: RecommendedTestSlot[];
}

/** Renders the recommended after-class slots as a shared bullet block (or a dash). */
function slotsBlock(slots: RecommendedTestSlot[]): string {
  if (slots.length === 0) return "—";
  return slots.map((slot) => `• ${slot.label}`).join("\n");
}

/**
 * Builds the bilingual parent outreach message (English, then Thai) for one-click
 * copy. Embeds the student name, cycle position, subject, and the recommended
 * after-class slots, then lists the three options (after class / at home / parent
 * picks a time). DRAFT copy — replace EN/TH templates with the team's wording.
 *
 * @returns the combined "EN\n\nTH" message string.
 */
export function buildParentMessage(input: ParentMessageInput): string {
  const subject = input.subject || "their class";
  const slots = slotsBlock(input.slots);

  const en = [
    `Hello — ${input.studentName} has completed ${input.count} of ${PROGRESS_TEST_THRESHOLD} classes in ${subject} and is due for a progress test. Here are some options:`,
    `1) Right after class:`,
    slots,
    `2) At home — we'll send the test, no booking needed.`,
    `3) A time that suits you — just reply with a preferred time and we'll arrange it.`,
    `Please let us know which option you'd prefer. Thank you!`,
  ].join("\n");

  const th = [
    `สวัสดีค่ะ น้อง ${input.studentName} เรียนครบ ${input.count} จาก ${PROGRESS_TEST_THRESHOLD} คาบในวิชา ${subject} แล้ว และถึงกำหนดสอบวัดผล (progress test) ค่ะ มีตัวเลือกดังนี้ค่ะ`,
    `1) สอบต่อหลังเลิกเรียน:`,
    slots,
    `2) สอบที่บ้าน — ทางเราจะส่งข้อสอบให้ ไม่ต้องจองเวลาค่ะ`,
    `3) เลือกเวลาที่สะดวก — แจ้งเวลาที่สะดวกได้เลยค่ะ เดี๋ยวทางเราจัดให้`,
    `รบกวนแจ้งตัวเลือกที่สะดวกด้วยนะคะ ขอบคุณค่ะ`,
  ].join("\n");

  return `${en}\n\n${th}`;
}
