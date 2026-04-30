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
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    signIn: signInCallback,
    async session({ session }) {
      return session;
    },
  },
});
