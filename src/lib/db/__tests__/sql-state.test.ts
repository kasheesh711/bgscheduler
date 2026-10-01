import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { sqlStateOf } from "../sql-state";

/** What a driver (node-postgres, Neon) throws: an Error carrying the SQLSTATE in `code`. */
function driverError(code: string, message = "driver error") {
  return Object.assign(new Error(message), { code });
}

describe("sqlStateOf", () => {
  it("reads the SQLSTATE of a driver error from its own code", () => {
    expect(sqlStateOf(driverError("42P01", 'relation "tutor_offboarding_decisions" does not exist'))).toBe("42P01");
  });

  it("reads the SQLSTATE from `cause` when drizzle wraps the driver error in a DrizzleQueryError", () => {
    const wrapped = new DrizzleQueryError(
      "update tutor_wise_accounts set wise_relation = $1",
      ["TEACHER"],
      driverError("42703", 'column "wise_relation" does not exist'),
    );
    expect("code" in wrapped).toBe(false);
    expect(sqlStateOf(wrapped)).toBe("42703");
  });

  it("prefers the outer code when both the error and its cause carry one", () => {
    expect(sqlStateOf(Object.assign(driverError("23505"), { cause: driverError("42703") }))).toBe("23505");
  });

  it("returns null when neither the error nor its cause has a code", () => {
    expect(sqlStateOf(new Error("plain failure"))).toBeNull();
    expect(sqlStateOf(new DrizzleQueryError("select 1", [], new Error("no code here")))).toBeNull();
    expect(sqlStateOf(new DrizzleQueryError("select 1", []))).toBeNull();
    expect(sqlStateOf({ cause: null })).toBeNull();
  });

  it("only trusts string codes: a non-string code is ignored and the cause is still consulted", () => {
    expect(sqlStateOf({ code: 42703 })).toBeNull();
    expect(sqlStateOf({ code: 42703, cause: { code: "23505" } })).toBe("23505");
    expect(sqlStateOf({ cause: { code: 23505 } })).toBeNull();
  });

  it("never reads message text, which carries the query and its parameters", () => {
    expect(sqlStateOf(new Error('SQLSTATE 42P01: relation "x" does not exist'))).toBeNull();
    expect(sqlStateOf(new DrizzleQueryError("select 1 where note = '42703'", ["42703"]))).toBeNull();
  });

  it.each([null, undefined, "42P01", 42703, true])("returns null for the non-object %s", (value) => {
    expect(sqlStateOf(value)).toBeNull();
  });
});
