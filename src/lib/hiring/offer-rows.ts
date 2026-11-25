import { localDate, type Subject } from "./model";
import type { OfferType } from "./offer-letters";

export type OfferRow = {
  candidateId: string;
  decisionId: string;
  outboxKey?: string | null;
  name: string;
  subject: Subject | null;
  emailStatus: "pending" | "processing" | "sent" | "failed" | "uncertain" | "cancelled" | null;
  sentAt: string | null;
  offerType: OfferType | null;
  booking: { start: string; end: string } | null;
  uploadedAt: string | null;
  submittedAt: string | null;
  unknown: Partial<Record<"email" | "offerType" | "booking" | "pdf" | "form", boolean>>;
};

export function offerAge(sentAt: string | null, now: Date) {
  if (!sentAt) return null;
  return Math.max(0, (Date.parse(localDate(now)) - Date.parse(localDate(new Date(sentAt)))) / 86_400_000);
}

export function offerNext(offer: OfferRow, now: Date) {
  const today = offer.booking && localDate(new Date(offer.booking.start)) === localDate(now);
  const unknown = { state: "unknown", label: "Check offer details", action: "refresh", rank: 7 } as const;
  if (offer.uploadedAt && offer.submittedAt) return { state: "done", label: "Onboarding", action: "onboarding", rank: 9 } as const;
  if (offer.uploadedAt && offer.unknown.form) return unknown;
  if (offer.uploadedAt) return { state: "awaitForm", label: "Await form", action: null, rank: 8 } as const;
  if (!offer.emailStatus && !offer.unknown.email) return { state: "notQueued", label: "Ask Kevin", action: null, rank: 7 } as const;
  if (offer.booking && Date.parse(offer.booking.end) <= now.getTime()) {
    const rank = today ? 0 : 3;
    return offer.unknown.pdf ? { ...unknown, rank } : { state: "visitEnded", label: "Upload signed PDF", action: "upload", rank } as const;
  }
  if (offer.booking && today) return { state: "today", label: "Print contract", action: "print", rank: 0 } as const;
  if (offer.emailStatus === "sent" && !offer.booking && !offer.unknown.booking && (offerAge(offer.sentAt, now) ?? 0) >= 3) {
    return { state: "chase", label: "Chase booking", action: null, rank: 1 } as const;
  }
  if (offer.emailStatus === "failed" || offer.emailStatus === "cancelled") {
    return { state: "failed", label: "Check failed email", action: null, rank: 2 } as const;
  }
  if (offer.emailStatus === "uncertain") return { state: "uncertain", label: "Ask Kevin to confirm", action: null, rank: 2 } as const;
  if (offer.booking) return { state: "booked", label: "Print contract", action: "print", rank: 4 } as const;
  if (offer.unknown.booking || offer.unknown.email) return unknown;
  if (offer.emailStatus === "sent") return { state: "awaitBooking", label: "Await booking", action: null, rank: 5 } as const;
  return { state: "queued", label: "Await delivery", action: null, rank: 6 } as const;
}
