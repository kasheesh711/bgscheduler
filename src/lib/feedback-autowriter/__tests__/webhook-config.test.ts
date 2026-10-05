import { describe, expect, it } from "vitest";
import {
  AUTOWRITER_JUDGE_EFFORTS,
  AUTOWRITER_MODELS,
  AUTOWRITER_WRITER_BY_ARM,
  autowriterAlertEmails,
  autowriterEnabled,
  autowriterHoldSummaryOnly,
  autowriterTranscriptFirst,
  autowriterWritesAllowedHere,
  openRouterApiKey,
  writersFor,
} from "../config";
import { classifyGateReason } from "../session";
import {
  findWiseWebhookAuthHeader,
  parseWiseWebhookBody,
  verifyWiseWebhookAuth,
  wiseWebhookAuthHeader,
  wiseWebhookDedupeKey,
  wiseWebhooksEnabled,
} from "../webhook";

const SESSION = "6a9fbc9c617dfedd88a0471e";

describe("Wise webhook helpers", () => {
  it("accepts the shared key bare or as a Bearer token, constant-time", () => {
    expect(verifyWiseWebhookAuth("secret-key", "secret-key")).toBe(true);
    expect(verifyWiseWebhookAuth("Bearer secret-key", "secret-key")).toBe(true);
    expect(verifyWiseWebhookAuth("Basic secret-key", "secret-key")).toBe(true);
    expect(verifyWiseWebhookAuth("Bearer other secret-key", "secret-key")).toBe(false);
    expect(verifyWiseWebhookAuth("wrong", "secret-key")).toBe(false);
    expect(verifyWiseWebhookAuth(null, "secret-key")).toBe(false);
    expect(verifyWiseWebhookAuth("anything", undefined)).toBe(false);
  });

  it("finds the key in whichever header Wise used, or only in the pinned one", () => {
    const headers = (): Array<[string, string]> => [["content-type", "application/json"], ["X-Wise-Auth", "secret-key"]];
    expect(findWiseWebhookAuthHeader(headers(), "secret-key", null)).toBe("x-wise-auth");
    expect(findWiseWebhookAuthHeader(headers(), "secret-key", "x-wise-auth")).toBe("x-wise-auth");
    expect(findWiseWebhookAuthHeader(headers(), "secret-key", "authorization")).toBeNull();
    expect(findWiseWebhookAuthHeader(headers(), "other-key", null)).toBeNull();
    expect(findWiseWebhookAuthHeader(headers(), undefined, null)).toBeNull();
  });

  it("reads the header name and enable flag from the environment", () => {
    expect(wiseWebhookAuthHeader({})).toBeNull();
    expect(wiseWebhookAuthHeader({ WISE_WEBHOOK_AUTH_HEADER: "X-Wise-Key" })).toBe("x-wise-key");
    expect(wiseWebhooksEnabled({ WISE_WEBHOOKS_ENABLED: "true" })).toBe(true);
    expect(wiseWebhooksEnabled({ WISE_WEBHOOKS_ENABLED: "yes" })).toBe(false);
  });

  it("finds the session id in the documented payload shapes", () => {
    expect(parseWiseWebhookBody(JSON.stringify({ event: "RecordingCompletedEvent", payload: { userId: "u", sessionId: SESSION } })))
      .toMatchObject({ eventName: "RecordingCompletedEvent", sessionId: SESSION });
    expect(parseWiseWebhookBody(JSON.stringify({ eventName: "MeetingEndedEvent", payload: { sessionId: SESSION, payload: { object: { id: 1 } } } })))
      .toMatchObject({ eventName: "MeetingEndedEvent", sessionId: SESSION });
    expect(parseWiseWebhookBody(JSON.stringify({ type: "AttendanceComputedEvent", payload: { session: { _id: SESSION } } })))
      .toMatchObject({ sessionId: SESSION });
  });

  it("ignores ids that are not Wise object ids and non-JSON bodies", () => {
    expect(parseWiseWebhookBody(JSON.stringify({ event: "MeetingEndedEvent", payload: { sessionId: "../../x" } }))?.sessionId).toBeNull();
    expect(parseWiseWebhookBody("not json")).toBeNull();
  });

  it("dedupes retries of the same body", () => {
    expect(wiseWebhookDedupeKey("{\"a\":1}")).toBe(wiseWebhookDedupeKey("{\"a\":1}"));
    expect(wiseWebhookDedupeKey("{\"a\":1}")).not.toBe(wiseWebhookDedupeKey("{\"a\":2}"));
  });
});

