import { describe, expect, it } from "vitest";
import { pdfRuntimeAsset } from "../pdf-runtime";

describe("pdfRuntimeAsset", () => {
  it.each(["worker.mjs", "worker-legacy.mjs"])("serves %s as a script", async (name) => {
    const response = await pdfRuntimeAsset(name);
    expect(response?.headers.get("Content-Type")).toBe("text/javascript");
    expect((await response!.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
  it("refuses a path, an unknown type and a file that does not exist", async () => {
    expect(await pdfRuntimeAsset("../package.json")).toBeNull();
    expect(await pdfRuntimeAsset("..%2Fpackage.json")).toBeNull();
    expect(await pdfRuntimeAsset("pdf.mjs")).toBeNull();
    expect(await pdfRuntimeAsset("nothing-here.bcmap")).toBeNull();
  });
});
