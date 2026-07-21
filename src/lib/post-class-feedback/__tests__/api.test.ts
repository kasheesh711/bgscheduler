import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { postClassFeedbackErrorResponse } from "../api";

describe("post-class API error privacy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not log or return unknown error details that could contain feedback", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateText = "Student Mali struggled with private family details";
    const response = postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/test",
      new Error(privateText),
      "The request could not be completed.",
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "The request could not be completed." });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
  });
});
