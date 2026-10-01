import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ health: vi.fn(), mailbox: vi.fn(), refresh: vi.fn(), queue: vi.fn(), dispatch: vi.fn() }));
vi.mock('../nightly-reminder-health', () => ({ loadNightlyReminderHealth: m.health }));
vi.mock('../gmail-credentials', () => ({ feedbackMailboxStatus: m.mailbox, feedbackGmailAccessToken: m.refresh }));
vi.mock('../reminder-line', () => ({ queueReminderAlert: m.queue, dispatchReminderAlerts: m.dispatch }));
import { monitorNightlyReminders } from '../reminder-monitor';
import type { Database } from '@/lib/db';
const db = {} as Database;
beforeEach(() => {
  vi.clearAllMocks(); m.health.mockResolvedValue({ mode: 'live', unresolvedDeliveries: 0, status: 'healthy', detail: 'Batch complete' });
  m.mailbox.mockResolvedValue({ connected: true, refreshedAt: null, lastError: null }); m.refresh.mockResolvedValue('token');
});
describe('nightly watchdog preflight', () => {
  it('renews before 22:00 Bangkok and records authorization failure privately', async () => {
    m.refresh.mockRejectedValueOnce(new Error('revoked'));
    await monitorNightlyReminders(db, new Date('2026-10-01T14:07:00Z'));
    expect(m.refresh).toHaveBeenCalledWith(true, db);
    expect(m.queue).toHaveBeenCalledWith(false, expect.stringContaining('Gmail'), db, expect.any(Date));
    expect(m.dispatch).toHaveBeenCalledWith(db, expect.any(Date));
  });
  it('does not generate a connection alert while the replacement is in shadow', async () => {
    m.health.mockResolvedValue({ mode: 'shadow', unresolvedDeliveries: 0 });
    await monitorNightlyReminders(db, new Date('2026-10-01T14:07:00Z'));
    expect(m.refresh).not.toHaveBeenCalled(); expect(m.queue).not.toHaveBeenCalled();
  });
  it('reports incomplete or unknown deliveries and queues a recovery when healthy', async () => {
    m.health.mockResolvedValueOnce({ mode: 'live', unresolvedDeliveries: 1, status: 'failing', detail: '1 uncertain send' });
    await monitorNightlyReminders(db, new Date('2026-10-01T15:37:00Z'));
    expect(m.queue).toHaveBeenLastCalledWith(false, expect.stringContaining('uncertain'), db, expect.any(Date));
    await monitorNightlyReminders(db, new Date('2026-10-01T16:07:00Z'));
    expect(m.queue).toHaveBeenLastCalledWith(true, expect.any(String), db, expect.any(Date));
  });
});
