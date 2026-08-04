// ----------------------------------------------------------------------------
// LINE @-mention parsing.
//
// A group message that mentions the Official Account carries a `mention` object
// on the text message:
//
//   message.mention.mentionees[] = { index, length, type: "user"|"all",
//                                    userId?, isSelf? }
//
// `isSelf: true` is LINE's native "this mention targets the bot that received
// the webhook" signal — it is the gate the group command router uses, so no
// regex over the OA's display name is needed (and a renamed OA cannot break it).
//
// Important operational caveat: LINE only populates `mention` when the sender
// picks the OA from the @ picker. Typing the literal characters "@BeGifted"
// produces no mention object at all, so the bot correctly ignores it.
// ----------------------------------------------------------------------------

/** One entry of `message.mention.mentionees`, as LINE sends it. */
export interface LineMentionee {
  index?: number;
  length?: number;
  type?: string;
  userId?: string;
  isSelf?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Reads `message.mention.mentionees` off a raw LINE message object.
 * Returns [] for any shape that is not the documented array — a malformed
 * payload must read as "no mention", never as a mention of the bot.
 */
export function readMentionees(message: unknown): LineMentionee[] {
  const mention = asRecord(asRecord(message).mention);
  const raw = mention.mentionees;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is LineMentionee =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

/**
 * True when the receiving bot was explicitly @-mentioned.
 *
 * Deliberately strict: only `type === "user"` with `isSelf === true` counts.
 * A `type: "all"` mention (@everyone) is NOT treated as addressing the bot —
 * otherwise any group-wide announcement would trigger a command.
 */
export function mentionsSelf(mentionees: readonly LineMentionee[]): boolean {
  return mentionees.some((mentionee) =>
    mentionee.isSelf === true && (mentionee.type ?? "user") === "user");
}

/**
 * Removes every mention substring from the message text, leaving the command.
 *
 * `index`/`length` are UTF-16 code-unit offsets into the original text, which is
 * exactly how JavaScript indexes strings — so Thai text and emoji in a display
 * name slice correctly. Ranges are removed in DESCENDING index order so that
 * removing a later mention cannot shift the offsets of an earlier one.
 *
 * Entries with a non-finite or out-of-range index/length are skipped rather
 * than guessed at, so a malformed payload degrades to "strip less", never to a
 * corrupted command string.
 */
export function stripMentions(
  text: string,
  mentionees: readonly LineMentionee[],
): string {
  const ranges = mentionees
    .map((mentionee) => ({
      start: mentionee.index ?? Number.NaN,
      end: (mentionee.index ?? Number.NaN) + (mentionee.length ?? Number.NaN),
    }))
    .filter((range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end <= text.length &&
      range.end > range.start)
    .sort((a, b) => b.start - a.start);

  let result = text;
  for (const range of ranges) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  // Mentions leave double spaces behind once removed from mid-sentence.
  return result.replace(/\s+/g, " ").trim();
}
