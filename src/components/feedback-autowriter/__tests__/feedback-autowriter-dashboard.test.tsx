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
    totals: { seen: 5, posted: 2, verified: 2, awaitingEvent: 0, shadowDrafts: 1, held: 1, skippedHuman: 1, skippedScope: 0, expired: 0, failed: 0, inProgress: 0 },
    latency: { medianMinutes: 2.5, p90Minutes: 4, samples: 2 },
    cost: {
      totalUsd: 0.0076,
      perDraftUsd: 0.0025,
      byModel: [{ model: "z-ai/glm-5.3-flash", role: "writer", calls: 2, costUsd: 0.0048 }],
      byDay: [{ date: "2026-09-30", costUsd: 0.0076, drafts: 3, posted: 2 }],
    },
    fallbackShare: 0.333,
    judgeRejections: 1,
    tutors: [{
      wiseUserId: "696e2c4343579bbada2340ed", displayName: "Kevin (Kev) Y. Hsieh Online", enabled: true,
      seen: 5, posted: 2, shadowDrafts: 1, held: 1, skippedHuman: 1, expired: 0, failed: 0, medianLatencyMinutes: 2.5, costUsd: 0.0076,
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
      postStartedAt: "2026-09-29T04:02:30.000Z",
      latencyMinutes: 2.5,
      costUsd: 0.0012,
      fields: { topics: "Rearranging equations", performance: "Ranada did well", improvement: "nth term", homework: "" },
      judgeUnsupported: [],
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
    expect(html).toContain("Kevin (Kev) Y. Hsieh Online");
    expect(html).toContain("Ranada (Dada.Pu) Purdue");
    expect(html).toContain("Rearranging equations");
    expect(html).toContain("GPT-6 Luna");
    expect(html).toContain("MeetingEndedEvent");
    expect(html).toContain("2.5 min");
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
