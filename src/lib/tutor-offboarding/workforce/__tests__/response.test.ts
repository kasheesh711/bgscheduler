import { describe, expect, it } from "vitest";
import { streamJsonResponse, streamTextResponse } from "../response";

async function chunks(response: Response): Promise<Uint8Array[]> {
  const reader = response.body!.getReader();
  const result: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return result;
    result.push(next.value);
  }
}

describe("lossless workforce response streaming", () => {
  it("streams a report above 4.5MB in bounded chunks and preserves its final evidence", async () => {
    const value = { rows: Array.from({ length: 6000 }, (_, key) => ({ key, reasons: "x".repeat(1000) })), tail: { value: null, reason: "UNKNOWN", label: "ไทย🧑‍🏫" } };
    const response = streamJsonResponse(value);
    const parts = await chunks(response);
    expect(parts.reduce((n, part) => n + part.byteLength, 0)).toBeGreaterThan(4_500_000);
    expect(parts.length).toBeGreaterThan(100);
    expect(Math.max(...parts.map(part => part.byteLength))).toBeLessThanOrEqual(65536);
    const rebuilt = await new Response(new Blob(parts as BlobPart[])).json();
    expect(rebuilt).toEqual(value);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("preserves CSV BOM, CRLF, headers and a surrogate pair at a chunk boundary", async () => {
    const text = "\uFEFF" + "x".repeat(16382) + "🧑" + ',"ไทย"\r\n';
    const response = streamTextResponse(text, { status: 201, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="report.csv"', "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
    const parts = await chunks(response);
    const actual = Buffer.concat(parts);
    expect(actual).toEqual(Buffer.from(text));
    expect(actual.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-disposition")).toContain("report.csv");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("fails serialization before returning success and allows cancellation", async () => {
    const circular: { self?: unknown } = {}; circular.self = circular;
    expect(() => streamJsonResponse(circular)).toThrow(TypeError);
    expect(() => streamJsonResponse(undefined)).toThrow(TypeError);
    const reader = streamTextResponse("x".repeat(1_000_000)).body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeLessThanOrEqual(65536);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
    expect(await streamTextResponse("").text()).toBe("");
  });
});
