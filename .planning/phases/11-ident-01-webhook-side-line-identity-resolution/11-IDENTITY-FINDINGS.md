# Phase 11 — Identity Mapping: UAT Investigation Findings

**Date:** 2026-06-07 · **Source:** live production UAT of the deployed Phase 11 matcher.
**Bottom line:** Phase 11's *infrastructure* works and is deployed, but the *matching strategy* does not reliably map parents→students on real data. A redesign is required. This doc is the evidence base for that redesign.

## 1. The verified-mapping reuse idea — investigated, and ruled out by ID (definitively)

Admin staff previously hand-verified ~656 LINE-chat→student links via the OA Manager (chat.line.biz). Question raised in UAT: can we just reuse those (they're correct for sure)?

**Answer: not by ID.** The verified links are keyed to the parent's **OA-Manager chat identity**, which LINE issues in a **different, unlinkable namespace** from the **Messaging-API identity** the live bot uses (provider-scoped user IDs; LINE docs: *"if the provider is the same, the user ID is the same"* — these are not the same provider/namespace).

Tested against the REAL production OA (`@begifted` "BeGifted Education", premium):
- `followers/ids` → **1,962 real followers** (Messaging-API namespace).
- **1,962 followers ∩ 518 resolver(OA-Manager) IDs = 0 overlap.**
- `getProfile` works for a real messager ("JAAH") but returns **"Not found" for every resolver ID**.
- Earlier "0 overlap" doubt (only tested vs messagers) is now resolved: 0 overlap vs the FULL follower roster + getProfile. Confirmed.

**Only deterministic bridge that could exist:** a phone number via **LINE Profile+** (corporate option) matched to Wise parent phone — needs a corporate application; unknown if enabled. Worth the user checking OA Manager for a member/contact export that includes a Messaging-API user ID (docs suggest none exists).

## 2. The verified data is still an asset — via NAME, not ID

`line_oa_resolver_rows` (committed/verified) hold **662 (parent_name → student) ground-truth mappings** + the chat URL. These can be cross-walked to live contacts by **parent name ↔ follower display name**:
- Exact parent-name match: 21 / 258 messagers. Token-overlap: 43. Unambiguous: 23.
- Coverage is limited because many parents' LINE display names are handles ("nida_seguir", "OiL"), not their real name.
- **But the pool is now 1,962 followers (not 258 messagers)** — every follower is `getProfile`-able (display name + picture), so name cross-walk coverage should be materially higher, and each match is anchored to human-verified ground truth (≈100% precision) + a clickable chat URL for one-click admin confirmation.

## 3. Why the current matcher produces noise (root cause)

- The name matcher's **fuzzy tier (Levenshtein ≤2, score 0.5)** floods on short Thai/English nicknames: one contact ("nida_seguir", a parent of "Migs"+"Angie") got **9** suggestions across unrelated families because "Angie" fuzzy-collides with Angel/Anik/Ani/Artie/Margie.
- **Volume ≠ noise**: the highest-volume contacts (Panan 49 msgs, Sherri 39…) have **0** suggestions — so it is name-ambiguity-driven, not staff/coordinator-driven.
- Structured extraction (`intent_payload.studentName/parentName`) is **empty**; names live as conversational nicknames in message text.
- **Recall gap**: the matcher only fires on NEW messages post-deploy (no historical backfill of ~805 scheduling messages), so most real parents have 0 suggestions.
- Fail-closed held throughout: every noisy suggestion is `suggested`, never auto-`verified`.

## 4. Redesign direction (for the follow-up phase)

1. **Anchor on verified ground truth** — match live contacts against the 662 verified (parent_name → student) mappings, not the full Wise directory. Smaller, curated, ≈100% precision target.
2. **Bridge by name across the full 1,962-follower roster** (followers/ids + getProfile), not just messagers; attach the verified chat URL so admins confirm in one click.
3. **Aggregate per contact** — collect ALL nicknames a contact uses across the conversation ("Migs"+"Angie" together pins one family); never emit a shortlist from a single ambiguous nickname.
4. **Parent-identity-first** (parent full name / siblings) over short student nicknames; the one clean production result ("Far" → 2 Suppanich siblings, 0.95) came this way.
5. **Drop the standalone fuzzy tier** from production suggestion insertion (token/exact only); treat ambiguous single nicknames as "needs more signal".
6. **Historical backfill** of existing `extractedState` so the worklist is representative, not just post-deploy trickle.
7. Optional deterministic bridge: pursue **LINE Profile+ phone** ↔ Wise parent phone if available.

## 5. What already shipped / works (keep)
- isPhantom quarantine (696 prod rows), fail-closed suggestion insertion, phantom archive scope, inline recompute, the route phantom-scope fix (WR-01), and the worklist "default to All resolver runs" fix (UAT). All deployed to `@begifted` production.
- `followers/ids` confirmed available in production (premium OA) — IDENT-03 re-anchor is viable.

## 6. Operational gotcha
- Local `.env.local` `LINE_CHANNEL_ACCESS_TOKEN` is the **"BeGifted Testing"** channel, NOT production. Use `vercel env pull --environment=production` for any LINE-API testing against real data.

---
*Captured during /gsd-verify-work 11. Feeds the matching-redesign follow-up phase.*
