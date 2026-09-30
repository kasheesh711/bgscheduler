import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutowriterDashboard } from "@/lib/feedback-autowriter/dashboard";
import { FeedbackAutowriterDashboard } from "../feedback-autowriter-dashboard";

function payload(overrides: Partial<AutowriterDashboard> = {}): AutowriterDashboard {
  return {
    generatedAt: "2026-09-30T05:00:00.000Z",
    windowDays: 7,
    control: { mode: "shadow", haltedAt: null, haltReason: null, disabledTutors: [], updatedBy: "kevhsh7@gmail.com", updatedAt: "2026-09-30T01:00:00.000Z" },
    totals: {
      seen: 5, posted: 2, verified: 2, awaitingEvent: 0, shadowDrafts: 1, awaitingRecording: 1, fromTranscript: 1,
      held: 1, skippedHuman: 1, skippedScope: 0, expired: 0, failed: 0, inProgress: 0,
    },
    latency: {
      medianMinutes: 2.5, p90Minutes: 4, samples: 2,
      byRoute: [
        { route: "transcript", label: "From the transcript", medianMinutes: 55, p90Minutes: 72, samples: 1 },
        { route: "summary_fallback", label: "From the summary (fallback)", medianMinutes: null, p90Minutes: null, samples: 0 },
        { route: "summary", label: "From the summary", medianMinutes: 2.5, p90Minutes: 2.5, samples: 1 },
      ],
    },
    summaryFallbacks: [],
    cost: {
      totalUsd: 0.0076,
      perDraftUsd: 0.0025,
      byModel: [{ model: "z-ai/glm-5.3-flash", role: "writer", calls: 2, costUsd: 0.0048 }],
      byDay: [{ date: "2026-09-30", costUsd: 0.0076, drafts: 3, posted: 2 }],
    },
    fallbackShare: 0.333,
    judgeRejections: 1,
    tutors: [{
      tutorKey: "Kevin", displayName: "Kevin (Kev) Y. Hsieh", wiseUserIds: ["696e2c4343579bbada2340ed", "695369c028118f629edcb986"],
      enabled: true, partlyEnabled: false,
      seen: 5, posted: 2, shadowDrafts: 1, held: 1, skippedHuman: 1, expired: 0, failed: 0, medianLatencyMinutes: 2.5, costUsd: 0.0076,
    }, {
      tutorKey: "Ek", displayName: "Apivit (Ek) Sirithana", wiseUserIds: ["6976680baf7fbc5ac88c3ea9", "695369c028118f629edcba05"],
      enabled: false, partlyEnabled: true,
      seen: 0, posted: 0, shadowDrafts: 0, held: 0, skippedHuman: 0, expired: 0, failed: 0, medianLatencyMinutes: null, costUsd: 0,
    }],
    recent: [{
      wiseSessionId: "6a9fbc9c617dfedd88a0471e",
      wiseUrl: "https://learn.begiftededucation.com/links?type=classroom_entity&entityType=session&entityId=6a9fbc9c617dfedd88a0471e&classId=6a9a54f7ab2211cca56eaf5c&profile=teacher",
      className: "Ranada (Dada.Pu) Purdue",
      tutor: "Kevin (Kev) Y. Hsieh Online",
      scheduledEndAt: "2026-09-29T04:00:00.000Z",
      state: "verified",
      reason: "verified",
      arm: "luna",
      evidence: "transcript",
      postStartedAt: "2026-09-29T04:02:30.000Z",
      latencyMinutes: 2.5,
      costUsd: 0.0012,
      fields: { topics: "Rearranging equations", performance: "Ranada did well", improvement: "nth term", homework: "" },
      judgeUnsupported: [],
      summaryFallback: null,
    }],
    webhooks: { lastReceivedAt: "2026-09-29T04:00:05.000Z", byEvent: [{ eventName: "MeetingEndedEvent", count: 3 }], byOutcome: [{ outcome: "verified", count: 1 }] },
    ...overrides,
  };
}

