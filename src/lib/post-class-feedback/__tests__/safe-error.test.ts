import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";

import {
  PostClassConflictError,
  PostClassNotFoundError,
  PostClassValidationError,
} from "@/lib/post-class-feedback/errors";
import { safeErrorFields } from "@/lib/post-class-feedback/safe-error";

const SQL_MESSAGE = 'Failed query: update "post_class_deductions" set "status" = $1 where "id" = $2\nparams: approved,ded-1';

/** What drizzle 0.45 throws: its message carries the SQL and params; the driver error, with its SQLSTATE, is `cause`. */
function drizzleError(code: unknown): Error {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { name: "NeonDbError", code });
  return new DrizzleQueryError('update "post_class_deductions" set "status" = $1 where "id" = $2', ["approved", "ded-1"], cause);
}

describe("safeErrorFields", () => {
  it("names the error class and drops a driver message that carries SQL and parameters", () => {
    const error = drizzleError("40001");
    // drizzle 0.45 never sets the name, so the class has to be recognised by instanceof.
    expect(error.name).toBe("Error");
    expect(error.message).toContain("params: approved,ded-1");

    expect(safeErrorFields(error)).toEqual({ errorName: "DrizzleQueryError", causeName: "NeonDbError", code: "40001" });
  });

  it("reads the error's own code before its cause's", () => {
    const network = Object.assign(new TypeError("connect ECONNRESET 10.0.0.1:5432"), { code: "ECONNRESET" });
    expect(safeErrorFields(network)).toEqual({ errorName: "TypeError", code: "ECONNRESET" });

    const fetchFailed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error (attempted address: api.openai.com:443)"), {
        name: "ConnectTimeoutError",
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    expect(safeErrorFields(fetchFailed)).toEqual({
      errorName: "TypeError",
      causeName: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
  });

  it("falls back to the cause's code when the error's own code is not an identifier", () => {
    const error = Object.assign(drizzleError("23505"), { code: 23 });
    expect(safeErrorFields(error)).toEqual({ errorName: "DrizzleQueryError", causeName: "NeonDbError", code: "23505" });
  });

  it.each([
    ["a number", 23],
    ["lowercase text", "econnreset"],
    ["a sentence", "select * from post_class_deductions"],
    ["an over-long string", "X".repeat(41)],
    ["an empty string", ""],
  ])("never logs a code that is %s", (_label, code) => {
    expect(safeErrorFields(drizzleError(code))).toEqual({ errorName: "DrizzleQueryError", causeName: "NeonDbError" });
  });

  it.each([
    ["PostClassValidationError", new PostClassValidationError("Only pending or approved deductions can be waived.")],
    ["PostClassConflictError", new PostClassConflictError("This record changed. Refresh and try again.", "lease_held")],
    ["PostClassNotFoundError", new PostClassNotFoundError("Deduction not found.")],
  ])("keeps the message of a %s, whose text the code writes", (name, error) => {
    expect(safeErrorFields(error)).toEqual({ errorName: name, message: error.message });
  });

  it("keeps a typed error's message and its driver code together", () => {
    const error = Object.assign(new PostClassConflictError("This record changed. Refresh and try again."), {
      cause: { code: "40P01" },
    });
    expect(safeErrorFields(error)).toEqual({
      errorName: "PostClassConflictError",
      code: "40P01",
      message: "This record changed. Refresh and try again.",
    });
  });

  it("does not trust a borrowed class name: only a real instance keeps its message", () => {
    const impostor = new Error(SQL_MESSAGE);
    impostor.name = "PostClassValidationError";
    expect(safeErrorFields(impostor)).toEqual({ errorName: "PostClassValidationError" });
  });

  it.each([
    ["a string", "update failed: params ded-1"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object with a message", { message: SQL_MESSAGE, code: "40001" }],
  ])("reports %s as UnknownError without its content", (_label, thrown) => {
    const fields = safeErrorFields(thrown);
    expect(fields.errorName).toBe("UnknownError");
    expect(fields).not.toHaveProperty("message");
    expect(JSON.stringify(fields)).not.toContain("params");
  });
});
