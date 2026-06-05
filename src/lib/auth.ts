import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { resolveUserAccess } from "@/lib/auth-access";

export async function signInCallback({
  user,
}: {
  user: { email?: string | null };
}): Promise<boolean> {
  // Admins (admin_users) and teachers (matched to an active tutor contact) may
  // sign in; everyone else is denied. See resolveUserAccess.
  const access = await resolveUserAccess(user.email);
  return access !== null;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope: "openid email profile https://www.googleapis.com/auth/spreadsheets",
          access_type: "offline",
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
      const allowed = await signInCallback({ user });
      if (allowed && user.email) {
        const { storeGoogleOAuthTokenForUser } = await import("@/lib/sales-dashboard/google-oauth");
        await storeGoogleOAuthTokenForUser(user.email, account);
      }
      return allowed;
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
