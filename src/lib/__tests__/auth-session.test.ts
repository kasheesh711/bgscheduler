import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => { throw new Error("Unexpected database access"); }) }));

import { validateSessionAccess } from "@/lib/auth-session";

function fakeDb(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit"]) builder[method] = () => builder;
  builder.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return { select: () => builder } as never;
}

function session(version?: number, role = "admin"): Session {
  return { user: { email: "Aoeng@Example.com", role, adminAccessVersion: version }, expires: "2099-01-01" } as Session;
}

describe("fresh session access", () => {
  it("never opens the database for an absent or malformed session", async () => {
    expect(await validateSessionAccess(null)).toBeNull();
    expect(await validateSessionAccess({ user: {}, expires: "2099" })).toBeNull();
  });

  it("returns current page restrictions for a matching active admin version", async () => {
    const result = await validateSessionAccess(session(0), fakeDb([
      { disabled: false, accessVersion: 0, allowedPages: ["/search"] },
    ]));
    expect(result?.user).toMatchObject({ allowedPages: ["/search"], adminAccessVersion: 0 });
  });

  it.each([
    { disabled: true, accessVersion: 1, allowedPages: null },
    { disabled: false, accessVersion: 2, allowedPages: null },
  ])("a disabled/re-enabled row never revives the old session: %j", async (row) => {
    expect(await validateSessionAccess(session(0), fakeDb([row]))).toBeNull();
  });

  it("accepts a fresh login after re-enable and rejects deleted admins", async () => {
    expect(await validateSessionAccess(session(2), fakeDb([{ disabled: false, accessVersion: 2, allowedPages: null }]))).not.toBeNull();
    expect(await validateSessionAccess(session(2), fakeDb([]))).toBeNull();
  });

  it("requires a new login for legacy unversioned admin cookies", async () => {
    expect(await validateSessionAccess(session(), fakeDb([{ disabled: false, accessVersion: 0, allowedPages: null }]))).toBeNull();
    expect(await validateSessionAccess(session(0, ""), fakeDb([{ disabled: false, accessVersion: 0, allowedPages: null }]))).toBeNull();
  });

  it("does not allow a disabled admin through a teacher/admissions cookie", async () => {
    expect(await validateSessionAccess(session(undefined, "teacher"), fakeDb([{ disabled: true, accessVersion: 1 }]))).toBeNull();
  });

  it("preserves existing non-admin role behavior when there is no admin row", async () => {
    for (const role of ["teacher", "counselor", "student", "parent"]) {
      expect(await validateSessionAccess(session(undefined, role), fakeDb([]))).toEqual(session(undefined, role));
    }
  });

  it("denies access when the database is unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await validateSessionAccess(session(0), { select: () => { throw new Error("unavailable"); } } as never)).toBeNull();
    log.mockRestore();
  });
});
