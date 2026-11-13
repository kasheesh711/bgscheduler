import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callOpenRouter } from "@/lib/feedback-autowriter/openrouter";
import { callClaude, claudeSchema } from "../claude";
import { markingRoute } from "../marking";

const schema = z.object({ questions: z.array(z.object({ id: z.string().regex(/^\w{1,9}$/), max: z.number(), pattern: z.string().max(5).nullable() }).strict()).max(400) }).strict();
const input = (fetchImpl: typeof fetch) => ({
  apiKey: "synthetic-key",
  model: "claude-opus-5-5",
  provider: {},
  effort: "medium" as const,
  maxTokens: 32000,
  timeoutMs: 5000,
  schemaName: "paper_marks",
  schema: z.toJSONSchema(schema, { target: "draft-7" }),
  messages: [
    { role: "system" as const, content: "Mark the paper." },
    { role: "user" as const, content: [{ type: "text" as const, text: "The scan:" }, { type: "file" as const, file: { filename: "answers.pdf", file_data: "data:application/pdf;base64,UERG" } }] },
  ],
  fetchImpl,
});
const reply = (body: object, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("callClaude", () => {
  it("sends the PDF as a document and a schema Claude accepts, and returns the answer with its cost", async () => {
    const fetchImpl = reply({
      id: "msg_1",
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"questions":[]}' }],
      usage: { input_tokens: 100_000, output_tokens: 10_000 },
    });
    const call = await callClaude(input(fetchImpl));
    expect(call).toMatchObject({ ok: true, content: '{"questions":[]}', model: "claude-opus-5-5", provider: "anthropic", usage: { promptTokens: 100_000, completionTokens: 10_000 } });
    // 100,000 input tokens at $4 and 10,000 output tokens at $20, for each million.
    expect(call.usage?.costUsd).toBeCloseTo(0.6);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("synthetic-key");
    const body = JSON.parse(init?.body as string);
    expect(body.system).toBe("Mark the paper.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "The scan:" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } }] },
    ]);
    expect(body.output_config.effort).toBe("medium");
    const sent = JSON.stringify(body.output_config.format.schema);
    expect(sent).not.toMatch(/maxItems|maxLength|\$schema|\\\\w/);
    // A property with the name of a refused keyword stays.
    expect(body.output_config.format.schema.properties.questions.items.properties.pattern).toBeDefined();
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
  });

  it("reports a refusal, a cut-off answer and an API error as failures", async () => {
    expect(await callClaude(input(reply({ model: "claude-opus-5-5", stop_reason: "refusal", content: [], usage: { input_tokens: 5, output_tokens: 0 } })))).toMatchObject({ ok: false, error: "finish_reason_refusal" });
    expect(await callClaude(input(reply({ model: "claude-opus-5-5", stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] })))).toMatchObject({ ok: false, error: "finish_reason_max_tokens" });
    expect(await callClaude(input(reply({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, 400)))).toMatchObject({ ok: false, httpStatus: 400, error: "Your credit balance is too low", usage: null });
  });

  it("gives no cost for a model with no listed price", async () => {
    const call = await callClaude({ ...input(reply({ model: "claude-next", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } })), model: "claude-next" });
    expect(call).toMatchObject({ ok: true, usage: { costUsd: null } });
  });
});

describe("claudeSchema", () => {
  it("changes nothing else", () => {
    expect(claudeSchema({ type: "object", properties: { a: { type: "string", maxLength: 3, enum: ["x"] } }, required: ["a"] })).toEqual({ type: "object", properties: { a: { type: "string", enum: ["x"] } }, required: ["a"] });
  });
});

describe("markingRoute", () => {
  it("uses the Claude key when it is set, then the OpenRouter key, then nothing", () => {
    expect(markingRoute({ ANTHROPIC_HIRING_API_KEY: " a ", OPENROUTER_HIRING_API_KEY: "o" })).toEqual({ apiKey: "a", model: "claude-opus-5-5", callModel: callClaude, maxMb: 22 });
    expect(markingRoute({ OPENROUTER_HIRING_API_KEY: "o", HIRING_MARKING_MODEL: "x/y" })).toEqual({ apiKey: "o", model: "x/y", callModel: callOpenRouter, maxMb: 45 });
    expect(markingRoute({})).toBeNull();
  });
});
