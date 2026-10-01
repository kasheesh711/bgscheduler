import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { decryptToken } from "@/lib/sales-dashboard/google-oauth";
import { connectFeedbackMailbox, feedbackGmailAccessToken, feedbackMailboxStatus, sendFeedbackMailboxTest,
  confirmFeedbackMailboxTest, requireFeedbackMailboxReadiness } from "../gmail-credentials";
import { FEEDBACK_MAILBOX, GMAIL_SEND_SCOPE, GmailRejection } from "../gmail";
let handle: Awaited<ReturnType<typeof startTestDb>>;
const db = () => handle.db as unknown as Database;
const state = { verifier: "verifier", origin: "https://bgscheduler.vercel.app", clientId: "dedicated-client", actor: "owner@example.com", state: "state", expires: Date.now() + 600_000 };
const fetchMock = vi.fn();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeAll(async () => { handle = await startTestDb(); }, 120_000);
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await handle.db.delete(schema.postClassEmailConnection);
  vi.stubEnv("AUTH_SECRET", "test-key"); vi.stubEnv("POST_CLASS_GMAIL_CLIENT_ID", "dedicated-client");
  vi.stubEnv("POST_CLASS_GMAIL_CLIENT_SECRET", "secret"); vi.stubEnv("POST_CLASS_GMAIL_WORKSPACE_TRUSTED", "true");
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function consent(email = FEEDBACK_MAILBOX, scope = `openid email ${GMAIL_SEND_SCOPE}`) {
  fetchMock.mockResolvedValueOnce(json({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope }))
    .mockResolvedValueOnce(json({ email, email_verified: true, sub: "google-subject" }));
  return connectFeedbackMailbox("code", state, db());
}
describe("Gmail credential storage and renewal", () => {
  it("pins the mailbox and scope and never stores a different account", async () => {
    await expect(consent("wrong@example.com")).rejects.toThrow();
    expect(await handle.db.select().from(schema.postClassEmailConnection)).toHaveLength(0);
    await expect(consent(FEEDBACK_MAILBOX, "openid email")).rejects.toThrow();
  });
  it("encrypts both tokens separately from other Google connections", async () => {
    await consent();
    const [row] = await handle.db.select().from(schema.postClassEmailConnection);
    expect(row.mailbox).toBe(FEEDBACK_MAILBOX);
    expect(row.refreshTokenCiphertext).not.toContain("refresh-secret");
    expect(decryptToken(row.refreshTokenCiphertext)).toBe("refresh-secret");
    expect(JSON.stringify(await feedbackMailboxStatus(db()))).not.toContain("secret");
  });
  it("serializes an expired token renewal and uses the renewed token for both callers", async () => {
    await consent();
    await handle.db.update(schema.postClassEmailConnection).set({ expiresAt: new Date(0) });
    fetchMock.mockResolvedValueOnce(json({ access_token: "renewed", expires_in: 3600 }));
    const tokens = await Promise.all([feedbackGmailAccessToken(false, db()), feedbackGmailAccessToken(false, db())]);
    expect(tokens).toEqual(["renewed", "renewed"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = String(fetchMock.mock.calls[2][1].body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=dedicated-client");
    expect((await handle.db.select().from(schema.postClassEmailConnection))[0].refreshedAt).toBeTruthy();
  });
  it("persists revocation evidence and prevents a send until reconnected", async () => {
    await consent();
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    await expect(feedbackGmailAccessToken(true, db())).rejects.toMatchObject({ permanent: true, definitelyNotAccepted: true });
    const [row] = await handle.db.select().from(schema.postClassEmailConnection);
    expect(row.lastError).toContain("Reconnect");
    expect(row.expiresAt.getTime()).toBe(0);
    await expect(feedbackGmailAccessToken(false, db())).rejects.toBeInstanceOf(GmailRejection);
  });
  it("a token endpoint outage is safely retryable because no email was submitted", async () => {
    await consent(); fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(feedbackGmailAccessToken(true, db())).rejects.toMatchObject({ permanent: false, definitelyNotAccepted: true });
    fetchMock.mockResolvedValueOnce(json({ access_token: "recovered", expires_in: 3600 }));
    await expect(feedbackGmailAccessToken(true, db())).resolves.toBe("recovered");
    expect((await handle.db.select().from(schema.postClassEmailConnection))[0].lastError).toBeNull();
  });
  it("reconnection changes the revision and invalidates old receipt evidence", async () => {
    await consent();
    await handle.db.update(schema.postClassEmailConnection).set({ testEvidence: { hash: "old", actor: state.actor, binding: "1", expiresAt: new Date().toISOString(), attempts: 0 } }).where(eq(schema.postClassEmailConnection.id, "gmail"));
    await consent();
    const [row] = await handle.db.select().from(schema.postClassEmailConnection);
    expect(row.revision).toBe(2); expect(row.testEvidence).toBeNull(); expect(row.refreshedAt).toBeNull();
  });
  it("requires inbox proof on the current grant, independently of Google's acceptance", async () => {
    await consent();
    fetchMock.mockResolvedValueOnce(json({ access_token: "renewed", expires_in: 3600 })).mockResolvedValueOnce(json({ id: "gmail-test-id" }));
    const result = await sendFeedbackMailboxTest(state.actor, db());
    expect(result.accepted).toBe(true);
    await expect(requireFeedbackMailboxReadiness(db(), new Date())).rejects.toThrow();
    const raw = JSON.parse(fetchMock.mock.calls.at(-1)![1].body).raw;
    const mime = Buffer.from(raw, "base64url").toString();
    const part = mime.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/)![1];
    const code = Buffer.from(part, "base64").toString().match(/code is ([A-F0-9]{16})/)![1];
    expect(JSON.stringify(result)).not.toContain(code);
    await expect(confirmFeedbackMailboxTest(state.actor, "wrong", db())).rejects.toThrow();
    expect((await handle.db.select().from(schema.postClassEmailConnection))[0].testEvidence?.attempts).toBe(1);
    await confirmFeedbackMailboxTest(state.actor, code, db());
    await expect(requireFeedbackMailboxReadiness(db(), new Date())).resolves.toBeUndefined();
    await consent();
    await expect(confirmFeedbackMailboxTest(state.actor, code, db())).rejects.toThrow();
    await expect(requireFeedbackMailboxReadiness(db(), new Date())).rejects.toThrow();
  });
});
