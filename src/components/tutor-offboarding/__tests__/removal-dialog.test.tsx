import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canConfirmRemoval, RemovalRunContent } from "../removal-dialog";
import { FIXTURE_NOW, partialRemovalRunFixture, removalRunFixture } from "./fixtures";

const noop = () => undefined;
const render = (run: ReturnType<typeof removalRunFixture>, canRemove = true) => renderToStaticMarkup(<RemovalRunContent run={run} canRemove={canRemove} busy={false} uncertain={false} error={null} onApply={noop} onRefresh={noop} onReconcile={noop} now={FIXTURE_NOW} />);

describe("removal confirmation and outcomes", () => {
  it("requires a valid preview, sufficient reason, exact count and explicit consent", () => {
    const run = removalRunFixture();
    expect(canConfirmRemoval(run, "Confirmed departure", "3", true, true, FIXTURE_NOW)).toBe(true);
    expect(canConfirmRemoval(run, "short", "3", true, true, FIXTURE_NOW)).toBe(false);
    expect(canConfirmRemoval(run, "Confirmed departure", "03", true, true, FIXTURE_NOW)).toBe(false);
    expect(canConfirmRemoval(run, "Confirmed departure", "2", true, true, FIXTURE_NOW)).toBe(false);
    expect(canConfirmRemoval(run, "Confirmed departure", "3", false, true, FIXTURE_NOW)).toBe(false);
    expect(canConfirmRemoval(run, "Confirmed departure", "3", true, false, FIXTURE_NOW)).toBe(false);
    expect(canConfirmRemoval(run, "Confirmed departure", "3", true, true, new Date("2026-10-01T05:15:01Z"))).toBe(false);
  });

  it("makes manual mode explicit and lists each account before confirmation", () => {
    const html = render(removalRunFixture());
    expect(html).toContain("Manual mode");
    expect(html).toContain("This saves a checklist");
    expect(html).toContain("Save manual checklist");
    expect(html).toContain("aria@example.com");
    expect(html).toContain("bodhi.online@example.com");
    expect(html).toContain("Reason for removal");
    expect(html).toContain("Type 3 to confirm");
    expect(html).toContain("I have reviewed every account");
  });

  it("accepts 500 reason characters and rejects 501 to match the API", () => {
    const run = removalRunFixture();
    expect(canConfirmRemoval(run, "a".repeat(500), "3", true, true, FIXTURE_NOW)).toBe(true);
    expect(canConfirmRemoval(run, "a".repeat(501), "3", true, true, FIXTURE_NOW)).toBe(false);
    expect(render(run)).toContain('maxLength="500"');
  });

  it("describes completed accounts as part of the recorded plan", () => {
    const html = render(removalRunFixture("live", "applied"));
    expect(html).toContain("3 Wise accounts in this plan");
    expect(html).not.toContain("3 Wise accounts to remove");
  });

  it("labels live removal and blocks confirmation if the preview has expired", () => {
    expect(render(removalRunFixture("live"))).toContain("Remove accounts from Wise");
    const run = removalRunFixture();
    run.previewExpiresAt = "2026-10-01T04:59:00Z";
    const html = render(run);
    expect(html).toContain("This preview has expired");
    expect(html).not.toContain("Save manual checklist");
  });

  it("shows partial outcomes truthfully and offers readback without another removal", () => {
    const html = render(partialRemovalRunFixture());
    expect(html).toContain("Some accounts still need attention");
    expect(html).toContain("Removal verified");
    expect(html).toContain("Outcome unknown");
    expect(html).toContain("Still in Wise");
    expect(html).toContain("Check Wise status");
    expect(html).toContain("Checking status never sends another removal");
    expect(html).not.toContain("Remove accounts from Wise");
  });
});

it("keeps saved status refresh available but requires a grant for live Wise reconciliation", () => {
  const html = render(partialRemovalRunFixture(), false);
  expect(html).toContain("Refresh run status");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Check Wise status<\/button>/);
  expect(html).toContain("The owner must allow you to check live Wise status");
});

it("never offers confirmation again while an outcome is uncertain", () => {
  const html = renderToStaticMarkup(<RemovalRunContent run={removalRunFixture("live")} canRemove busy={false} uncertain error="Request timed out" onApply={noop} onRefresh={noop} onReconcile={noop} now={FIXTURE_NOW} />);
  expect(html).toContain("Refresh run status");
  expect(html).not.toContain("Remove accounts from Wise");
  expect(html).toContain("Request timed out");
});

it("shows a fully skipped plan with no confirmation controls", () => {
  const run = removalRunFixture();
  run.accountCount = 0;
  run.accounts = run.accounts.map((account) => ({ ...account, plan: "skip", status: "skipped", skipReason: "A new upcoming class blocks this person" }));
  const html = render(run);
  expect(html).toContain("Every account was skipped");
  expect(html).toContain("A new upcoming class blocks this person");
  expect(html).not.toContain("Save manual checklist");
});

it("offers read-only Wise checking for rejected requests", () => {
  const run = partialRemovalRunFixture();
  run.accounts = run.accounts.map((account) => ({ ...account, status: "rejected" }));
  expect(render(run)).toContain("Check Wise status");
});
