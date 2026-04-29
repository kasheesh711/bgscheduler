# Technology Stack

**Analysis Date:** 2026-04-29

## Languages

**Primary:**
- TypeScript ^5.9.3 - All application code in `src/**/*.ts` and `src/**/*.tsx`
- SQL (PostgreSQL) - Database schema migrations in `drizzle/` (`0000_tidy_black_bolt.sql`, `0001_tough_plazm.sql`, `0002_past_session_blocks.sql`)

**Secondary:**
- JavaScript (config only) - Module config files (`postcss.config.mjs`, `eslint.config.mjs`)

## Runtime

**Environment:**
- Node.js (no `.nvmrc` present) - Local development and Vercel build
- Vercel Serverless Functions - Production runtime
- TypeScript target: ES2017 (`tsconfig.json` line 3)
- Module: esnext, moduleResolution: bundler (`tsconfig.json` lines 10-11)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js 16.2.2 - App Router framework (`package.json` line 27)
  - `cacheComponents: true` enabled in `next.config.ts` line 4
  - Uses `next/cache` `cacheTag`/`cacheLife`/`revalidateTag` APIs (`src/lib/data/filters.ts`, `src/lib/data/tutors.ts`, `src/lib/data/past-sessions.ts`)
  - App Router structure under `src/app/` with route groups `(app)` and dynamic routes
- React 19.2.4 - UI library (`package.json` line 29)
- React DOM 19.2.4 - Browser rendering (`package.json` line 30)

**Testing:**
- Vitest ^4.1.2 - Unit test runner (`package.json` line 48)
  - Config: `vitest.config.ts` (line 1-15)
  - Environment: `node` (line 7)
  - Globals enabled (line 6)
  - Path alias `@` → `./src` (lines 9-13)

**Build/Dev:**
- Tailwind CSS ^4 - Styling framework via `@tailwindcss/postcss` plugin (`package.json` lines 38, 46)
- PostCSS - CSS processing (`postcss.config.mjs`)
- ESLint ^9 - Linting (`package.json` line 44)
  - Config: `eslint.config.mjs` (flat config)
  - Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
- TypeScript ^5.9.3 - Type checking (`package.json` line 47, `tsconfig.json`)
  - Strict mode enabled (line 7)
  - JSX: react-jsx (line 14)
  - Incremental compilation (line 16)

## Key Dependencies

**Critical:**
- `next-auth` ^5.0.0-beta.30 - Authentication via Auth.js v5 beta with Google provider (`src/lib/auth.ts`)
- `@auth/drizzle-adapter` ^1.11.1 - Drizzle adapter for Auth.js (declared in `package.json` line 17, not currently imported in `src/`)
- `drizzle-orm` ^0.45.2 - Type-safe ORM for PostgreSQL (`src/lib/db/schema.ts`, `src/lib/db/index.ts`)
- `drizzle-kit` ^0.31.10 - Schema generation/migrations (`drizzle.config.ts`, `package.json` line 43)
- `@neondatabase/serverless` ^1.0.2 - Neon serverless Postgres HTTP driver (`src/lib/db/index.ts` line 1)
- `zod` ^4.3.6 - Runtime schema validation (`src/lib/env.ts`, API route bodies)

**UI Component System:**
- `shadcn` ^4.1.2 - shadcn CLI (`package.json` line 31)
  - Config: `components.json` (style: `base-nova`, baseColor: `neutral`)
  - RSC support enabled
- `@base-ui/react` ^1.3.0 - Base UI primitives wrapping shadcn components (`src/components/ui/*.tsx`)
- `cmdk` ^1.1.1 - Command palette / searchable combobox (`src/components/ui/command.tsx`)
- `lucide-react` ^1.7.0 - Icon library (`src/components/ui/dialog.tsx`, `src/components/ui/select.tsx`, etc.)
- `class-variance-authority` ^0.7.1 - Variant-based component styling (`src/components/ui/button.tsx`, `tabs.tsx`, `badge.tsx`)
- `clsx` ^2.1.1 - Conditional className utility (`src/lib/utils.ts` line 1)
- `tailwind-merge` ^3.5.0 - Tailwind class deduplication (`src/lib/utils.ts` line 2)
- `tw-animate-css` ^1.4.0 - Tailwind animation utilities

