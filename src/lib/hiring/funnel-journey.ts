export const milestones = [
  "SEEK",
  "Subjects",
  "Prescreen",
  "Test",
  "Human review",
  "Interview",
  "Final review",
  "Offer letter",
] as const;
export type Milestone = (typeof milestones)[number];
export type PaperReview = {
  subject: string;
  head: string | null;
  initial: number | null;
  requestedAt: string | null;
  decidedAt: string | null;
  passed: boolean | null;
  final: number | null;
};
export type HiringJourney = {
  id: string;
  name: string;
  atsScore: number | null;
  subjects: string[];
  reached: Milestone[];
  /** The recorded intake decision stays available if staff bring the person back. */
  scoreExit: { score: number | null; cutoff: number | null; held: boolean; returned: boolean } | null;
  status: string;
  waived: boolean;
  reviews: PaperReview[];
  signedAt: string | null;
};

export type JourneyFilter = {
  subject?: string;
  from?: Milestone;
  to?: Milestone;
  pending?: boolean;
  scoreExit?: "initial" | "held" | "returned";
};
export function matchesJourney(j: HiringJourney, filter: JourneyFilter) {
  if (
    filter.scoreExit &&
    (!j.scoreExit ||
      (filter.scoreExit === "held" && !j.scoreExit.held) ||
      (filter.scoreExit === "returned" && !j.scoreExit.returned))
  )
    return false;
  const reviews = j.reviews.filter((r) => !filter.subject || r.subject === filter.subject);
  if (filter.pending && !reviews.some((r) => !r.decidedAt)) return false;
  if (filter.to === "Human review" && !reviews.length) return false;
  if (filter.from === "Human review" && !reviews.some((r) => r.passed === true)) return false;
  if (filter.from === "Test" && filter.to === "Interview" && reviews.length) return false;
  return (
    (!filter.subject || j.subjects.includes(filter.subject)) &&
    (!filter.from || j.reached.includes(filter.from)) &&
    (!filter.to || j.reached.includes(filter.to)) &&
    (filter.from !== "Prescreen" || filter.to !== "Interview" || j.waived)
  );
}
