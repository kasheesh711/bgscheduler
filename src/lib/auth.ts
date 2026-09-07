import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { resolveUserAccess } from "@/lib/auth-access";
import { validateSessionAccess } from "@/lib/auth-session";
import { googleAuthorizationParams, shouldStoreGoogleIntegrationTokens } from "@/lib/preview-policy";

export async function signInCallback({
  user,
}: {
  user: { email?: string | null };
}): Promise<boolean> {
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

  // Admins (admin_users), admissions counselors, teachers (matched to an active
  // tutor contact), and admissions case members (students/parents) may sign in;
  // everyone else is denied. See resolveUserAccess.
  const access = await resolveUserAccess(user.email);
  return access !== null;
}

export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: googleAuthorizationParams(),
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ user, account }) {
      const allowed = await signInCallback({ user });
      if (allowed && user.email && shouldStoreGoogleIntegrationTokens()) {
        const { storeGoogleOAuthTokenForUser } = await import("@/lib/sales-dashboard/google-oauth");
        await storeGoogleOAuthTokenForUser(user.email, account);
      }
      return allowed;
    },
    async jwt({ token, user }) {
      // Only sign-in sets the version. A normal JWT refresh must never revive
      // stale or legacy access by copying a newer database version.
      if (user) {
        const access = await resolveUserAccess(user.email);
        token.allowedPages = access?.allowedPages ?? null;
        token.role = access?.role ?? null;
        token.adminAccessVersion = access?.adminAccessVersion;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.allowedPages = token.allowedPages ?? null;
      session.user.role = token.role ?? null;
      session.user.adminAccessVersion = token.adminAccessVersion;
      return session;
    },
  },
} satisfies NextAuthConfig;

const nextAuth = NextAuth(authConfig);
export const { handlers, signIn, signOut } = nextAuth;

/** Independent server guard, including manual cron handlers that bypass Proxy. */
export async function auth() {
  return validateSessionAccess(await nextAuth.auth());
}
