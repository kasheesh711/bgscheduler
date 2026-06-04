// Auth.js (NextAuth v5) module augmentation.
//
// Adds the page-level access-control claim used by middleware and server
// guards. `allowedPages` is null for full-access admins (all existing admins
// unchanged) and a list of allowed route prefixes for restricted users.
//
// NOTE: the `JWT` import + re-export below is load-bearing. `next-auth/jwt`
// re-exports its `JWT` interface from a nested `@auth/core/jwt`; without forcing
// that module to load here, the `declare module "next-auth/jwt"` augmentation
// does not merge into the `JWT` type the `jwt`/`session` callbacks see. Do not
// remove it.

import type { DefaultSession } from "next-auth";
import type { JWT } from "next-auth/jwt";

export type { JWT };

declare module "next-auth" {
  interface Session {
    user: {
      allowedPages?: string[] | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    allowedPages?: string[] | null;
  }
}
