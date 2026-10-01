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

const owner = "admin-pilot@example.test";
const pilots = [owner, "first-tutor@example.test", "second-tutor@example.test"];
const activeAdmin = { disabled: false, allowedPages: null, accessVersion: 3 };
const contact = (email = owner, canonicalKey = "Admin Tutor") => ({ canonicalKey, active: true, onsiteEmail: email, onlineEmail: null });
function signedIn(email = owner, role = "admin", adminAccessVersion: unknown = 3) {
  vi.mocked(auth).mockResolvedValue({ user: { email, role, adminAccessVersion, allowedPages: null } } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true");
  vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", pilots.join(","));
  vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", undefined);
  vi.stubEnv("SUPER_ADMIN_EMAILS", undefined);
  signedIn();
});
afterEach(() => vi.unstubAllEnvs());

describe("current tutor-scoped class capture pilots", () => {
  it("requires an authenticated email before any database lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 401 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([null, ["/class-capture"], ["/search", "/class-capture"]].map(allowedPages => ({ allowedPages })))("scopes a current admin pilot to one own tutor even with full page grants: $allowedPages", async ({ allowedPages }) => {
    const { queries, selections } = database([[{ ...activeAdmin, allowedPages }], [contact()]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: ["Admin Tutor"] });
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('"admin_users"."email"');
    expect(queries[0].params).toEqual([owner]);
    expect(selections[0]).toEqual(expect.arrayContaining(["disabled", "allowedPages", "accessVersion"]));
    expect(queries[1].sql).toContain('"tutor_contacts"."active"');
    expect(queries[1].sql).toContain('"tutor_contacts"."onsite_email"');
    expect(queries[1].sql).toContain('"tutor_contacts"."online_email"');
    expect(queries[1].sql).not.toContain("display_name");
    expect(queries[1].params).toEqual([true, owner, owner]);
  });

  it.each(pilots.slice(1))("allows teacher pilot %s with no admin row or owner designation", async email => {
    vi.mocked(auth).mockResolvedValue({ user: { email, role: "teacher", allowedPages: ["/progress-tests"] } } as never);
    database([[], [contact(email, email === pilots[1] ? "First Tutor" : "Second Tutor")]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email, keys: [email === pilots[1] ? "First Tutor" : "Second Tutor"] });
  });

  it("normalizes bounded email case and surrounding whitespace without changing identity", async () => {
    signedIn("  ADMIN-PILOT@EXAMPLE.TEST \t");
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", " FIRST-TUTOR@EXAMPLE.TEST, ADMIN-PILOT@EXAMPLE.TEST ");
    database([[activeAdmin], [contact(" ADMIN-PILOT@EXAMPLE.TEST ", "MiXeD Tutor Key")]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: ["MiXeD Tutor Key"] });
  });

  it.each([
    { pilot: "\u212Aeeper@example.test", email: "keeper@example.test", status: 403 },
    { pilot: "keeper@example.test", email: "\u212Aeeper@example.test", status: 401 },
  ])("rejects Unicode case-fold aliases before normalization: $pilot / $email", async ({ pilot, email, status }) => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", pilot);
    signedIn(email);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["tutor@example.test", "teacher"],
    ["admin@example.test", "admin"], ["other-owner@example.test", "admin"],
    ["owner+other@example.test", "admin"], ["owner@example.test.attacker.invalid", "admin"],
    [owner, "parent"], [owner, undefined],
  ])("denies nonpilot or unsupported identity %s/%s before class or tutor queries", async (email, role) => {
    vi.mocked(auth).mockResolvedValue({ user: { email, role, adminAccessVersion: 3, allowedPages: null } } as never);
    database([[activeAdmin], [{ canonicalKey: "Synthetic Tutor", active: true, onsiteEmail: email }]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    "", "   ", "*", "owner", "@example.test", "owner@example", "Owner <owner@example.test>",
    `${owner},${owner}`, `${owner},`, `,${owner}`, `${owner},,first-tutor@example.test`, `${owner};other-owner@example.test`,
    `${owner} other-owner@example.test`, `${owner}\nother-owner@example.test`, "owner..name@example.test",
    "own\u0435r@example.test", "owner@ex\u00e1mple.test", `owner\0@example.test`,
    `${"x".repeat(255)}@example.test`, `${" ".repeat(321)}${owner}`,
    Array.from({ length: 21 }, (_, i) => `pilot-${i}@example.test`).join(","), " ".repeat(6401),
  ])("fails closed for invalid plural configuration even with a valid legacy fallback: %j", async config => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", config);
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", owner);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([undefined, "", `${owner},first-tutor@example.test`, "invalid"])("fails closed when both plural and valid singular configuration are missing: %j", async singular => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", undefined);
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", singular);
    database([[activeAdmin]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("uses the singular compatibility setting only when plural is absent, with the same own-tutor scope", async () => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", undefined);
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", owner);
    database([[activeAdmin], [contact()]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: ["Admin Tutor"] });
  });

  it("does not add the legacy address to a present valid plural allowlist", async () => {
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", pilots[1]);
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAIL", owner);
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

  it.each([activeAdmin, { ...activeAdmin, disabled: true }, { ...activeAdmin, allowedPages: [] }])("denies a teacher session conflicting with any fresh admin row", async admin => {
    signedIn(pilots[1], "teacher", undefined);
    const { queries } = database([[admin], [contact(pilots[1], "First Tutor")]]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(1);
  });

  it.each([
    [], [contact("other@example.test")], [{ ...contact(), active: false }],
    [{ ...contact(), onsiteEmail: null, primaryEmail: owner, displayName: owner }],
    [contact(), contact(owner, "Different Tutor")], [contact(owner, "")],
    [contact(owner, "   ")], [{ ...contact(), onsiteEmail: "\u212Aeeper@example.test" }],
  ].map(rows => ({ rows })))("denies inactive, absent, indirect or ambiguous exact tutor bindings: $rows", async ({ rows }) => {
    const { queries } = database([[activeAdmin], rows]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(2);
  });

  it("accepts an exact online contact binding for the same single canonical tutor", async () => {
    database([[activeAdmin], [{ ...contact(), onsiteEmail: null, onlineEmail: owner }]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: ["Admin Tutor"] });
  });

  it("accepts a current initial zero access version", async () => {
    signedIn(owner, "admin", 0);
    database([[{ ...activeAdmin, accessVersion: 0 }], [contact()]]);
    await expect(requireCaptureScope()).resolves.toEqual({ email: owner, keys: ["Admin Tutor"] });
  });

  it("rechecks database grants, contact bindings and pilot membership on every request", async () => {
    const { queries } = database([[activeAdmin], [contact()], [{ ...activeAdmin, disabled: true }], [activeAdmin], []]);
    await expect(requireCaptureScope()).resolves.toMatchObject({ email: owner });
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("CLASS_CAPTURE_PILOT_EMAILS", pilots[1]);
    await expect(requireCaptureScope()).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(5);
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

  it.each([["other@example.test", "teacher"], ["admin@example.test", "admin"], ["other-owner@example.test", "admin"]])("hides navigation from %s/%s", async (email, role) => {
    signedIn(email, role);
    database([[activeAdmin]]);
    await expect(canUseClassCapture()).resolves.toBe(false);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("shows admin navigation only while the configured pilot's grant remains current", async () => {
    database([[activeAdmin], [contact()], [{ ...activeAdmin, accessVersion: 4 }]]);
    await expect(canUseClassCapture()).resolves.toBe(true);
    await expect(canUseClassCapture()).resolves.toBe(false);
  });

  it("shows teacher navigation without granting any admin page and hides it on contact revocation", async () => {
    signedIn(pilots[1], "teacher", undefined);
    database([[], [contact(pilots[1], "First Tutor")], [], []]);
    await expect(canUseClassCapture()).resolves.toBe(true);
    await expect(canUseClassCapture()).resolves.toBe(false);
  });
});
