import { KEVIN_ONLINE_WISE_USER_ID } from "../../roster";
import type { EvidenceBundle, NightlyTarget } from "../types";

/** Synthetic people and lesson only: the repository is public. */
export const SID = "6a0000000000000000000a01";
export const CID = "6a00000000000000000000c1";
export const STUDENT = "Pimchanok (Pim.Ta) Testwong";

/** A sound synthetic post for the student called Pim. */
export const PIM_FIELDS = {
  topics: "Today we worked on adding and subtracting fractions with unlike denominators, finding the lowest common multiple first, and then two word problems about sharing a cake fairly between friends.",
  performance: "Pim found the lowest common multiple for most questions without help and rewrote each fraction carefully. She hesitated on the second word problem, but once we drew a bar model she set up the subtraction correctly and checked her answer.",
  improvement: "Before our next lesson, Pim should practise simplifying answers fully by dividing by the highest common factor, and draw a quick bar model whenever a word problem has more than one step. Five short questions a day will build both habits.",
  homework: "",
};

export function nightlyTarget(patch: Partial<NightlyTarget> = {}): NightlyTarget {
  return {
    wiseSessionId: SID, wiseClassId: CID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID, tutorKey: "Kevin",
    scheduledEndAt: "2026-10-02T09:30:00.000Z", deadlineAt: "2026-10-04T16:59:00.000Z", evidence: "transcript", arm: "sol",
    fields: PIM_FIELDS, fieldsSha256: "sha-1", billing: { sessionStatus: "COMPLETED", creditsConsumed: 1 },
    sonioxTranscriptionId: "prod-job", firstShotPostId: "post-1", currentVerdictId: null, verdict: null, ownerFlagOpen: false,
    humanSavedSincePost: false, guided: false, pipeline: { evidence: "transcript", promptVersion: 5 },
    studentFullName: STUDENT, studentDisplayName: "Pim", className: STUDENT, ...patch,
  };
}

export function nightlyBundle(patch: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    wiseSessionId: SID, night: "2026-10-02", grade: "rebuilt", hash: "bundle-hash-0001",
    classDetails: ["Programme: Y5-6", "Class subject: Maths"], tutorNames: ["Arthit Teacherson", "Art"],
    studentFullName: STUDENT, studentDisplayName: "Pim", studentAliases: [], postedFields: PIM_FIELDS,
    wiseCurrentFields: PIM_FIELDS, wiseTextMatchesPost: true,
    transcript: { text: "[00:00] TUTOR: Today we add fractions.\n[00:10] STUDENT: Twelve.", source: "production_soniox", speakerMethod: "zoom_alignment", speakerLabels: "verified" },
    wiseSummary: "Overview: The class added fractions.", zoomCaptions: null, postedEvidenceKind: "transcript", scheduledMinutes: 60,
    storedJudge: null, pipeline: { evidence: "transcript" }, ...patch,
  };
}
