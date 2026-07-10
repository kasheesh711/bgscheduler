import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { resolveUserAccess, type UserAccess } from "@/lib/auth-access";

/** Ordinary sign-in proves identity only; Sheets consent is requested in-context. */
export const GOOGLE_IDENTITY_SCOPE = "openid email profile";

const GOOGLE_SHEETS_SCOPES = new Set([
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
]);

interface GoogleOAuthAccountLike {
  provider?: string;
  scope?: string;
}

/**
 * Google tokens are persisted only after an explicit Sheets consent flow by
 * staff. A student/parent cannot turn a crafted OAuth request into stored
 * access to their Google data, and identity-only sign-ins never write a token.
 */
export function shouldPersistGoogleSheetsToken(
  access: UserAccess,
  account: GoogleOAuthAccountLike | null | undefined,
): boolean {
  if (access.role !== "admin" && access.role !== "counselor") return false;
  if (account?.provider !== "google") return false;
  const scopes = new Set(String(account.scope ?? "").split(/\s+/).filter(Boolean));
  return [...GOOGLE_SHEETS_SCOPES].some((scope) => scopes.has(scope));
}

async function resolveSignInAccess({
  user,
}: {
  user: { email?: string | null };
}): Promise<UserAccess | null> {
  // Admissions invite activation (PRD §3.7): an exact-email sign-in flips the
  // email's invited/bounced case memberships to "active" BEFORE access
  // resolution, so a freshly invited student/parent passes the active-only
  // membership filters on this very sign-in. Failures are logged and never
  // block sign-in for existing users; an invited-only user whose activation
  // failed is still denied below (fail-closed).
  if (user.email) {
    try {
      const { activateMembershipsForEmail } = await import("@/lib/admissions/members");
      await activateMembershipsForEmail(user.email);
    } catch (error) {
      console.error("Failed to activate admissions memberships at sign-in", error);
    }
  }

  return resolveUserAccess(user.email);
}

export async function signInCallback({
  user,
}: {
  user: { email?: string | null };
}): Promise<boolean> {
  // Admins (admin_users), admissions counselors, teachers (matched to an active
  // tutor contact), and admissions case members (students/parents) may sign in;
  // everyone else is denied. See resolveUserAccess.
  return (await resolveSignInAccess({ user })) !== null;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope: GOOGLE_IDENTITY_SCOPE,
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ user, account }) {
      const access = await resolveSignInAccess({ user });
      if (!access) return false;
      if (user.email && shouldPersistGoogleSheetsToken(access, account)) {
        const { storeGoogleOAuthTokenForUser } = await import("@/lib/sales-dashboard/google-oauth");
        await storeGoogleOAuthTokenForUser(user.email, account);
      }
      return true;
    },
    async jwt({ token, user }) {
      // `user` is only present at sign-in; resolve role + allowedPages once and
      // persist them on the token so subsequent requests need no DB call.
      if (user) {
        const access = await resolveUserAccess(user.email);
        token.allowedPages = access?.allowedPages ?? null;
        token.role = access?.role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.allowedPages = token.allowedPages ?? null;
      session.user.role = token.role ?? null;
      return session;
    },
  },
});
