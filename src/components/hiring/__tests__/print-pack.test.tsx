import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFile } from "../print-pack";

async function pdf(labels: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of labels) doc.addPage([200, 200]).drawText(label, { x: 10, y: 10, size: 12, font });
  return doc.save();
}
const pagesOf = async (bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => page.getSize().width + page.getSize().height);
};

afterEach(() => vi.unstubAllGlobals());

describe("buildFile", () => {
  it("puts each cover before its candidate's paper, and a cover alone when there is no paper", async () => {
    const covers = await PDFDocument.create();
    // Each cover has its own size here, so the order is visible in the result.
    for (const size of [301, 302, 303]) covers.addPage([size, 1]);
    const files: Record<string, Uint8Array> = { covers: await covers.save(), econ: await pdf(["e1", "e2"]), chem: await pdf(["c1"]) };
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (path: string) => {
      fetched.push(path);
      const body = files[path.endsWith("/covers") ? "covers" : path.split("/").pop()!];
      return new Response(new Uint8Array(body), { status: 200, headers: path.endsWith("/covers") ? { "X-Print-Order": "a,b,c" } : {} });
    });
    const out = await buildFile("t", [
      { key: "a", name: "A", subject: "Economics", time: "09:00", fileId: "econ" },
      { key: "b", name: "B", subject: "Thai", time: "10:00", fileId: null },
      { key: "c", name: "C", subject: "Economics", time: "11:00", fileId: "econ" },
    ]);
    expect(await pagesOf(out)).toEqual([302, 400, 400, 303, 304, 400, 400]);
    // The shared paper is downloaded once.
    expect(fetched.filter((p) => p.includes("/paper/"))).toEqual(["/api/hiring/print/t/paper/econ"]);
  });
  it("stops when the covers are not the page's list, by count or by order", async () => {
    const covers = await PDFDocument.create();
    covers.addPage([300, 1]);
    covers.addPage([300, 1]);
    const bytes = await covers.save();
    const rows = [{ key: "a", name: "A", subject: "X", time: "09:00", fileId: null }, { key: "b", name: "B", subject: "X", time: "10:00", fileId: null }];
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "X-Print-Order": "b,a" } }));
    await expect(buildFile("t", rows)).rejects.toThrow(/list changed/);
    await expect(buildFile("t", rows.slice(0, 1))).rejects.toThrow(/list changed/);
  });
});
