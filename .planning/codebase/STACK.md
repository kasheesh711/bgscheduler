# Technology Stack

**Analysis Date:** 2026-04-21

## Languages

**Primary:**
- TypeScript `^5.9.3` — All application code (`src/**/*.ts`, `src/**/*.tsx`)
- SQL (PostgreSQL) — Migrations in `drizzle/0000_tidy_black_bolt.sql`, `drizzle/0001_tough_plazm.sql`; schema defined in `src/lib/db/schema.ts`

**Secondary:**
- CSS (via Tailwind 4 utility classes) — `src/app/globals.css` (single global file, rest is inline utility classes)

## Runtime

**Environment:**
- Node.js (no `.nvmrc`; `tsconfig.json` targets `ES2017` with `lib: ["dom", "dom.iterable", "esnext"]`)
- Vercel Serverless Functions — `maxDuration = 300` seconds configured at `src/app/api/internal/sync-wise/route.ts:7` for the sync endpoint
- Module system: ESM (`"module": "esnext"`, `"moduleResolution": "bundler"` in `tsconfig.json`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present (~469 KB)

## Frameworks

**Core:**
- `next` `16.2.2` — App Router, full-stack React framework
  - Uses `cacheComponents: true` (Next 16 feature) in `next.config.ts`
  - `"use client"` directive used throughout `src/components/**/*.tsx` and `src/app/(app)/**/page.tsx`
  - Middleware at `src/middleware.ts` using Auth.js `auth()` wrapper
  - Dynamic route segments: `src/app/api/auth/[...nextauth]/route.ts`
  - Route groups: `src/app/(app)/` (app shell layout)
  - NOTE: Next.js 16 has breaking changes vs prior training data — consult `node_modules/next/dist/docs/` before editing route or config patterns
- `react` `19.2.4`
- `react-dom` `19.2.4`

**Testing:**
- `vitest` `^4.1.2` — Unit test runner
  - Config: `vitest.config.ts` (environment: `node`, `globals: true`, alias `@` → `./src`)
  - Tests co-located in `__tests__/` directories (e.g., `src/lib/wise/__tests__/`, `src/lib/search/__tests__/`, `src/app/api/data-health/__tests__/`)
  - 82 passing tests per AGENTS.md

**Build/Dev:**
- `next` CLI for `dev`/`build`/`start`
- `tsx` (implicit peer of `drizzle-kit`) used for `db:seed` script
- `drizzle-kit` `^0.31.10` — Schema migrations (`db:generate`, `db:migrate`)

**Styling:**
- `tailwindcss` `^4` — Utility-first CSS (devDep)
- `@tailwindcss/postcss` `^4` — PostCSS plugin (the only plugin in `postcss.config.mjs`)
- `tw-animate-css` `^1.4.0` — Animation utility classes
- `tailwind-merge` `^3.5.0` — Deduplicates conflicting Tailwind classes (used by `cn()` in `src/lib/utils.ts`)
- `class-variance-authority` `^0.7.1` — Variant-based component styling (used in `src/components/ui/*`)
- `clsx` `^2.1.1` — Conditional class helper

**Linting:**
- `eslint` `^9` (flat config at `eslint.config.mjs`)
- `eslint-config-next` `16.2.2` — Extends `core-web-vitals` + `typescript` presets; default ignores re-declared via `globalIgnores` in `eslint.config.mjs`

## Key Dependencies

**Critical:**
- `next-auth` `^5.0.0-beta.30` — Auth.js v5 beta (replaces NextAuth v4). Used at `src/lib/auth.ts` with Google provider and admin allowlist gate. Middleware wrapper: `export default auth((req) => {...})` at `src/middleware.ts`.
- `@auth/drizzle-adapter` `^1.11.1` — Drizzle adapter for Auth.js (present as dependency, though `src/lib/auth.ts` currently uses JWT session strategy with custom `signIn` callback querying `admin_users` directly)
- `drizzle-orm` `^0.45.2` — Type-safe ORM. Schema at `src/lib/db/schema.ts` uses `pgTable`, `pgEnum`, `uuid`, `text`, `boolean`, `timestamp`, `integer`, `jsonb`, `uniqueIndex`, `index` from `drizzle-orm/pg-core`
- `drizzle-kit` `^0.31.10` (devDep) — Migration generator; config at `drizzle.config.ts` (`dialect: "postgresql"`, schema `./src/lib/db/schema.ts`, output `./drizzle`)
- `@neondatabase/serverless` `^1.0.2` — HTTP-based Postgres driver; instantiated at `src/lib/db/index.ts` via `neon(databaseUrl)` then wrapped by `drizzle({ client: sql, schema })` from `drizzle-orm/neon-http`
- `zod` `^4.3.6` — Runtime validation. Env schema at `src/lib/env.ts`; API route body validation (e.g., `src/app/api/compare/route.ts`)

**UI Primitives & Components:**
- `shadcn` `^4.1.2` — CLI/registry tool; config at `components.json` (style `base-nova`, icon library `lucide`, base color `neutral`, CSS vars enabled, RSC enabled)
- `@base-ui/react` `^1.3.0` — Base UI primitives (Popover, Dialog, etc.) wrapped by shadcn components in `src/components/ui/`
- `cmdk` `^1.1.1` — Command palette / searchable combobox (used by tutor search combobox in compare panel)
- `lucide-react` `^1.7.0` — Icon set

**Date/Time & Utilities:**
- `date-fns` `^4.1.0` — Date manipulation (e.g., `addDays` in `src/lib/wise/fetchers.ts`)
- `date-fns-tz` `^3.2.0` — Timezone-aware conversions (used in `src/lib/normalization/timezone.ts` for Asia/Bangkok)
- `uuid` `^13.0.0` — UUID generation
- `@types/uuid` `^10.0.0` (devDep)

**Type Definitions (devDeps):**
- `@types/node` `^20`
- `@types/react` `^19`
- `@types/react-dom` `^19`

## Configuration

**TypeScript — `tsconfig.json`:**
- `strict: true`, `noEmit: true`, `isolatedModules: true`
- `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"`
- `jsx: "react-jsx"`, `incremental: true`
- `plugins: [{ "name": "next" }]` — Next.js TS plugin
- Path alias: `"@/*": ["./src/*"]`
- Includes: `next-env.d.ts`, `**/*.ts`, `**/*.tsx`, `.next/types/**/*.ts`, `.next/dev/types/**/*.ts`, `**/*.mts`

**Next.js — `next.config.ts`:**
- `cacheComponents: true` (Next 16 caching feature)

**PostCSS — `postcss.config.mjs`:**
- `@tailwindcss/postcss` plugin only (no autoprefixer; Tailwind 4 handles this)

**ESLint — `eslint.config.mjs`:**
- Flat config using `defineConfig` from `eslint/config`
- Extends `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`
- `globalIgnores`: `.next/**`, `out/**`, `build/**`, `next-env.d.ts`

**Drizzle — `drizzle.config.ts`:**
- `schema: "./src/lib/db/schema.ts"`
- `out: "./drizzle"`
- `dialect: "postgresql"`
- `dbCredentials.url: process.env.DATABASE_URL`

**Vitest — `vitest.config.ts`:**
- `test.globals: true`, `test.environment: "node"`
- `resolve.alias: { "@": path.resolve(__dirname, "./src") }`

**shadcn — `components.json`:**
- Style: `base-nova`, RSC: `true`, TSX: `true`
- Tailwind CSS file: `src/app/globals.css`, baseColor `neutral`, CSS variables enabled
- Aliases: `@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`
- Icon library: `lucide`

**Vercel — `vercel.json`:**
- Single cron: `path: "/api/internal/sync-wise"`, `schedule: "0 0 * * *"` (daily at midnight UTC)

**Environment:**
- `.env.example` present at repo root — documents 9 required variables
- `.env.local` present (gitignored; contents not inspected)
- Variables loaded via `process.env.*`; centrally validated at startup by `src/lib/env.ts` using Zod
- `.gitignore` present

## NPM Scripts

Defined in `package.json:5-15`:

```bash
npm run dev            # next dev
npm run build          # next build
npm run start          # next start
npm run lint           # eslint
npm test               # vitest run
npm run test:watch     # vitest
npm run db:generate    # drizzle-kit generate
npm run db:migrate     # drizzle-kit migrate
npm run db:seed        # tsx src/lib/db/seed.ts
```

## Platform Requirements

**Development:**
- Node.js (ES2017+ compatible; Next 16 typically requires Node 18.18+ or 20+)
- npm
- PostgreSQL connection (Neon or local) exposed via `DATABASE_URL`
- Google OAuth credentials for auth testing (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`)
- All 9 env vars present (see `src/lib/env.ts`) — app throws at import time if any are missing

**Production:**
- Vercel (Hobby plan — daily cron; upgrade to Pro for 30-minute cron cadence)
- Neon Postgres (region `ap-southeast-1`, host `ep-calm-mud-a1d7pmsi.ap-southeast-1.aws.neon.tech`)
- Vercel Cron — daily `0 0 * * *` at `/api/internal/sync-wise`
- Vercel Serverless Function budget: 300s max duration for sync endpoint
- Production URL: `https://bgscheduler.vercel.app`
- Repo: `https://github.com/kasheesh711/bgscheduler`

---

*Stack analysis: 2026-04-21*
