// ----------------------------------------------------------------------------
// Icon + Thai label for a session's modality on the parent-facing surfaces.
//
// Follows the repo's modality convention (src/components/compare/
// modality-display.ts): an icon and a word, never a colour or a border style —
// colour on these surfaces belongs to the subject. One deliberate divergence:
// "unknown" returns null instead of a question-mark icon. A parent document
// should stay silent about something it cannot explain rather than show a
// shrug next to their child's class.
// ----------------------------------------------------------------------------

import { MapPinIcon, VideoIcon } from "lucide-react";

import { PUBLIC_PAGE_COPY } from "@/lib/line/schedule-bot-copy";
import type { StudentScheduleModality } from "@/lib/student-schedule/types";

export interface ModalityDisplay {
  Icon: typeof VideoIcon;
  label: string;
}

/** Null for "unknown" — callers render nothing at all. */
export function modalityDisplay(
  modality: StudentScheduleModality,
): ModalityDisplay | null {
  if (modality === "online") {
    return { Icon: VideoIcon, label: PUBLIC_PAGE_COPY.modalityOnline };
  }
  if (modality === "onsite") {
    return { Icon: MapPinIcon, label: PUBLIC_PAGE_COPY.modalityOnsite };
  }
  return null;
}
