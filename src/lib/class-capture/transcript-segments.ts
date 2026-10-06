import type { TranscriptSegment } from "./automatic-model";

/** Soniox tokens include spacing. Keep it intact and group adjacent turns for usable citations. */
export function transcriptSegments(tokens: Array<{ text: string; start_ms: number; end_ms?: number; speaker?: string }>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const token of tokens) {
    const previous = segments.at(-1);
    if (previous && previous.speaker === token.speaker && token.start_ms - (previous.endMs ?? previous.startMs) < 2500 && previous.text.length < 1600) {
      previous.text += token.text;
      previous.endMs = token.end_ms ?? token.start_ms;
    } else segments.push({ text: token.text, startMs: token.start_ms, endMs: token.end_ms, speaker: token.speaker });
  }
  return segments;
}
