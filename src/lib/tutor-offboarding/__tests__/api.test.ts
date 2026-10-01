import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { tutorOffboardingErrorResponse } from "../api";
import { TutorOffboardingError } from "../errors";

afterEach(() => vi.restoreAllMocks());

describe("tutorOffboardingErrorResponse", () => {
  it("passes Next's abandoned-render signal through", () => {
    const signal = { digest: "HANGING_PROMISE_REJECTION" };
    expect(() => tutorOffboardingErrorResponse("route", signal, "fallback")).toThrow();
  });

  it("maps its own and the owner errors to their status", async () => {
    const own = tutorOffboardingErrorResponse("route", new TutorOffboardingError("Already marked.", 409), "fallback");
    expect([own.status, await own.json()]).toEqual([409, { error: "Already marked." }]);
    const owner = tutorOffboardingErrorResponse("route", new AdminUsersAccessError("nope", 403), "fallback");
    expect([owner.status, await owner.json()]).toEqual([403, { error: "Only the website owner can change who can remove tutors." }]);
  });

  it("maps validation errors to 400 and a missing migration to 503", async () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    const invalid = tutorOffboardingErrorResponse("route", parsed.error, "fallback");
    expect(invalid.status).toBe(400);
    const missing = tutorOffboardingErrorResponse("route", { cause: { code: "42P01" } }, "fallback");
    expect([missing.status, await missing.json()]).toEqual([503, { error: "Tutor Offboarding is not set up yet (database migration pending)." }]);
  });

  it("hides unknown errors and logs only their name and SQLSTATE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = tutorOffboardingErrorResponse("[route]", new Error("insert into ... values ('secret note')"), "Could not save.");
    expect([response.status, await response.json()]).toEqual([500, { error: "Could not save." }]);
    expect(log).toHaveBeenCalledWith("[route]", { errorName: "Error", sqlState: null });
  });
});