describe("FeedbackAutowriterDashboard", () => {
  it("renders KPIs, tutors, recent classes with the posted text, cost and webhooks", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterDashboard initialData={payload()} canControl={false} />);
    expect(html).toContain("Feedback Autowriter");
    expect(html).toContain("Posted to Wise");
    expect(html).toContain("Kevin (Kev) Y. Hsieh");
    expect(html).toContain("Partly on");
    expect(html).toContain("In-person classes stay with the tutor and are not shown here.");
    expect(html).toContain("Ranada (Dada.Pu) Purdue");
    expect(html).toContain("Rearranging equations");
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("MeetingEndedEvent");
    expect(html).toContain("2.5 min");
    expect(html).toContain("From recording");
    expect(html).toContain("· transcript");
  });

  it("shows transcript first: waiting for the recording, fallbacks by cause and latency by evidence", () => {
    const base = payload();
    const html = renderToStaticMarkup(<FeedbackAutowriterDashboard canControl={false} initialData={payload({
      summaryFallbacks: [{ cause: "no_recording", label: "No recording after 3 h — from summary", count: 2 }],
      recent: [
        { ...base.recent[0], wiseSessionId: "6a0000000000000000000011", className: "Somchai (Tom.Ja) Jaidee", state: "awaiting_recording",
          reason: "transcript_first", postStartedAt: null, latencyMinutes: null, fields: null },
        { ...base.recent[0], wiseSessionId: "6a0000000000000000000012", className: "Somchai (Tom.Ja) Jaidee", evidence: "summary",
          summaryFallback: { cause: "no_recording", label: "No recording after 3 h — from summary" } },
      ],
    })} />);
    expect(html).toContain("Waiting for the recording");
    expect(html).toContain("No recording after 3 h — from summary");
    expect(html).toContain("Back to the summary (transcript first)");
    expect(html).toContain("Class end → posted, by evidence");
    expect(html).toContain("From the transcript");
    expect(html).toContain("55.0 min");
    expect(html).toContain("1.2 h");

    const quiet = renderToStaticMarkup(<FeedbackAutowriterDashboard initialData={payload()} canControl={false} />);
    expect(quiet).toContain("No class fell back to the summary in this window.");
  });

  it("labels Sol drafts and Sol's cost", () => {
    const base = payload();
    const html = renderToStaticMarkup(<FeedbackAutowriterDashboard canControl={false} initialData={payload({
      recent: [{ ...base.recent[0], arm: "sol", evidence: "summary" }],
      cost: { ...base.cost, byModel: [{ model: "openai/gpt-6.1-sol", role: "writer", calls: 3, costUsd: 0.12 }] },
    })} />);
    expect(html.match(/GPT-6\.1 Sol/gu)).toHaveLength(2); // recent row + cost by model
    expect(html).not.toContain("GPT-6 Luna");
  });

  it("shows owner controls only to the owner", () => {
    const viewer = renderToStaticMarkup(<FeedbackAutowriterDashboard initialData={payload()} canControl={false} />);
    const owner = renderToStaticMarkup(<FeedbackAutowriterDashboard initialData={payload()} canControl />);
    expect(viewer).not.toContain("Go live");
    expect(owner).toContain("Go live");
    expect(owner).toContain("Pause");
  });

  it("makes a halt impossible to miss", () => {
    const html = renderToStaticMarkup(<FeedbackAutowriterDashboard
      initialData={payload({ control: { ...payload().control, mode: "live", haltedAt: "2026-09-30T02:00:00.000Z", haltReason: "unknown outcome for the feedback POST on x" } })}
      canControl />);
    expect(html).toContain("Posting is halted");
    expect(html).toContain("unknown outcome for the feedback POST on x");
    expect(html).toContain("Resume");
  });

  it("polls with the house pattern (abortable, sequenced, 60 s)", () => {
    const source = fs.readFileSync(path.join(__dirname, "../feedback-autowriter-dashboard.tsx"), "utf8");
    expect(source).toContain("AbortController");
    expect(source).toContain("requestSequence");
    expect(source).toContain("60_000");
  });
});
