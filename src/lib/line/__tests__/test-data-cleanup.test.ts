import { describe, expect, it } from "vitest";
import { buildLineTestDataCleanupTargets } from "@/lib/line/test-data-cleanup";

describe("LINE test data cleanup targeting", () => {
  it("targets only rows reachable from current LINE contacts, threads, messages, and reviews", () => {
    const targets = buildLineTestDataCleanupTargets({
      contacts: [{ id: "contact-line" }],
      threads: [
        { id: "thread-line", contactId: "contact-line", aiSchedulerConversationId: "conversation-line" },
      ],
      messages: [
        { id: "line-message", threadId: "thread-line", contactId: "contact-line" },
      ],
      reviews: [
        {
          id: "review-line",
          threadId: "thread-line",
          contactId: "contact-line",
          inboundMessageId: "line-message",
          conversationId: "conversation-line",
          schedulerMessageId: "scheduler-message-line",
          schedulerRunId: "scheduler-run-line",
        },
      ],
      schedulerMessages: [{ id: "scheduler-message-from-conversation" }],
      schedulerRuns: [{ id: "scheduler-run-from-conversation", messageId: "scheduler-message-from-run" }],
    });

    expect(targets).toEqual({
      contactIds: ["contact-line"],
      threadIds: ["thread-line"],
      lineMessageIds: ["line-message"],
      reviewIds: ["review-line"],
      conversationIds: ["conversation-line"],
      schedulerMessageIds: [
        "scheduler-message-from-conversation",
        "scheduler-message-from-run",
        "scheduler-message-line",
      ],
      schedulerRunIds: ["scheduler-run-from-conversation", "scheduler-run-line"],
    });
  });
});
