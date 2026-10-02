import { NextRequest, NextResponse } from 'next/server';
import { requirePostClassCapability } from '@/lib/post-class-feedback/access';
import { postClassFeedbackErrorResponse } from '@/lib/post-class-feedback/api';
import { PostClassValidationError } from '@/lib/post-class-feedback/errors';
import { FEEDBACK_OAUTH_COOKIE, FEEDBACK_OAUTH_PATH, verifyFeedbackEmailState } from '@/lib/post-class-feedback/gmail-connection';
import { connectFeedbackMailbox } from '@/lib/post-class-feedback/gmail-credentials';

export const maxDuration = 120;
export async function GET(request: NextRequest) {
  let response: NextResponse;
  try {
    const actor = await requirePostClassCapability('access_manager');
    const state = verifyFeedbackEmailState(request.cookies.get(FEEDBACK_OAUTH_COOKIE)?.value ?? '', request.nextUrl.searchParams.get('state') ?? '', actor.email);
    const error = request.nextUrl.searchParams.get('error');
    if (error) {
      const reason = ['access_denied', 'admin_policy_enforced', 'org_internal', 'invalid_scope', 'temporarily_unavailable'].includes(error) ? error : 'authorization_failed';
      throw new PostClassValidationError(`Google authorization failed (${reason}). Check Workspace approval and connect again.`);
    }
    const code = request.nextUrl.searchParams.get('code');
    if (!code) throw new PostClassValidationError('Google did not return an authorization code.');
    await connectFeedbackMailbox(code, state);
    response = NextResponse.redirect(new URL('/post-class-feedback?gmail=connected', state.origin));
  } catch (error) { response = postClassFeedbackErrorResponse('GET feedback/email/callback', error, 'Gmail authorization could not be completed. Return to Class Feedback and connect again.'); }
  response.cookies.set(FEEDBACK_OAUTH_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: FEEDBACK_OAUTH_PATH, maxAge: 0 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
