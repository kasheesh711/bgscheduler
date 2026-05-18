import { describe, expect, it } from "vitest";
import { GET } from "../floor-plan-map/route";

describe("floor plan map route", () => {
  it("returns public SVG with selected rooms from the query string", async () => {
    const response = await GET(new Request("http://test.local/api/classrooms/floor-plan-map?rooms=Focus%7CGo%20All%20In"));
    const text = await response.text();

    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(text).toContain('aria-label="BeGifted floor plan"');
    expect(text).toContain(">1</text>");
    expect(text).toContain(">2</text>");
  });
});