describe("config", () => {
  it("needs the exact string true to run", () => {
    expect(autowriterEnabled({ FEEDBACK_AUTOWRITER_ENABLED: "true" })).toBe(true);
    expect(autowriterEnabled({ FEEDBACK_AUTOWRITER_ENABLED: "TRUE" })).toBe(false);
    expect(autowriterEnabled({})).toBe(false);
  });

  it("turns transcript first on only with the exact string true", () => {
    expect(autowriterTranscriptFirst({ FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST: "true" })).toBe(true);
    expect(autowriterTranscriptFirst({ FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST: "True" })).toBe(false);
    expect(autowriterTranscriptFirst({ FEEDBACK_AUTOWRITER_TRANSCRIPT_FIRST: "1" })).toBe(false);
    expect(autowriterTranscriptFirst({})).toBe(false);
  });

  it("holds summary-only drafts only with the exact string true", () => {
    expect(autowriterHoldSummaryOnly({ FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY: "true" })).toBe(true);
    expect(autowriterHoldSummaryOnly({ FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY: "TRUE" })).toBe(false);
    expect(autowriterHoldSummaryOnly({ FEEDBACK_AUTOWRITER_HOLD_SUMMARY_ONLY: "1" })).toBe(false);
    expect(autowriterHoldSummaryOnly({})).toBe(false);
  });

  it("never writes from a preview deployment", () => {
    expect(autowriterWritesAllowedHere({ VERCEL_ENV: "preview" })).toBe(false);
    expect(autowriterWritesAllowedHere({ VERCEL_ENV: "production" })).toBe(true);
  });

  it("parses the alert list and the API key", () => {
    expect(autowriterAlertEmails({ FEEDBACK_AUTOWRITER_ALERT_EMAILS: "a@x.com, B@X.com;not-an-email a@x.com" })).toEqual(["a@x.com", "b@x.com"]);
    expect(openRouterApiKey({ OPENROUTER_API_KEY: "  " })).toBeNull();
  });

  it("writes with Sol at reasoning low, falls back to Luna and judges with GLM — all with zero data retention", () => {
    expect(AUTOWRITER_MODELS.writer).toMatchObject({ arm: "sol", model: "openai/gpt-6.1-sol", effort: "low", expectModel: "openai/gpt-6.1-sol" });
    expect(AUTOWRITER_MODELS.fallbackWriter).toMatchObject({ arm: "luna", model: "openai/gpt-6-luna", effort: "max" });
    expect(AUTOWRITER_MODELS.judge).toMatchObject({ arm: "glm", model: "z-ai/glm-5.3-flash", expectProvider: "Together" });
    // The judge has no effort of its own: it runs at every level in AUTOWRITER_JUDGE_EFFORTS.
    expect(AUTOWRITER_MODELS.judge).not.toHaveProperty("effort");
    expect(AUTOWRITER_JUDGE_EFFORTS).toEqual(["medium", "high"]);
    for (const config of Object.values(AUTOWRITER_MODELS)) {
      expect(config.provider).toMatchObject({ zdr: true, data_collection: "deny", require_parameters: true });
    }
  });

  it("writes the tutors added on 2 Oct with Luna first and Sol as their fallback; everyone else Sol then Luna", () => {
    const solFirst = [AUTOWRITER_MODELS.writer, AUTOWRITER_MODELS.fallbackWriter];
    const lunaFirst = [AUTOWRITER_MODELS.fallbackWriter, AUTOWRITER_MODELS.writer];
    expect(writersFor("Mimi")).toEqual(solFirst);
    expect(writersFor("Kevin")).toEqual(solFirst);
    for (const key of ["Ras", "Celeste", "Taki", "Dome", "Mandy", "Grace", "Mint", "Fluke", "Calvin", "Lukas", "A", "Ohm", "Mookie"]) {
      expect(writersFor(key)).toEqual(lunaFirst);
    }
    // Not on the roster (or unknown): the default order, never a guess.
    expect(writersFor("Fluke-Supha")).toEqual(solFirst);
    expect(writersFor(undefined)).toEqual(solFirst);
  });

  it("keeps a writer per arm for the evaluation CLI", () => {
    expect(AUTOWRITER_WRITER_BY_ARM.sol).toBe(AUTOWRITER_MODELS.writer);
    expect(AUTOWRITER_WRITER_BY_ARM.luna).toBe(AUTOWRITER_MODELS.fallbackWriter);
    // GLM evaluates with the config it wrote with until 30 Sep, not the judge's.
    expect(AUTOWRITER_WRITER_BY_ARM.glm).toMatchObject({ arm: "glm", model: "z-ai/glm-5.3-flash", effort: "max", provider: { order: ["together"], zdr: true } });
  });
});

describe("classifyGateReason", () => {
  it.each([
    ["no_ai_summary", "retry"],
    ["class_not_finished", "retry"],
    ["meeting_ONGOING", "retry"],
    ["submission_none_not_enabled_in_pilot", "retry"],
    ["session_type_OFFLINE", "scope"],
    ["class_type_GROUP", "scope"],
    ["meeting_CANCELLED", "scope"],
    ["student_count_2", "scope"],
    ["human_submission", "human"],
    ["student_count_0", "person"],
    ["attendance_20pct", "person"],
    ["feedback_form_mapping_form_drift:x", "person"],
    ["deadline_passed_or_too_close", "expired"],
  ])("%s → %s", (reason, disposition) => {
    expect(classifyGateReason(reason)).toBe(disposition);
  });
});
