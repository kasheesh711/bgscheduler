/** The standard offer letters, one for each contract type. HR selects one; nobody types offer terms (Kevin, 23 Nov 2026). */
const letter = (role: string, terms: string) => (name: string, subject: string) => `Dear ${name},

We are pleased to offer you the position of ${role} ${subject} tutor at BeGifted Education.

${terms}

Read the contract at your signing appointment. Ask HR your questions before you sign.

We look forward to working with you.

BeGifted Education`;

export const OFFER_LETTERS = {
  part_time: {
    label: "Part-time tutor",
    text: letter("part-time", "As a part-time tutor, you teach the classes that we assign to you in the hours that you make available. We pay you for each hour that you teach. Your contract shows your hourly rate and the full terms."),
  },
  full_time: {
    label: "Full-time tutor",
    text: letter("full-time", "As a full-time tutor, you work at BeGifted on a regular weekly schedule. We pay you a monthly salary. Your contract shows your salary, your working hours and the full terms."),
  },
  specialist: {
    label: "Specialist tutor",
    text: letter("specialist", "As a specialist tutor, you teach your specialist subject to particular students when we offer you an assignment and you accept it. We pay you for each hour that you teach. Your contract shows your hourly rate and the full terms."),
  },
} as const;

export type OfferType = keyof typeof OFFER_LETTERS;
export const OFFER_TYPES = Object.keys(OFFER_LETTERS) as [OfferType, ...OfferType[]];
