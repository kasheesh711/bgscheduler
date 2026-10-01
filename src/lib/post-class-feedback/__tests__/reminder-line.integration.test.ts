import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sendReminderLineTest, confirmReminderLineTest, reminderLineStatus, queueReminderAlert, dispatchReminderAlerts, resolveReminderAlert } from "../reminder-line";
let handle: Awaited<ReturnType<typeof startTestDb>>;
const db = () => handle.db as unknown as Database;
const recipient = 'U' + 'a'.repeat(32);
const actor = 'kevin@example.com';
const fetchMock = vi.fn();
const accepted = () => new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-accepted-id' } });
const now = new Date('2026-10-01T14:00:00Z');
beforeAll(async () => { handle = await startTestDb(); }, 120_000);
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await handle.db.delete(schema.postClassReminderAlerts); await handle.db.delete(schema.postClassReminderLineChannel);
  await handle.db.update(schema.postClassSettings).set({ reminderMode: 'shadow' });
  vi.stubEnv('POST_CLASS_REMINDER_LINE_USER_ID', recipient); vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'test-token');
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset().mockImplementation(accepted);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function verify() {
  await sendReminderLineTest(actor, db());
  const payload = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  expect(payload.to).toBe(recipient);
  const code = payload.messages[0].text.match(/code is ([A-F0-9]{16})/)[1];
  await confirmReminderLineTest(actor, code, db()); fetchMock.mockClear();
}
describe('private reminder alerts', () => {
  it('preserves private alert readiness when a new test is requested during live mode', async () => {
    await verify();
    await handle.db.insert(schema.postClassSettings).values({ id: 'default', reminderMode: 'live' })
      .onConflictDoUpdate({ target: schema.postClassSettings.id, set: { reminderMode: 'live' } });
    await expect(sendReminderLineTest(actor, db())).rejects.toThrow(/Pause reminders/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await reminderLineStatus(db())).verified).toBe(true);
    await queueReminderAlert(false, 'Failed batch', db(), now);
    expect(await dispatchReminderAlerts(db(), now)).toBe(true);
  });
  it('requires the generic private receipt test, rejects group IDs and invalidates changed destinations', async () => {
    expect((await reminderLineStatus(db())).verified).toBe(false);
    await queueReminderAlert(false, 'Private operational detail', db(), now);
    expect(await handle.db.select().from(schema.postClassReminderAlerts)).toHaveLength(0);
    await verify(); expect((await reminderLineStatus(db())).verified).toBe(true);
    vi.stubEnv('POST_CLASS_REMINDER_LINE_USER_ID', 'U' + 'b'.repeat(32));
    expect((await reminderLineStatus(db())).verified).toBe(false);
    vi.stubEnv('POST_CLASS_REMINDER_LINE_USER_ID', 'C' + 'a'.repeat(32));
    await expect(sendReminderLineTest(actor, db())).rejects.toThrow();
  });
  it('deduplicates persistent incidents and sends a separate recovery', async () => {
    await verify();
    await Promise.all([queueReminderAlert(false, 'Gmail unavailable', db(), now), queueReminderAlert(false, 'Gmail unavailable', db(), now)]);
    await Promise.all([dispatchReminderAlerts(db(), now), dispatchReminderAlerts(db(), now)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await queueReminderAlert(false, 'Still unavailable', db(), now);
    await dispatchReminderAlerts(db(), now); expect(fetchMock).toHaveBeenCalledTimes(1);
    await queueReminderAlert(true, 'Nightly batch complete', db(), now);
    await dispatchReminderAlerts(db(), now); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[0].text).toContain('recovered');
  });
  it('retries a lost response with the same LINE key and treats confirmed replay as acceptance', async () => {
    await verify(); await queueReminderAlert(false, 'Failed batch', db(), now);
    fetchMock.mockRejectedValueOnce(new Error('lost response'));
    await dispatchReminderAlerts(db(), now);
    expect((await reminderLineStatus(db())).alertError).toBeTruthy();
    const key = fetchMock.mock.calls[0][1].headers['X-Line-Retry-Key'];
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'original-receipt' } }));
    await dispatchReminderAlerts(db(), new Date(now.getTime() + 31 * 60_000));
    expect(fetchMock.mock.calls[1][1].headers['X-Line-Retry-Key']).toBe(key);
    expect((await reminderLineStatus(db())).alertError).toBeNull();
    expect((await handle.db.select().from(schema.postClassReminderAlerts))[0].receipt).toBe('original-receipt');
  });
  it('unblocks subsequent alerts after audited reconciliation of an expired send', async () => {
    await verify(); await queueReminderAlert(false, 'Failed batch', db(), now);
    fetchMock.mockRejectedValueOnce(new Error('lost response')); await dispatchReminderAlerts(db(), now);
    const later = new Date(now.getTime() + 24 * 60 * 60_000);
    await dispatchReminderAlerts(db(), later);
    const [blocked] = await handle.db.select().from(schema.postClassReminderAlerts);
    await queueReminderAlert(true, 'Recovered', db(), later);
    await resolveReminderAlert(actor, { id: blocked.id, expectedAttempts: blocked.attempts, outcome: 'not_sent', note: 'Kevin checked the private chat and confirmed no message arrived.' }, db());
    await dispatchReminderAlerts(db(), later);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await reminderLineStatus(db())).alertError).toBeNull();
    const history = await handle.db.select().from(schema.postClassConfigAuditLog);
    expect(history.some(row => row.action === 'resolve_not_sent')).toBe(true);
  });
  it('does not reuse an uncertain retry key beyond LINE’s deduplication window', async () => {
    await verify(); await queueReminderAlert(false, 'Failed batch', db(), now);
    fetchMock.mockRejectedValueOnce(new Error('lost response')); await dispatchReminderAlerts(db(), now);
    await dispatchReminderAlerts(db(), new Date(now.getTime() + 24 * 60 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await reminderLineStatus(db())).alertError).toContain('reconciliation');
  });
});
