import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canUseClassCapture, requireCaptureScope } from "../sessions";

function database(queue: unknown[][]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const selections: string[][] = [];
  let index = 0;
  const db = { select: (selection: Record<string, unknown>) => {
    selections.push(Object.keys(selection));
    const rows = queue[index++] ?? [];
    const chain = {
      from: () => chain,
      where: (filter: SQL) => { queries.push(new PgDialect().sqlToQuery(filter)); return chain; },
      limit: () => chain,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  } };
  vi.mocked(getDb).mockReturnValue(db as never);
  return { queries, selections };
}

const owner = "owner@example.test";
const activeAdmin = { disabled: false, allowedPages: null, accessVersion: 3 };
function signedIn(email = owner, role = "admin", adminAccessVersion: unknown = 3) {
  vi.mocked(auth).mockResolvedValue({ user: { email, role, adminAccessVersion, allowedPages: null } } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
  vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", owner);
  vi.stubEnv("SUPER_ADMIN_EMAILS", `${owner},other-owner@example.test`);
  signedIn();
});
afterEach(() => vi.unstubAllEnvs());

describe("current owner-only class capture pilot", () => {
  it("requires an authenticated email before any database lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 401 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([null, ["/class-capture"], ["/search", "/class-capture"]].map(allowedPages => ({ allowedPages })))("allows only the configured owner with a current full or explicit page grant: $allowedPages", async ({ allowedPages }) => {
    const { queries, selections } = database([[{ ...activeAdmin, allowedPages }]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: null });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('"admin_users"."email"');
    expect(queries[0].params).toEqual([owner]);
    expect(selections[0]).toEqual(expect.arrayContaining(["disabled", "allowedPages", "accessVersion"]));
  });

  it("normalizes bounded email case and surrounding whitespace without changing identity", async () => {
    signedIn("  OWNER@EXAMPLE.TEST \t");
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", " OWNER@EXAMPLE.TEST ");
    vi.stubEnv("SUPER_ADMIN_EMAILS", " other-owner@example.test, OWNER@EXAMPLE.TEST ");
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: null });
  });

  it.each([
    { pilot: "\u212Aeeper@example.test", email: "keeper@example.test", status: 403 },
    { pilot: "keeper@example.test", email: "\u212Aeeper@example.test", status: 401 },
  ])("rejects Unicode case-fold aliases before normalization: $pilot / $email", async ({ pilot, email, status }) => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", pilot);
    vi.stubEnv("SUPER_ADMIN_EMAILS", "keeper@example.test");
    signedIn(email);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    [owner, "teacher"], ["tutor@example.test", "teacher"],
    ["admin@example.test", "admin"], ["other-owner@example.test", "admin"],
    ["owner+other@example.test", "admin"], ["owner@example.test.attacker.invalid", "admin"],
    [owner, "parent"], [owner, undefined],
  ])("denies nonpilot or nonadmin identity %s/%s before class or tutor queries", async (email, role) => {
    vi.mocked(auth).mockResolvedValue({ user: { email, role, adminAccessVersion: 3, allowedPages: null } } as never);
    database([[activeAdmin], [{ canonicalKey: "Synthetic Tutor", active: true, onsiteEmail: email }]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    undefined, "", "   ", "*", "owner", "@example.test", "owner@example", "Owner <owner@example.test>",
    `${owner},other-owner@example.test`, `${owner},${owner}`, `${owner},`, `${owner};other-owner@example.test`,
    `${owner} other-owner@example.test`, `${owner}\nother-owner@example.test`, "owner..name@example.test",
    "own\u0435r@example.test", "owner@ex\u00e1mple.test", `owner\0@example.test`,
    `${"x".repeat(255)}@example.test`, `${" ".repeat(321)}${owner}`,
  ])("fails closed for absent, malformed or multiple pilot configuration: %j", async config => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", config);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "other-owner@example.test", "owner@example.test.attacker.invalid"])("requires the independent existing owner designation: %j", async owners => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", owners);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "3", 3.5, -1, Number.NaN])("denies a missing or invalid session access version: %j", async version => {
    vi.mocked(auth).mockResolvedValue({ user: { email: owner, role: "admin", adminAccessVersion: version } } as never);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    [], [{ ...activeAdmin, disabled: true }], [{ ...activeAdmin, accessVersion: 4 }],
    [{ ...activeAdmin, accessVersion: undefined }], [{ ...activeAdmin, accessVersion: "3" }],
    [{ ...activeAdmin, allowedPages: [] }], [{ ...activeAdmin, allowedPages: ["/progress-tests"] }],
    [{ ...activeAdmin, allowedPages: ["/class-capture/other"] }], [{ ...activeAdmin, allowedPages: undefined }],
  ].map(rows => ({ rows })))("denies missing, revoked, stale or ungranted current admin access: $rows", async ({ rows }) => {
    const { queries } = database([rows, [{ canonicalKey: "Synthetic Tutor", active: true, onsiteEmail: owner }]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(1);
  });

  it("accepts a current initial zero access version", async () => {
    signedIn(owner, "admin", 0);
    database([[{ ...activeAdmin, accessVersion: 0 }]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: null });
  });

  it("rechecks both the database grant and owner designation on every request", async () => {
    const { queries } = database([[activeAdmin], [{ ...activeAdmin, disabled: true }]]);
    await expect(requireCaptureScope()).resolves.toMatchObject({ email: owner });
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("SUPER_ADMIN_EMAILS", "other-owner@example.test");
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(2);
  });

  it("does not grant access if the current admin lookup fails", async () => {
    const failure = new Error("synthetic database unavailable");
    vi.mocked(getDb).mockImplementation(() => { throw failure; });
    await expect(requireCaptureScope()).rejects.toBe(failure);
    await expect(canUseClassCapture()).resolves.toBe(false);
  });

  it("hides navigation while paused without an access query", async () => {
    vi.stubEnv("ENABLE_CLASS_CAPTURE", "false");
    await expect(canUseClassCapture()).resolves.toBe(false);
    expect(auth).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([[owner, "teacher"], ["admin@example.test", "admin"], ["other-owner@example.test", "admin"]])("hides navigation from %s/%s", async (email, role) => {
    signedIn(email, role);
    database([[activeAdmin]]);
    await expect(canUseClassCapture()).resolves.toBe(false);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("shows navigation only while the configured owner's grant remains current", async () => {
    database([[activeAdmin], [{ ...activeAdmin, accessVersion: 4 }]]);
    await expect(canUseClassCapture()).resolves.toBe(true);
    await expect(canUseClassCapture()).resolves.toBe(false);
  });
});
