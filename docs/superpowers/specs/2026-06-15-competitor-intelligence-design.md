# Competitor Intelligence Dashboard

Date: 2026-06-15
Status: V1 implemented in progress branch

## Summary

Build `/competitor-intelligence` inside BGScheduler as a Market Intelligence workbench for management and marketing users. The first screen opens on a daily executive market brief, then supports drilldowns for competitor activity, SEO visibility, pricing and offer evidence, source health, task workflow, and vendor costs.

The system tracks the provided Bangkok education competitors plus BeGifted as the own-brand baseline. Initial competitors are seeded from the supplied websites and Instagram/Facebook URLs. Brands, sources, and auto-discoveries can be refined later in the admin UI.

## Data Model

V1 adds Postgres tables for:

- competitor entities and owned-brand baseline
- competitor sources and source-level run ledgers
- sync runs, evidence items, and media asset references
- SERP keywords and rank observations
- AI runs and daily briefs
- AI task suggestions, accepted tasks, comments, events, and vendor usage caps

Source facts are immutable from the AI perspective: provider/manual evidence rows remain the source of truth, and AI output is stored separately as briefs, suggestions, and recommendations.

## Providers

V1 provider paths:

- Website crawl: fetches configured pages and normalizes title/description signals.
- Social: calls Apify Instagram/Facebook public scrapers when `APIFY_API_TOKEN` is configured; otherwise records a visible skipped state.
- SERP: calls DataForSEO Google organic live endpoint for EN/TH Bangkok keywords on mobile and desktop when `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are configured; otherwise records a visible skipped state.
- Media archive: table and adapter boundary are in place. Without `@vercel/blob`/blob token, media is retained as source URL references with `blob_not_configured` metadata.
- AI analysis: uses the existing OpenAI Responses strict-JSON pattern when configured, with deterministic fallback when not configured.

## Access

Access follows the existing BGScheduler page-level model:

- full-access admins can access `/competitor-intelligence`
- restricted management or marketing admins can be granted `/competitor-intelligence`
- teacher-role sessions are denied
- middleware covers `/competitor-intelligence` and `/api/competitor-intelligence/*`, and route handlers re-check session access server-side

## Workflow

Daily cron and manual sync both run the same orchestrator:

1. Seed default competitors, sources, and SEO keywords without re-enabling disabled rows.
2. Check monthly provider caps before paid provider calls.
3. Write source runs for every source/keyword, including skipped and failed provider states.
4. Normalize evidence items, SERP observations, and media references.
5. Generate the daily brief and task suggestions.
6. Keep AI suggestions inactive until an admin accepts them into the task queue.

Pricing observations must be evidence-bound through a source URL, media reference, or manual note.

## UI

The workbench shows:

- daily brief with what changed, why it matters, recommended responses, confidence, coverage, SEO, and budget flags
- KPI row for coverage, SEO visibility, open tasks, budget usage, high-impact moves, and source flags
- activity feed
- SEO/rank matrix
- pricing/offers with manual evidence capture
- competitors/sources with status controls
- task suggestions and accepted task queue
- costs, source coverage, and recent runs

## Cron

V1 registers:

- path: `/api/internal/sync-competitor-intelligence`
- schedule: `25 18 * * *`
- Bangkok cadence: daily 01:25
- auth: `CRON_SECRET`
- Data Health job key: `competitor_intelligence`

## Reference Docs Checked

- DataForSEO SERP Google overview
- Meta Instagram Business Discovery
- Meta Pages posts
- Meta Ad Library API
- Apify Instagram scraper
- Apify Facebook posts scraper

## Future Work

- Add first-class Vercel Blob upload once `@vercel/blob` is intentionally added.
- Add source CRUD and competitor merge/split workflows.
- Add keyword approval/disable UI for AI-discovered keywords.
- Add sitemap expansion beyond the current configured URL fetch.
- Add richer screenshots and HTML diff extraction for pricing and landing pages.
