import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewDetail } from "../review-detail";
import { buildVerdictRequest, downgradeFor, hasHarshJudgement, matchesFilter, measuredFixesLabel, verdictLabel } from "../review-helpers";
import { VerdictForm } from "../verdict-form";
import { APPROVED, CRITICAL, FLAG_ID, MAJOR, SESSION, correctedQueueItem, firstShot, queueItem } from "./fixtures";

// Made-up tutors and classes only (the fixtures).
const item = (patch: Parameters<typeof correctedQueueItem>[0] = {}) => correctedQueueItem(patch);
const plain = () => queueItem(SESSION.annaToReview, "Anna", "2026-10-06", "13:00");

describe("ReviewDetail", () => {
  it("shows the first shot next to the current text, the diff and the measured saves", () => {
    const html = renderToStaticMarkup(<ReviewDetail item={item()} />);
    expect(html).toContain("Needs review");
    expect(html).toContain("Changed since first post");
    expect(html).toContain("reconstructed · hash-verified");
    expect(html).toContain("the last verified correction");
    expect(html).toMatch(/<del[^>]*>all<\/del>/u);
    expect(html).toMatch(/<ins[^>]*>six of the<\/ins>/u);
    expect(html).toContain("Autowriter — correction");
    expect(html).toContain("· fix</strong>");
    expect(html).toContain("after approval — not counted");
    expect(html).toContain("Correction by script:correct-posts (owner@example.com)");
    expect(html).toContain("1 measured fix (Autowriter — correction 1)");
    expect(html).toContain("No verdict yet.");
  });

  it("says a first shot recorded at the post is unchanged, and shows its verdicts with the superseded ones struck through", () => {
    const earlier = { ...MAJOR, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", current: false, note: "first reading" };
    const html = renderToStaticMarkup(<ReviewDetail item={{ ...plain(), status: "reviewed", currentVerdict: APPROVED, verdicts: [APPROVED, earlier] }} />);
    expect(html).toContain("recorded at post · hash-verified");
    expect(html).toContain("unchanged since the first post");
    expect(html).toContain("Same as the first shot.");
    expect(html).not.toContain("first-shot-diff");
    expect(html).toContain("Reviewed");
    expect(html).toContain("Approved · owner@example.com");
    expect(html).toMatch(/line-through[^>]*>Needs fix · Major \(real fix\) · owner@example\.com · [^<]* — first reading</u);
  });

  it("labels the nickname re-post a policy change, never a fix", () => {
    const policy = item({
      current: { ...item().current, source: "policy" },
      corrections: [{ kind: "policy", actor: "script:nickname-fix (owner@example.com)", reason: "owner naming policy: nickname", outcome: "verified", at: "2026-10-05T14:26:11.000Z", provenance: "backfill" }],
      fixEvents: [
        { wiseEventId: "e1", at: "2026-10-05T11:06:45.495Z", actorKind: "autowriter_first", countsAsFix: false, counted: false },
        { wiseEventId: "e2", at: "2026-10-05T14:26:07.299Z", actorKind: "autowriter_policy", countsAsFix: false, counted: false },
      ],
      measuredFixCount: 0,
      measuredFixesByActor: {},
    });
    const html = renderToStaticMarkup(<ReviewDetail item={policy} />);
    expect(html).toContain("the owner&#x27;s policy re-post (not a fix)");
    expect(html).toContain("Autowriter — policy re-post (not a fix)");
    expect(html).toContain("Policy re-post (not a fix) by script:nickname-fix (owner@example.com)");
    expect(html).not.toContain("· fix</strong>");
    expect(html).not.toContain("Correction by");
    expect(html).not.toContain("measured fix");
  });

  it("names the first shot's writer by its arm: a Sol draft as Sol, never GLM", () => {
    const html = (arm: string) => renderToStaticMarkup(<ReviewDetail item={item({ firstShot: firstShot(SESSION.benFlagged, "2026-10-05T11:06:00.000Z", { arm, evidence: "summary" }) })} />);
    expect(html("sol")).toContain("· GPT-6.1 Sol");
    expect(html("sol")).not.toContain("GLM Flash");
    expect(html("luna")).toContain("· GPT-6 Luna");
    expect(html("glm")).toContain("· GLM Flash");
    expect(html("sol")).not.toContain("· transcript");
    expect(renderToStaticMarkup(<ReviewDetail item={plain()} />)).toContain("· GPT-6.1 Sol · transcript");
  });

  it("warns when a first shot landed in Wise without verifying", () => {
    const landed = item({ firstShot: firstShot(SESSION.benFlagged, "2026-10-05T11:06:00.000Z", { outcome: "verify_failed", problems: ["session_credit_entries_2"] }) });
    const html = renderToStaticMarkup(<ReviewDetail item={landed} />);
    expect(html).toContain("Landed but did not verify");
    expect(html).toContain("session_credit_entries_2");
    expect(renderToStaticMarkup(<ReviewDetail item={item()} />)).not.toContain("Landed but did not verify");
  });

  it("lists the open flags with their source and note", () => {
    const flagged = item({ status: "flagged", openFlags: [{ id: FLAG_ID, source: "system", note: "The read-back found two credit entries", suggestedSeverity: "critical", suggestedCategory: "billing_status", createdAt: "2026-10-06T00:00:00.000Z" }] });
    const html = renderToStaticMarkup(<ReviewDetail item={flagged} />);
    expect(html).toContain("Flagged");
    expect(html).toContain("Flag (system, suggested critical): The read-back found two credit entries");
  });
});

describe("the review helpers", () => {
  it("filters: required-unreviewed, flagged, all", () => {
    const flagged = item({ status: "flagged", openFlags: [{ id: FLAG_ID, source: "measured_fix", note: "Tutor saved", suggestedSeverity: null, suggestedCategory: null, createdAt: "2026-10-05T16:00:00.000Z" }] });
    expect(matchesFilter(item(), "required")).toBe(true);
    expect(matchesFilter(item({ currentVerdict: APPROVED }), "required")).toBe(false);
    expect(matchesFilter(item({ required: false, inclusionReason: "not_sampled" }), "required")).toBe(false);
    expect(matchesFilter(flagged, "flagged")).toBe(true);
    expect(matchesFilter(item(), "flagged")).toBe(false);
    expect(matchesFilter(item(), "all")).toBe(true);
  });

  it("labels the stored factual severity as the owner's major", () => {
    expect(verdictLabel(MAJOR)).toBe("Needs fix · Major (real fix)");
    expect(verdictLabel(CRITICAL)).toBe("Needs fix · critical · Wrong person");
    expect(verdictLabel({ ...APPROVED, downgradedFrom: "critical" })).toBe("Approved (downgraded from critical)");
    expect(verdictLabel({ ...APPROVED, verdict: "needs_fix", severity: "cosmetic", downgradedFrom: "factual" })).toBe("Needs fix · cosmetic (downgraded from major)");
  });

  it("lists measured fixes per actor, by name", () => {
    expect(measuredFixesLabel({ tutor: 1, autowriter_correction: 2, owner_web: 0 })).toBe("Autowriter — correction 2, Tutor 1");
    expect(measuredFixesLabel({ someone_new: 1 })).toBe("someone_new 1");
  });
});

describe("VerdictForm", () => {
  it("starts Needs fix with no severity chosen and cannot record until one is", () => {
    const html = renderToStaticMarkup(<VerdictForm item={item()} onRecorded={() => undefined} initialMode="needs_fix" />);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a severity…<\/option>/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record needs fix<\/button>/u);
    expect(html).toContain("Major (real fix)");
    expect(html).not.toContain("Factual (real fix)");
  });

  it("opens on Approve and Needs fix alone, and asks for a note before a harsh judgement is downgraded", () => {
    const idle = renderToStaticMarkup(<VerdictForm item={item()} onRecorded={() => undefined} />);
    expect(idle).toContain(">Approve<");
    expect(idle).toContain("Needs fix");
    expect(idle).not.toContain("Record needs fix");
    expect(idle).not.toContain("Verdict note");
    const harsh = renderToStaticMarkup(<VerdictForm item={item({ currentVerdict: CRITICAL })} onRecorded={() => undefined} />);
    expect(harsh).toContain("A milder verdict downgrades it");
    expect(harsh).toContain("Note (required for a milder verdict)");
  });

  it("reloads the class on a stale page (409) and keeps the error, and tells its caller when a verdict was recorded", () => {
    const form = fs.readFileSync(path.join(__dirname, "../verdict-form.tsx"), "utf8");
    expect(form).toContain('if (response.status === 409) await onRecorded("stale");');
    expect(form).toContain('await onRecorded("recorded");');
    expect(form).toContain('fetch("/api/feedback-autowriter/verdicts"');
    // The drawer closes only after a recorded verdict; a stale page reloads the item and stays open.
    const drawer = fs.readFileSync(path.join(__dirname, "../item-drawer.tsx"), "utf8");
    expect(drawer).toContain('if (outcome === "recorded") await done(); else await onChanged();');
  });
});

