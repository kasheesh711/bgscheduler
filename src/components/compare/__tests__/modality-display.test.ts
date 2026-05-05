import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modalityDisplay } from "../modality-display";

function readSource(): string {
  return readFileSync(
    path.join(process.cwd(), "src/components/compare/modality-display.ts"),
    "utf8",
  );
}

describe("modalityDisplay", () => {
  it("returns resolved labels for high confidence modalities", () => {
    expect(modalityDisplay("online", "high").label).toBe("Online");
    expect(modalityDisplay("onsite", "high").label).toBe("Onsite");
  });

  it("returns unconfirmed or unknown labels for low confidence modalities", () => {
    expect(modalityDisplay("online", "low").label).toBe("Likely online — unconfirmed");
    expect(modalityDisplay("unknown", "low").label).toBe("Unknown");
  });

  it("keeps medium confidence on the intentional high-confidence display branch", () => {
    expect(modalityDisplay("online", "medium").label).toBe("Online");
    expect(modalityDisplay("onsite", "medium").label).toBe("Onsite");
  });

  it("documents the medium confidence fallback without an open TODO", () => {
    const source = readSource();

    expect(source).toContain("Medium confidence is type-reserved by Phase 6");
    expect(source).not.toMatch(/TODO|future phase/);
  });
});
