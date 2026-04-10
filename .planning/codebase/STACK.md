# Technology Stack

**Analysis Date:** 2026-04-10

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
- Next.js 16.2.2 - App Router, full-stack framework
- React 19.2.4 - UI rendering
- React DOM 19.2.4 - Browser rendering

**Testing:**
- Vitest ^4.1.2 - Unit test runner, node environment, globals enabled
- Config: `vitest.config.ts`

**Build/Dev:**
- Tailwind CSS ^4 - Utility-first CSS (via `@tailwindcss/postcss` plugin)
- PostCSS - CSS processing (`postcss.config.mjs`)
- ESLint ^9 - Linting with `eslint-config-next` 16.2.2 (core-web-vitals + typescript presets)
- TypeScript ^5.9.3 - Type checking (`tsconfig.json`, strict mode, bundler module resolution)

## Key Dependencies

**Critical:**
- `next-auth` ^5.0.0-beta.30 - Authentication (Auth.js v5 beta with Google provider)
- `drizzle-orm` ^0.45.2 - Type-safe ORM for PostgreSQL
- `@neondatabase/serverless` ^1.0.2 - Neon serverless Postgres driver (HTTP mode)
- `zod` ^4.3.6 - Runtime schema validation

**Infrastructure:**
- `drizzle-kit` ^0.31.10 - Schema migrations and generation
- `tsx` (implicit via `db:seed` script) - TypeScript execution for seed scripts

**UI:**
- `shadcn` ^4.1.2 - Component library (uses Radix primitives under the hood)
- `@base-ui/react` ^1.3.0 - Base UI primitives
- `cmdk` ^1.1.1 - Command palette / searchable combobox
- `lucide-react` ^1.7.0 - Icon library
- `class-variance-authority` ^0.7.1 - Variant-based component styling
- `clsx` ^2.1.1 - Conditional className utility
- `tailwind-merge` ^3.5.0 - Tailwind class deduplication
- `tw-animate-css` ^1.4.0 - Tailwind animation utilities

**Data/Time:**
- `date-fns` ^4.1.0 - Date manipulation
- `date-fns-tz` ^3.2.0 - Timezone-aware date operations (Asia/Bangkok)
- `uuid` ^13.0.0 - UUID generation

## Configuration

**TypeScript:**
- `tsconfig.json`: strict mode, ES2017 target, bundler moduleResolution
- Path alias: `@/*` maps to `./src/*`

**Environment:**
- `.env.example` documents 9 required variables (see INTEGRATIONS.md)
- `.env.local` present (gitignored, contains local secrets)
- Variables loaded via `process.env.*` at runtime

**Build:**
- `next.config.ts`: Default configuration (no custom settings)
- `postcss.config.mjs`: `@tailwindcss/postcss` plugin only
- `eslint.config.mjs`: Flat config with core-web-vitals + typescript presets

**Database:**
- `drizzle.config.ts`: PostgreSQL dialect, schema at `./src/lib/db/schema.ts`, migrations output to `./drizzle/`

## NPM Scripts

```bash
npm run dev          # next dev (local development)
npm run build        # next build (production build)
npm run start        # next start (production server)
npm run lint         # eslint
npm test             # vitest run (single run)
npm run test:watch   # vitest (watch mode)
npm run db:generate  # drizzle-kit generate (schema migrations)
npm run db:migrate   # drizzle-kit migrate (apply migrations)
npm run db:seed      # tsx src/lib/db/seed.ts (seed data)
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

*Stack analysis: 2026-04-10*
