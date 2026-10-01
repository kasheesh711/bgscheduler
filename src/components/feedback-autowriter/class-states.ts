import type { Tone } from "./atoms";

/** How a class's state in the autowriter's ledger (`feedback_autowriter_sessions.state`) reads on the page. */
export const STATE_LABEL: Record<string, string> = {
  verified: "Posted",
  awaiting_event: "Posted · confirming",
  posting: "Posting",
  would_submit: "Shadow draft",
  held: "Held",
  skipped_human: "Tutor wrote it",
  skipped_scope: "Out of scope",
  expired: "Expired",
  rejected: "Rejected",
  unknown_outcome: "Unknown outcome",
  verify_failed: "Verify failed",
  pending: "Waiting",
  generating: "Writing",
  awaiting_recording: "Waiting for the recording",
  transcribing: "Transcribing",
};

/** The colour of a state's tag; a state not listed is neutral. */
export const STATE_TONE: Record<string, Tone> = {
  verified: "green",
  awaiting_event: "green",
  posting: "blue",
  would_submit: "blue",
  held: "amber",
  expired: "amber",
  rejected: "red",
  unknown_outcome: "red",
  verify_failed: "red",
};

/** States of a class whose text is, or may be, in Wise. */
export const POSTED_STATES: ReadonlySet<string> = new Set(["verified", "awaiting_event", "posting"]);

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}
