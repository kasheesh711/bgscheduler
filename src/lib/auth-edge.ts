import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { googleAuthorizationParams } from "@/lib/preview-policy";

export const { auth: edgeAuth } = NextAuth({
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
    async jwt({ token }) {
      // Edge runtime: no DB access. The Node `jwt` callback (src/lib/auth.ts)
      // sets `allowedPages` at sign-in; here we only pass the token through.
      return token;
    },
    async session({ session, token }) {
      session.user.allowedPages = token.allowedPages ?? null;
      session.user.role = token.role ?? null;
      session.user.adminAccessVersion = token.adminAccessVersion;
      return session;
    },
  },
});
