import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { admissionsCohorts, admissionsStudents, admissionsCases, admissionsCaseMembers, authEmailChallenges, authEmailRateLimits } from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { canRequestEmailCode, EmailCodeLimitError, requestEmailCode, verifyEmailCode } from "../email-code";
import { resolveUserAccess } from "@/lib/auth-access";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const email = "apivit.s@hotmail.com", start = new Date("2026-09-16T03:00:00Z");
const send = vi.fn<(email: string, code: string, id: string) => Promise<void>>().mockResolvedValue(undefined);
const eligible = vi.fn(async () => true);
const request = (binding?: string, ip = "127.0.0.1") => new Request("https://test.local/api/auth/callback/email-code", { headers: { "x-vercel-forwarded-for": ip, ...(binding ? { cookie: "bgs-email-code=" + binding } : {}) } });
async function issue(at = start, address = email) {
  const issued = await requestEmailCode(address, request(), { db, now: at, send, eligible });
  return { ...issued, email: address, code: send.mock.calls.at(-1)?.[1] ?? "000000" };
}
async function verify(issued: Awaited<ReturnType<typeof issue>>, overrides: Record<string, unknown> = {}, now = start) {
  return verifyEmailCode({ email: issued.email, code: issued.code, challengeId: issued.challengeId, ...overrides }, request(issued.binding), { db, now, eligible });
}
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", "isolated-email-code-test-key"); vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "true"); vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  send.mockClear(); send.mockResolvedValue(undefined); eligible.mockReset(); eligible.mockResolvedValue(true);
  await db.delete(authEmailChallenges); await db.delete(authEmailRateLimits);
});
describe("email codes with real PostgreSQL transactions", () => {
  it("signs in a normalized Hotmail address exactly once and stores no plaintext code", async () => {
    const issued = await issue();
    const [stored] = await db.select().from(authEmailChallenges);
    expect(stored.codeHash).not.toBe(issued.code); expect(stored.bindingHash).not.toBe(issued.binding);
    expect(await verify(issued, { email: " Apivit.S@Hotmail.com " })).toMatchObject({ email });
    expect(await verify(issued)).toBeNull();
  });
  it("permits the existing Ek sit-in grant without creating an admin", async () => {
    vi.stubEnv("TUTOR_SIT_INS_ENABLED", "true");
    expect(await canRequestEmailCode(email, db)).toBe(true);
    expect(await resolveUserAccess(email, db)).toMatchObject({ role: "teacher", allowedPages: ["/tutor-sit-ins"] });
  });
  it("rejects expired codes and browser mismatches", async () => {
    const issued = await issue();
    expect(await verifyEmailCode(issued, request("b".repeat(43)), { db, now: start, eligible })).toBeNull();
    expect(await verify(issued, {}, new Date(start.getTime() + 600_000))).toBeNull();
  });
  it("exhausts five wrong attempts even under concurrency", async () => {
    const issued = await issue(), bad = issued.code === "999999" ? "888888" : "999999";
    await Promise.all(Array.from({ length: 5 }, () => verify(issued, { code: bad })));
    expect(await verify(issued)).toBeNull();
    expect((await db.select().from(authEmailChallenges))[0].attempts).toBe(5);
  });
  it("allows only one concurrent successful verification", async () => {
    const issued = await issue();
    const results = await Promise.all([verify(issued), verify(issued), verify(issued)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("enforces resend cooldown, supersedes old codes, and serializes requests", async () => {
    const first = await issue();
    await expect(issue()).rejects.toBeInstanceOf(EmailCodeLimitError);
    const now = new Date(start.getTime() + 60_001);
    const results = await Promise.allSettled([issue(now), issue(now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await verify(first, {}, now)).toBeNull();
  });
  it("commits email and IP limits across requests", async () => {
    for (let i = 0; i < 5; i++) await issue(new Date(start.getTime() + i * 60_001));
    await expect(issue(new Date(start.getTime() + 5 * 60_001))).rejects.toBeInstanceOf(EmailCodeLimitError);
    await db.delete(authEmailRateLimits); await db.delete(authEmailChallenges);
    for (let i = 0; i < 50; i++) await issue(start, `person${i}@example.test`);
    await expect(issue(start, "another@example.test")).rejects.toBeInstanceOf(EmailCodeLimitError);
  });
  it("applies verification IP limits to malformed guesses too", async () => {
    const issued = await issue();
    for (let i = 0; i < 100; i++) await verifyEmailCode({}, request(), { db, now: start, eligible });
    expect(await verify(issued)).toBeNull();
  });
  it("sends nothing for unapproved addresses and rejects revoked access", async () => {
    eligible.mockResolvedValue(false); const unknown = await issue(); expect(send).not.toHaveBeenCalled(); expect(await verify(unknown)).toBeNull();
    eligible.mockResolvedValue(true); const issued = await issue(new Date(start.getTime() + 60_001));
    eligible.mockResolvedValue(false); expect(await verify(issued, {}, new Date(start.getTime() + 60_002))).toBeNull();
  });
  it("invalidates codes when delivery fails without exposing eligibility", async () => {
    send.mockRejectedValue(new Error("private-provider-details"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { const issued = await issue(); expect(issued.challengeId).toBeTruthy(); expect(await verify(issued)).toBeNull(); expect(log).toHaveBeenCalledWith("Email login delivery or eligibility failed"); }
    finally { log.mockRestore(); }
  });
  it("fails closed on disablement and previews", async () => {
    const issued = await issue(); vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "false"); expect(await verify(issued)).toBeNull();
    vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "true"); vi.stubEnv("VERCEL_ENV", "preview"); expect(await verify(issued)).toBeNull();
  });
  it("does not send for a disabled admin even with a sit-in grant", async () => {
    await db.execute(sql`insert into admin_users (email, name, disabled) values (${email}, 'Test', true)`);
    try { expect(await canRequestEmailCode(email, db)).toBe(false); }
    finally { await db.execute(sql`delete from admin_users where email = ${email}`); }
  });
  it("allows pending admissions invitations without activating them during request or verification", async () => {
    const [cohort] = await db.insert(admissionsCohorts).values({ name: "Email login test", graduationYear: 2027 }).returning();
    const [student] = await db.insert(admissionsStudents).values({ fullName: "Test Learner", studentEmail: "invitee@example.test", cohortId: cohort.id }).returning();
    const [caseRow] = await db.insert(admissionsCases).values({ studentId: student.id, cohortId: cohort.id }).returning();
    const [member] = await db.insert(admissionsCaseMembers).values({ caseId: caseRow.id, email: student.studentEmail, role: "student", status: "invited" }).returning();
    try {
      const issued = await requestEmailCode(student.studentEmail, request(), { db, now: start, send });
      const code = send.mock.calls.at(-1)![1];
      expect(await verifyEmailCode({ email: student.studentEmail, code, challengeId: issued.challengeId }, request(issued.binding), { db, now: start })).toMatchObject({ email: student.studentEmail });
      expect((await db.select().from(admissionsCaseMembers).where(eq(admissionsCaseMembers.id, member.id)))[0].status).toBe("invited");
    } finally {
      await db.delete(admissionsCaseMembers).where(eq(admissionsCaseMembers.id, member.id));
      await db.delete(admissionsCases).where(eq(admissionsCases.id, caseRow.id));
      await db.delete(admissionsStudents).where(eq(admissionsStudents.id, student.id));
      await db.delete(admissionsCohorts).where(eq(admissionsCohorts.id, cohort.id));
    }
  });
});
