import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), status: vi.fn(), line: vi.fn(), test: vi.fn(), lineTest: vi.fn(), confirm: vi.fn(), lineConfirm: vi.fn(), renew: vi.fn(), connect: vi.fn(), finish: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/post-class-feedback/access', () => ({ requirePostClassCapability: m.access, PostClassAccessError: class extends Error {} }));
vi.mock('@/lib/post-class-feedback/gmail-credentials', () => ({ assertFeedbackConnectionPaused: vi.fn(), feedbackMailboxStatus: m.status, sendFeedbackMailboxTest: m.test, confirmFeedbackMailboxTest: m.confirm, feedbackGmailAccessToken: m.renew, connectFeedbackMailbox: m.finish }));
vi.mock('@/lib/post-class-feedback/gmail-connection', () => ({ beginFeedbackEmailOAuth: m.connect, verifyFeedbackEmailState: m.verify, FEEDBACK_OAUTH_COOKIE: 'feedback_gmail_oauth', FEEDBACK_OAUTH_PATH: '/api/post-class-feedback/email/callback' }));
vi.mock('@/lib/post-class-feedback/reminder-line', () => ({ reminderLineStatus: m.line, sendReminderLineTest: m.lineTest, confirmReminderLineTest: m.lineConfirm, resolveReminderAlert: vi.fn() }));
import { GET, POST } from '../route';
import { GET as callback } from '../callback/route';
const origin = 'https://bgscheduler.vercel.app';
const request = (body: unknown, requestOrigin = origin) => new NextRequest(origin + '/api/post-class-feedback/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); m.access.mockResolvedValue({ email: 'owner@example.com' }); m.status.mockResolvedValue({ connected: false }); m.line.mockResolvedValue({ verified: false });
  m.connect.mockReturnValue({ url: 'https://accounts.google.com/test', cookie: 'encrypted-state' });
  m.verify.mockReturnValue({ origin, actor: 'owner@example.com' });
});
describe('feedback mailbox controls', () => {
  it('requires access-manager permission on status, tests and callback', async () => {
    m.access.mockRejectedValue(new Error('Forbidden'));
    expect((await GET()).status).toBe(403);
    expect((await POST(request({ action: 'test' }))).status).toBe(403);
    expect((await callback(new NextRequest(origin + '/api/post-class-feedback/email/callback?code=code&state=state'))).status).toBe(403);
    expect(m.test).not.toHaveBeenCalled(); expect(m.finish).not.toHaveBeenCalled();
    expect(m.access).toHaveBeenCalledWith('access_manager');
  });
  it('rejects cross-origin state changes before contacting providers', async () => {
    expect((await POST(request({ action: 'test' }, 'https://elsewhere.example'))).status).toBe(400);
    expect(m.test).not.toHaveBeenCalled();
  });
  it('sets an encrypted HttpOnly callback cookie and scopes tests to the signed-in manager', async () => {
    const response = await POST(request({ action: 'connect' }));
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    await POST(request({ action: 'test' })); expect(m.test).toHaveBeenCalledWith('owner@example.com');
  });
  it('verifies actor-bound OAuth state and consumes its cookie on the callback', async () => {
    const response = await callback(new NextRequest(origin + '/api/post-class-feedback/email/callback?code=code&state=state', { headers: { cookie: 'feedback_gmail_oauth=encrypted-state' } }));
    expect(m.verify).toHaveBeenCalledWith('encrypted-state', 'state', 'owner@example.com');
    expect(m.finish).toHaveBeenCalledWith('code', expect.objectContaining({ actor: 'owner@example.com' }));
    expect(response.status).toBe(307); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
