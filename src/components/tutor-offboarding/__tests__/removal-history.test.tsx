import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemovalHistory } from "../removal-history";
import { partialRemovalRunFixture, removalRunFixture } from "./fixtures";

const noop = () => undefined;

describe("removal history", () => {
  it("shows manual and partial runs with actor, reason and account outcomes", () => {
    const html = renderToStaticMarkup(<RemovalHistory initialRuns={[partialRemovalRunFixture(), { ...removalRunFixture("manual", "applied"), id: "another-run" }]} onOpen={noop} />);
    expect(html).toContain("Removal history");
    expect(html).toContain("Some outcomes need attention");
    expect(html).toContain("Manual checklist");
    expect(html).toContain("owner@example.com");
    expect(html).toContain("Confirmed departure by owner");
    expect(html).toContain("Outcome unknown");
    expect(html).toContain("Remove by hand in Wise");
    expect(html).toContain("Open run");
  });

  it("keeps a failed history read visible and retryable", () => {
    const html = renderToStaticMarkup(<RemovalHistory initialRuns={[]} initialError="Removal history could not be loaded" onOpen={noop} />);
    expect(html).toContain("Removal history could not be loaded");
    expect(html).toContain("Refresh history");
    expect(html).not.toContain("No removal runs yet");
  });
});