describe("buildVerdictRequest", () => {
  const form = { severity: null, category: null, note: "", downgradeConfirmed: false };

  it("never defaults a Needs fix to a severity", () => {
    expect(buildVerdictRequest(item(), "needs_fix", form)).toEqual({ ok: false, error: "Choose a severity." });
    expect(buildVerdictRequest(item(), "needs_fix", { ...form, severity: "critical" })).toEqual({ ok: false, error: "Choose the critical category." });
  });

  it("pins the verdict to what the page showed: first shot, current verdict and open flags", () => {
    const flagged = item({ currentVerdict: APPROVED, openFlags: [{ id: FLAG_ID, source: "measured_fix", note: null, suggestedSeverity: null, suggestedCategory: null, createdAt: "2026-10-06T00:00:00.000Z" }] });
    expect(buildVerdictRequest(flagged, "needs_fix", { ...form, severity: "factual", note: " real fix " })).toEqual({ ok: true, body: {
      wiseSessionId: SESSION.benFlagged, fieldsSha256: "a".repeat(64), currentVerdictId: APPROVED.id, seenFlagIds: [FLAG_ID],
      verdict: "needs_fix", severity: "factual", criticalCategory: null, note: "real fix",
    } });
    expect(buildVerdictRequest(item(), "approve", form)).toEqual({ ok: true, body: {
      wiseSessionId: SESSION.benFlagged, fieldsSha256: "a".repeat(64), currentVerdictId: null, seenFlagIds: [],
      verdict: "approve", severity: null, criticalCategory: null, note: null,
    } });
    expect(buildVerdictRequest(item(), "needs_fix", { ...form, severity: "critical", category: "invented_content", note: "made up a test score" })).toMatchObject({
      ok: true, body: { severity: "critical", criticalCategory: "invented_content", note: "made up a test score" },
    });
  });

  it("turns a milder verdict on a critical or major judgement into a confirmed downgrade with a note", () => {
    const critical = item({ currentVerdict: CRITICAL });
    const major = item({ currentVerdict: MAJOR });
    const suggested = item({ openFlags: [{ id: FLAG_ID, source: "system", note: null, suggestedSeverity: "critical", suggestedCategory: "billing_status", createdAt: "2026-10-06T00:00:00.000Z" }] });
    expect([hasHarshJudgement(critical), hasHarshJudgement(major), hasHarshJudgement(suggested), hasHarshJudgement(item())]).toEqual([true, true, true, false]);
    expect(downgradeFor(major, "needs_fix", "factual")).toBeNull();
    expect(downgradeFor(major, "needs_fix", "cosmetic")).toBe("factual");
    expect(buildVerdictRequest(critical, "approve", form)).toEqual({ ok: false, error: "A downgrade from critical needs a note saying why." });
    expect(buildVerdictRequest(critical, "approve", { ...form, note: "misclick" })).toEqual({ ok: false, error: "Confirm the downgrade from critical." });
    const request = buildVerdictRequest(critical, "approve", { ...form, note: "misclick", downgradeConfirmed: true });
    expect(request).toMatchObject({ ok: true, body: { verdict: "approve", confirmDowngrade: true, note: "misclick" } });
    // Approving a class judged major after its fix would quietly make the first shot accurate: it is a downgrade too.
    expect(buildVerdictRequest(major, "approve", form)).toEqual({ ok: false, error: "A downgrade from major needs a note saying why." });
    // Re-recording the same judgement (e.g. to answer a new flag) and critical to critical are no downgrades.
    expect(buildVerdictRequest(major, "needs_fix", { ...form, severity: "factual" })).toMatchObject({ ok: true });
    expect(buildVerdictRequest(critical, "needs_fix", { ...form, severity: "critical", category: "invented_content" })).toMatchObject({ ok: true });
  });
});
