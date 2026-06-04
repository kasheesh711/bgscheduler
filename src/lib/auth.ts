import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getDb } from "@/lib/db";
import { adminUsers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function signInCallback({
  user,
}: {
  user: { email?: string | null };
}): Promise<boolean> {
  const email = user.email?.trim().toLowerCase();
  if (!email) return false;

  const db = getDb();
  const allowed = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  return allowed.length > 0;
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
      // `user` is only present at sign-in; resolve allowedPages once and persist
      // it on the token so subsequent requests need no DB call.
      if (user) {
        const email = user.email?.trim().toLowerCase();
        if (email) {
          const db = getDb();
          const rows = await db
            .select({ allowedPages: adminUsers.allowedPages })
            .from(adminUsers)
            .where(eq(adminUsers.email, email))
            .limit(1);
          token.allowedPages = rows[0]?.allowedPages ?? null;
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.allowedPages = token.allowedPages ?? null;
      return session;
    },
  },
});
