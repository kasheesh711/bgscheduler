# Technology Stack

**Analysis Date:** 2026-04-16

## Languages

**Primary:**
- TypeScript ^5.9.3 - All application code (`src/**/*.ts`, `src/**/*.tsx`)

**Secondary:**
- SQL (PostgreSQL) - Database schema via Drizzle ORM migrations (`drizzle/`)

## Runtime

**Environment:**
- Node.js (no `.nvmrc` detected; target ES2017 in `tsconfig.json`)
- Vercel Serverless Functions (max 300s duration configured in `src/app/api/internal/sync-wise/route.ts`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js 16.2.2 - App Router, full-stack framework (`next.config.ts` enables `cacheComponents: true`)
- React 19.2.4 - UI rendering
- React DOM 19.2.4 - Browser rendering

**Testing:**
- Vitest ^4.1.2 - Unit test runner, node environment, globals enabled
- Config: `vitest.config.ts` (path alias `@` -> `./src`)

**Build/Dev:**
- Tailwind CSS ^4 - Utility-first CSS (via `@tailwindcss/postcss` plugin)
- PostCSS - CSS processing (`postcss.config.mjs`)
- ESLint ^9 - Flat config with `eslint-config-next` 16.2.2 (core-web-vitals + typescript presets)
- TypeScript ^5.9.3 - Type checking (`tsconfig.json`, strict mode, bundler module resolution)

## Key Dependencies

**Critical (production):**
- `next-auth` ^5.0.0-beta.30 - Authentication (Auth.js v5 beta with Google provider)
- `@auth/drizzle-adapter` ^1.11.1 - Auth.js adapter for Drizzle ORM
- `drizzle-orm` ^0.45.2 - Type-safe ORM for PostgreSQL
- `@neondatabase/serverless` ^1.0.2 - Neon serverless Postgres driver (HTTP mode)
- `zod` ^4.3.6 - Runtime schema validation

**UI (production):**
- `shadcn` ^4.1.2 - Component library (uses Radix primitives under the hood)
- `@base-ui/react` ^1.3.0 - Base UI primitives
- `cmdk` ^1.1.1 - Command palette / searchable combobox
- `lucide-react` ^1.7.0 - Icon library
- `class-variance-authority` ^0.7.1 - Variant-based component styling
- `clsx` ^2.1.1 - Conditional className utility
- `tailwind-merge` ^3.5.0 - Tailwind class deduplication
- `tw-animate-css` ^1.4.0 - Tailwind animation utilities

**Data/Time (production):**
- `date-fns` ^4.1.0 - Date manipulation
- `date-fns-tz` ^3.2.0 - Timezone-aware date operations (Asia/Bangkok)
- `uuid` ^13.0.0 - UUID generation

**Dev Dependencies:**
- `@tailwindcss/postcss` ^4 - Tailwind PostCSS plugin
- `@types/node` ^20 - Node.js type definitions
- `@types/react` ^19 - React type definitions
- `@types/react-dom` ^19 - React DOM type definitions
- `@types/uuid` ^10.0.0 - UUID type definitions
- `drizzle-kit` ^0.31.10 - Schema migrations and generation
- `eslint` ^9 - Linter
- `eslint-config-next` 16.2.2 - Next.js ESLint presets
- `tailwindcss` ^4 - CSS framework
- `typescript` ^5.9.3 - TypeScript compiler
- `vitest` ^4.1.2 - Test runner

**Implicit (not in package.json):**
- `tsx` - TypeScript execution for `db:seed` script (invoked via `npm run db:seed`)

## Configuration Files

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript: strict mode, ES2017 target, bundler moduleResolution, path alias `@/*` -> `./src/*` |
| `next.config.ts` | Next.js: `cacheComponents: true` enabled |
| `postcss.config.mjs` | PostCSS: `@tailwindcss/postcss` plugin only |
| `eslint.config.mjs` | ESLint 9 flat config: `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript` |
| `vitest.config.ts` | Vitest: node environment, globals enabled, `@` path alias |
| `drizzle.config.ts` | Drizzle: PostgreSQL dialect, schema at `./src/lib/db/schema.ts`, migrations to `./drizzle/` |
| `vercel.json` | Vercel: cron schedule `0 0 * * *` for `/api/internal/sync-wise` |
| `.env.example` | Documents 9 required environment variables |
| `.env.local` | Local secrets (gitignored) |
| `package.json` | Project: `tutor-search` v0.1.0, private |

## NPM Scripts

```bash
npm run dev          # next dev (local development)
npm run build        # next build (production build)
npm run start        # next start (production server)
npm run lint         # eslint (flat config)
npm test             # vitest run (single run)
npm run test:watch   # vitest (watch mode)
npm run db:generate  # drizzle-kit generate (create migration files from schema)
npm run db:migrate   # drizzle-kit migrate (apply migrations to database)
npm run db:seed      # tsx src/lib/db/seed.ts (seed admin users and aliases)
```

## Platform Requirements

**Development:**
- Node.js (ES2017+ compatible)
- npm
- PostgreSQL connection (Neon or local)
- Google OAuth credentials for auth testing

**Production:**
- Vercel (Hobby plan, daily cron; Pro plan for 30-min cron)
- Neon Postgres (ap-southeast-1 region)
- Vercel Cron for scheduled sync
- Vercel Serverless Functions (300s max duration for sync endpoint)

---

*Stack analysis: 2026-04-16 | Source: `package.json`, config files, `src/lib/`*
