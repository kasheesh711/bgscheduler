const BANGKOK_TIME_ZONE = "Asia/Bangkok";

export const SESSION_MUTATION_EVENTS = new Set([
  "SessionCreatedEvent",
  "SessionUpdatedEvent",
  "SessionCancelledEvent",
  "SessionDeletedEvent",
]);

const EVENT_LABELS: Record<string, string> = {
  AdminAddedToClassroomEvent: "Admin added to class",
  AdminRemovedFromClassroomEvent: "Admin removed from class",
  AttendanceCalculatedEvent: "Attendance calculated",
  ClassUpdatedEvent: "Class updated",
  InvoiceChargedEvent: "Invoice charged",
  InvoiceUpdatedEvent: "Invoice updated",
  OfflinePaymentChargedEvent: "Offline payment charged",
  ParentAddedForStudentEvent: "Parent added for student",
  RecordingCompletedEvent: "Recording completed",
  SessionCancelledEvent: "Session cancelled",
  SessionCreatedEvent: "Session created",
  SessionDeletedEvent: "Session deleted",
  SessionFeedbackSubmittedEvent: "Session feedback submitted",
  SessionUpdatedEvent: "Session updated",
  StudentSuspendedEvent: "Student suspended",
  StudentUnsuspendedEvent: "Student unsuspended",
  TeacherAddedToClassroomEvent: "Teacher added to class",
  TutorPayoutInvoiceCreatedEvent: "Tutor payout invoice created",
  UserAddedToInstituteEvent: "User added to institute",
  UserRemovedFromInstituteEvent: "User removed from institute",
  WiseReceiptTransaction: "Wise receipt transaction",
};

const TYPE_LABELS: Record<string, string> = {
  BILLING: "Billing",
  CLASSROOM: "Classroom",
  CONTENT: "Content",
  CREDIT: "Credit",
  SESSION: "Session",
  SETTING: "Settings",
  USER: "User",
  unknown: "Other",
};

export function wiseActivityEventLabel(eventName: string): string {
  if (EVENT_LABELS[eventName]) return EVENT_LABELS[eventName];
  return eventName
    .replace(/Event$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim() || "Unknown event";
}

export function wiseActivityTypeLabel(eventType: string): string {
  return TYPE_LABELS[eventType] ?? wiseActivityEventLabel(eventType);
}

export function isWiseFinanceEvent(input: {
  eventType?: string | null;
  eventName?: string | null;
  transactionId?: string | null;
}): boolean {
  const eventName = input.eventName ?? "";
  return input.eventType === "BILLING" ||
    Boolean(input.transactionId) ||
    /invoice|payment|payout|transaction/i.test(eventName);
}

export function isWiseSessionMutation(eventName: string): boolean {
  return SESSION_MUTATION_EVENTS.has(eventName);
}

export function formatBangkokDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatWiseAmount(value: number | null | undefined, currency: string | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  if (!currency) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
