import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePostClassCapability } from '@/lib/post-class-feedback/access';
import { postClassFeedbackErrorResponse } from '@/lib/post-class-feedback/api';
import { PostClassValidationError } from '@/lib/post-class-feedback/errors';
import { beginFeedbackEmailOAuth, FEEDBACK_OAUTH_COOKIE, FEEDBACK_OAUTH_PATH } from '@/lib/post-class-feedback/gmail-connection';
import { feedbackMailboxStatus, feedbackGmailAccessToken, sendFeedbackMailboxTest, confirmFeedbackMailboxTest } from '@/lib/post-class-feedback/gmail-credentials';
import { reminderLineStatus, sendReminderLineTest, confirmReminderLineTest } from '@/lib/post-class-feedback/reminder-line';

export const maxDuration = 120;
const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect') }), z.object({ action: z.literal('renew') }),
  z.object({ action: z.literal('test') }), z.object({ action: z.literal('line_test') }),
  z.object({ action: z.literal('confirm'), code: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('line_confirm'), code: z.string().trim().min(1).max(64) }),
]);
export async function GET() {
  try {
    await requirePostClassCapability('access_manager');
    const [mailbox, line] = await Promise.all([feedbackMailboxStatus(), reminderLineStatus()]);
    return NextResponse.json({ mailbox, line }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return postClassFeedbackErrorResponse('GET feedback/email', error, 'Could not load the reminder connection.'); }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability('access_manager');
    if (request.headers.get('origin') !== request.nextUrl.origin) throw new PostClassValidationError('Use the Class Feedback page to manage this connection.');
    const input = Action.parse(await request.json());
    if (input.action === 'connect') {
      const { url, cookie } = beginFeedbackEmailOAuth(actor.email, request.nextUrl.origin);
      const response = NextResponse.json({ url });
      response.cookies.set(FEEDBACK_OAUTH_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: 'lax', path: FEEDBACK_OAUTH_PATH, maxAge: 600 });
      return response;
    }
    if (input.action === 'renew') { await feedbackGmailAccessToken(true); return NextResponse.json({ renewed: true }); }
    if (input.action === 'test') return NextResponse.json(await sendFeedbackMailboxTest(actor.email));
    if (input.action === 'line_test') return NextResponse.json(await sendReminderLineTest(actor.email));
    if (input.action === 'confirm') return NextResponse.json(await confirmFeedbackMailboxTest(actor.email, input.code));
    return NextResponse.json(await confirmReminderLineTest(actor.email, input.code));
  } catch (error) { return postClassFeedbackErrorResponse('POST feedback/email', error, 'Could not complete the connection action. Check the connection status and try again.'); }
}
