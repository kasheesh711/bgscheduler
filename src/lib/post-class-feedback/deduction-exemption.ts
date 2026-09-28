import { POST_CLASS_FEEDBACK_FIELDS } from "./types";
import type { SessionDeductionExemption, SessionEligibilityInput } from "./types";

const ABSENT = "(?:absent|absence|absense|abcent|abesent)";
const STUDENT = "(?:(?:the\\s+)?(?:student|pupil|learner|child)|he|she|they)";
/**
 * After a status label a hyphen is a separator ("Absent - left early",
 * "Absent-sick", "Absent-out of town", "Cancelled-parent request"; `normalize`
 * folds the usually unspaced en/em dashes to "-") unless it forms that label's
 * known lesson-prose compound: "absent-minded(ness/ly)" or "cancelled-out".
 * Each label excludes only its own compound, so "Absent-out sick" still counts.
 */
const ABSENT_SEPARATOR = "(?:\\s*[:;(]|\\s*-(?!minded))";
const CANCEL_SEPARATOR = "(?:\\s*[:;(]|\\s*-(?!out\\b))";
const STATUS_END = `(?:$|${ABSENT_SEPARATOR}|\\s+(?:student\\b|today\\b|this\\b|due\\b|because\\b|from (?:the )?(?:class|session|lesson)\\b))`;
const ABSENT_LABEL = new RegExp(`^(?:${STUDENT}\\s+(?:(?:is|was|are|were)\\s+)?)?${ABSENT}${STATUS_END}`, "u");
const NO_SHOW_LABEL = /^(?:(?:(?:the\s+)?(?:student|pupil|learner|child)|he|she|they)\s+(?:(?:is|was|a)\s+)*)?(?:no[\s-]*show\b|(?:did\s+not|didn't)\s+show\s+up\b|(?:did\s+not|didn't)\s+(?:attend|join)(?:$|\s+(?:(?:the|this)\s+)?(?:class|session|lesson|link|zoom|today)\b))/u;
const CANCEL_LABEL = new RegExp(
  `^(?:(?:last[ -]minute|late)\\s+)?(?:cancelled|canceled|cancellation)(?:$|${CANCEL_SEPARATOR}|\\s+(?:by\\b|today\\b|last\\b|on\\b|due\\b|because\\b|class\\b|session\\b|lesson\\b))`,
  "u",
);
const CLASS_CANCELLED = /^(?:the\s+)?(?:class|session|lesson)\s+(?:(?:is|was|has been|had been)\s+)?(?:cancelled|canceled)\b/u;
const OTHER_TIME = /\b(?:(?:last|previous|next)\s+(?:week|class|session|lesson|month|time)|yesterday|tomorrow|upcoming|from school|at school)\b/u;
/**
 * First-person pronoun and teacher subjects report the tutor's own leave ("I
 * took sick leave", "My teacher took sick leave", "Kru Ann took sick leave"),
 * never the student's absence. A possessive is not a pronoun subject: "My
 * student took sick leave" is still the student. The teacher word may be any
 * of the first three subject words.
 */
const NOT_TUTOR_SUBJECT = "(?!(?:i|we|me|us)\\b)(?!(?:[a-z][a-z'-]*\\s+){0,2}(?:(?:teacher|tutor|instructor|kru)\\b|ครู))";
const MEDICAL_LEAVE = new RegExp(
  `^(?:(?:the\\s+)?student|he|she|${NOT_TUTOR_SUBJECT}[a-z][a-z'-]*(?:\\s+[a-z][a-z'-]*){0,2})\\s+(?:take|takes|took|is on|was on)\\s+(?:medical|sick)\\s+leave(?:$|\\s+(?:today|due|because)\\b)`,
  "u",
);
const FORGOT_CLASS = /^(?:(?:the\s+)?student\s+)?forgot\s+(?:about\s+(?:the\s+)?(?:class|session|lesson)|(?:he|she|they)\s+had\s+(?:a\s+)?(?:class|session|lesson)\b.{0,100}\bmissed\s+it)(?:$|\s*[-:;(])/u;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[’‘]/gu, "'").replace(/[‐‑–—]/gu, "-").replace(/\s+/gu, " ").trim();
}

/** Explicit attendance labels, not substring search over ordinary lesson prose. */
export function feedbackAttendanceExemption(value: string): "missed_or_no_show" | "cancelled" | null {
  for (const sentence of value.split(/\r?\n|[.!?](?:\s|$)/u)) {
    const text = normalize(sentence).replace(/^[\s*•-]+/u, "");
    if (!text || OTHER_TIME.test(text) || /^(?:the\s+)?(?:teacher|tutor|instructor)\b/u.test(text)) continue;
    if (/(?:เมื่อวาน|ครั้งที่แล้ว|สัปดาห์ก่อน|พรุ่งนี้|ครั้งหน้า|สัปดาห์หน้า)/u.test(text)) continue;
    if (/\b(?:not|isn't|wasn't|weren't|aren't)\s+(?:absent|cancelled|canceled|a no[ -]?show)\b/u.test(text)) continue;
    if (ABSENT_LABEL.test(text) || NO_SHOW_LABEL.test(text) || MEDICAL_LEAVE.test(text) || FORGOT_CLASS.test(text)
      || /^(?:(?:นักเรียน|น้อง|เด็ก)(?:คนนี้)?\s*ลา(?:เรียน|คลาส|คาบ|ป่วย)?|ลา(?:เรียน|คลาส|คาบ|ป่วย))(?:\s|$|ครับ|ค่ะ|คะ|วันนี้|เนื่องจาก|เพราะ)/u.test(text)
      || /^(?:(?:นักเรียน|น้อง|เด็ก)(?:คนนี้)?\s*)?(?:ขาดเรียน|ไม่มา(?:เข้า)?เรียน|ไม่เข้าเรียน|ไม่เข้าคลาส)(?:\s|$|ครับ|ค่ะ|คะ|วันนี้|เนื่องจาก|เพราะ)/u.test(text)) {
      return "missed_or_no_show";
    }
    if (CANCEL_LABEL.test(text) || CLASS_CANCELLED.test(text)
      || /^action resolution\s*:\s*(?:cancelled|canceled)\b/u.test(text)
      || /^(?:ยกเลิก(?:คลาส|เรียน|คาบ|ชั่วโมงเรียน|กะทันหัน)|(?:คลาส|คาบเรียน|ชั่วโมงเรียน)(?:ถูก)?ยกเลิก|ยกเลิก$)/u.test(text)) {
      return "cancelled";
    }
  }
  return null;
}

export function postClassDeductionExemption(input: Pick<SessionEligibilityInput,
  "canonicalTutorKey" | "className" | "subject" | "classType" | "sessionType" | "feedbackFields"
>): SessionDeductionExemption | null {
  if (input.canonicalTutorKey?.trim().toLocaleLowerCase("en-US") === "gift") {
    const consultation = [input.classType, input.sessionType, input.className, input.subject]
      .find(value => value && /^consult(?:ation)?s?(?:\b|[_-])/u.test(normalize(value)));
    if (consultation) return {
      reason: "non_teaching_consultation", source: "class_type", field: null, evidence: consultation,
    };
  }
  for (const fields of input.feedbackFields ?? []) {
    for (const field of POST_CLASS_FEEDBACK_FIELDS) {
      const text = fields[field];
      if (!text) continue;
      const reason = feedbackAttendanceExemption(text);
      if (reason) return { reason, source: "feedback", field, evidence: text.slice(0, 500) };
    }
  }
  return null;
}