**Data/Date Utilities:**
- `date-fns` ^4.1.0 - Date manipulation (`src/lib/wise/fetchers.ts` line 10)
- `date-fns-tz` ^3.2.0 - Timezone-aware operations for Asia/Bangkok (`src/lib/normalization/timezone.ts`)
- `uuid` ^13.0.0 - UUID generation
- `@types/uuid` ^10.0.0 - Type definitions

**Type Definitions (devDependencies):**
- `@types/node` ^20
- `@types/react` ^19
- `@types/react-dom` ^19

## Configuration

**TypeScript (`tsconfig.json`):**
- Strict mode enabled
- Target: ES2017
- Module: esnext, moduleResolution: bundler
- Path alias: `@/*` → `./src/*` (line 22)
- JSX: react-jsx
- Incremental: true
- Includes `.next/types/**/*.ts` and `.next/dev/types/**/*.ts`

**Next.js (`next.config.ts`):**
- `cacheComponents: true` - Enables Next.js 16 cache components feature
- No custom Webpack/Turbopack overrides

**Drizzle (`drizzle.config.ts`):**
- Dialect: postgresql
- Schema: `./src/lib/db/schema.ts`
- Migrations output: `./drizzle/`
- Credentials sourced from `DATABASE_URL` env var

**Vercel (`vercel.json`):**
- Cron: `path: /api/internal/sync-wise`, `schedule: 0 0 * * *` (daily at midnight UTC)
- Function `maxDuration: 300` set in `src/app/api/internal/sync-wise/route.ts` line 7

**Environment (`src/lib/env.ts`):**
- 9 env vars validated via Zod schema at startup
- `WISE_NAMESPACE` defaults to `begifted-education`
- `WISE_INSTITUTE_ID` defaults to `696e1f4d90102225641cc413`
- `.env.local` present (gitignored, contents not inspected)
- `.env.example` documents all 9 required vars

**ESLint (`eslint.config.mjs`):**
- Flat config format
- Extends `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`
- Global ignores: `.next/**`, `out/**`, `build/**`, `next-env.d.ts`

**PostCSS (`postcss.config.mjs`):**
- Single plugin: `@tailwindcss/postcss`

**shadcn (`components.json`):**
- Style: `base-nova`
- Base color: neutral
- CSS variables enabled
- Icon library: lucide
- Aliases: `@/components`, `@/components/ui`, `@/lib`, `@/hooks`, `@/lib/utils`

## NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `next dev` | Local dev server |
| `build` | `next build` | Production build |
| `start` | `next start` | Production server |
| `lint` | `eslint` | Lint codebase |
| `test` | `vitest run` | Run all tests once |
| `test:watch` | `vitest` | Run tests in watch mode |
| `db:generate` | `drizzle-kit generate` | Generate SQL migrations from schema |
| `db:migrate` | `drizzle-kit migrate` | Apply migrations |
| `db:seed` | `tsx src/lib/db/seed.ts` | Seed admin users and tutor aliases |

## Platform Requirements

**Development:**
- Node.js (ES2017+ compatible, no specific version pinned)
- npm
- PostgreSQL connection (Neon or compatible)
- Google OAuth credentials for auth testing
- All 9 environment variables set (validated at startup by `src/lib/env.ts`)

**Production:**
- Vercel Hobby plan (current) - Daily cron, 300s function timeout
- Neon Postgres (ap-southeast-1 region)
- Vercel Cron for scheduled sync (`vercel.json`)
- Vercel Serverless Functions (300s max duration for sync endpoint)
- Production URL: https://bgscheduler.vercel.app

---

*Stack analysis: 2026-04-29*
