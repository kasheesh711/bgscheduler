/** Keep each transport chunk below 64KiB, including four-byte Unicode characters. */
const CHUNK_CODE_UNITS = 16_384;

/** Native Response streams avoid buffering a large report into the platform response envelope. */
export function streamTextResponse(text: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) {
        text = "";
        controller.close();
        return;
      }
      let end = Math.min(offset + CHUNK_CODE_UNITS, text.length);
      // Encode a supplementary character together rather than replacing a split surrogate.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      controller.enqueue(encoder.encode(text.slice(offset, end)));
      offset = end;
    },
    cancel() { text = ""; },
  });
  const headers = new Headers(init?.headers);
  headers.delete("Content-Length");
  return new Response(body, { ...init, headers });
}

/** Serialize before returning so a serialization failure keeps the route's typed error status. */
export function streamJsonResponse(value: unknown, init?: ResponseInit): Response {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("The report cannot be serialized as JSON.");
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return streamTextResponse(text, { ...init, headers });
}
