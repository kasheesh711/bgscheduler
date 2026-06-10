# 13-SPIKE-FINDINGS — OA-Manager Label → Messaging-API userId Bridge

> Research spike (READ-ONLY). Goal: determine whether the ~662 admin-labeled
> LINE OA Manager chats (518 scraped chat URLs) can be bridged to the 252
> Messaging-API webhook `source.userId` records, and if so, how.
> Date: 2026-06-10. No code changed.

---

## Executive summary

The `chatId` in `chat.line.biz/{botId}/chat/{chatId}` URLs is **not** the Messaging-API
`source.userId` — it is the OA Manager chat surface's own per-contact identifier, and LINE
issues no public mapping between the two. The single highest-value, fully programmatic asset
here is the **undocumented `chat.line.biz` internal API** (cookie + XSRF authenticated, already
reachable from the resolver's browser session): it is the *only* source that returns admin-set
nicknames and tags, and one paginated sweep of `GET /api/v2/bots/{botId}/chats` replaces the
fragile DOM-scraping the resolver does today. **Recommended path: first run a 30-minute
diagnostic** comparing the scraped `lineOaAccountId` (botId) against `GET /v2/bot/info` for the
webhook channel and testing whether internal-chat-API message `.id`s match stored webhook
`lineMessageId`s — the result of that test decides between a precise **message-ID join** (best, if
IDs match and it's the same OA) and the proven **name + profile-icon-hash match** fallback. If
the botIds differ, the labels belong to a *different* LINE OA/provider and cannot be bridged to
this channel's userIds at all.

---

## Q1 — What is the chat.line.biz `chatId`? Same namespace as Messaging-API `userId`?

**URL shape:** `https://chat.line.biz/{botId}/chat/{chatId}`, where both segments match `U[0-9a-f]{32}`.
- Segment 1 `{botId}` = the OA's bot/account identifier on the chat surface (e.g. the resolver's
  own match `@match https://chat.line.biz/Uf378f152231ee8a49e74d2b852873c20/chat/*`).
- Segment 2 `{chatId}` = the **chat API's per-contact identifier**, *not* the Messaging-API userId.

**Findings:**
- LINE's official rule: a `userId` is **provider-scoped**. *"User IDs are issued different values
  for each provider… If the provider is the same, the user ID is the same regardless of the channel
  type."* So same provider ⇒ same userId across Login + Messaging API channels; **different
  provider ⇒ different value for the same person.** ([Get user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/))
- Practitioner evidence (the closest published case to ours, `line-friend-export` / Zenn): the
  author explicitly warns the chat URL's second segment **differs** from the Messaging-API user ID
  — *「U2222… は LINE ユーザー ID とは異なるので注意が必要」* ("the chat ID differs from the LINE
  user ID — caution needed"), *「チャット ID と呼ばれるようです」* ("it appears to be called a chat
  ID"). He could **not** equate them and had to reconcile by name + profile-image hash.
  ([Zenn scrap](https://zenn.dev/tatsuyasusukida/scraps/ab9bf2326b4fce))
- **When they differ:** (a) the chat surface and Messaging API channel sit under **different
  providers**; (b) **module channels** use an entirely different ID format — *"a 68-digit character
  string starting with 'L'"*, e.g. `LUb577…-U5fac…`, and *"This identifier will be different between
  LINE Official Accounts, even if they are the same user."* ([Module channel Messaging API](https://developers.line.biz/en/docs/partner-docs/module-technical-using-messaging-api/));
  (c) legacy LINE@→OA migration history can leave the chat surface on a separate lineage.

**Application to our 0-overlap symptom:** Both our sets are `U[hex]{32}` (so not a module channel).
Zero overlap between 518 scraped `chatId`s and 252 webhook `userId`s is consistent with **either**
(i) same OA but two non-comparable namespaces (chatId vs userId), **or** (ii) the extension scraped
a *different* OA than the webhook serves. **The botId in the scraped URL is the discriminator** and
is already stored per row (see Q5) — Q4's diagnostic resolves which case we're in.

---

## Q2 — Any official API / export for OA Manager chat data (tags, nicknames, notes, chat lists)?

**No official endpoint exists for admin-authored chat metadata.**
- The Messaging API has **no** endpoint for chat tags, admin nicknames, internal notes, or a chat
  list. The FAQ confirms the "Chat" feature is an OA-Manager-only surface with no developer Chat
  API. ([Messaging API FAQ](https://developers.line.biz/en/faq/tags/messaging-api/))
- The partner/corporate reference only adds chat-*control* APIs for module channels
  (`POST /v2/bot/chat/{chatId}/control/acquire` / `…/release`) and `markAsRead` — **nothing** that
  reads tags/nicknames/notes/lists. ([Partner-docs reference](https://developers.line.biz/en/reference/partner-docs/))
- **No CSV/friends export** of IDs+names+tags exists in OA Manager (community-confirmed limitation).
  ([LINE community Q&A, now redirected](https://developers.line.biz/en/news/2023/12/13/developers-community-page-released/))
- The closest official reads, both **labels-blind**:
  - `GET /v2/bot/followers/ids` — userIds only, **no** names/labels; **verified/premium accounts only**
    (BGScheduler already uses this in Phase 12, so the account qualifies).
    ([Get user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/))
  - `GET /v2/bot/profile/{userId}` — returns LINE `displayName` + `pictureUrl`, **not** the
    admin-set nickname/tags.

---

## Q3 — Can admin-set nicknames/tags be retrieved programmatically at all?

**Officially no; unofficially yes — via the undocumented `chat.line.biz` internal API**, which is
exactly what powers the OA Manager web UI the resolver already drives. Auth = the logged-in
`chat.line.biz` / `.line.biz` session cookies + an `X-XSRF-TOKEN` header (from
`GET /api/v1/csrfToken`) + `x-oa-chat-client-version` header. Endpoints confirmed across multiple
independent implementations:

| Endpoint | Returns / does | Source |
|---|---|---|
| `GET /api/v2/bots/{botId}/chats?folderType=ALL&tagIds=&autoTagIds=&limit=25&next=…` | **Chat list**: `chatId`, `profile.name`, **`profile.nickname` (admin-set)**, `profile.iconHash`, tags; cursor `next` | [line-friend-export get-chats.js](https://github.com/tatsuyasusukida/line-friend-export), [line-bot-chat-history-downloader](https://github.com/xiaoxigua-1/line-bot-chat-history-downloader), [LINELib](https://github.com/Madoa5561/LINELib) |
| `GET /api/v1/bots/{botId}/tags` | Tag catalog; `add/get` tag variants exist | [miloira/line-web](https://github.com/miloira/line-web) |
| `PUT/POST …/chats/{chatId}/nickname` (a.k.a. "remark") | **Set** the admin nickname | line-web, [yothinn/linechat-service](https://github.com/yothinn/linechat-service) |
| `POST/DELETE …/chats/{chatId}/tags/{tagId}` | Add / remove a tag on a chat | line-web |
| `GET /api/v3/bots/{botId}/chats/{chatId}/messages?backward=…` | **Message history**: each item has a message `.id` and `source.chatId` | downloader, LINELib |
| `GET …/chats/{chatId}/users?userIds=…` / chat members | Per-chat user records | linechat-service, LINELib |
| Internal custom notes | community userscript builds/edits notes (36-char UUID `note.id`) on the chat panel | [greasyfork 538522](https://greasyfork.org) |

**Practical upshot for the resolver:** today `content.js` types each student code into the search
box and DOM-scrapes rows + mom/dad text (`currentAdminNoteText`). One authenticated sweep of
`/api/v2/bots/{botId}/chats` would instead dump *every* chat's `chatId`, admin nickname, name,
iconHash and tags in a few paginated calls — far faster and more reliable, and it is the **only**
programmatic source for the admin labels at all.

---

## Q4 — Can we map chatId → Messaging-API userId for the same person?

**Direct equality: no** (Q1). Ranked bridging options:

1. **Message-ID join — best, but conditional & unverified.**
   - Webhook events carry `message.id`; our repo **already persists it** as
     `line_messages.lineMessageId` plus `webhookEventId` (`src/lib/line/data.ts:463-474`).
   - The internal chat API's `…/chats/{chatId}/messages` items also expose a message `.id`
     (used as `message.id` by the downloader and `flexJson?messageId=` by the flex fetcher).
   - Since **Nov 30 2022** webhook + OA-Manager chat run **simultaneously on the same OA** — the
     same inbound message lands in *both* surfaces. ([grandream blog](https://www.grandream.jp/blog/line-webhook-with-chat))
   - **Unverified assumption (the linchpin):** that the chat-API message `.id` is byte-identical to
     the webhook `message.id`. I found no doc or repo that explicitly asserts equality. If it holds,
     the join is deterministic: for each scraped `chatId`, pull recent inbound message IDs via the
     chat API → look up `line_messages.lineMessageId` → read its `lineUserId`. **Must be empirically
     confirmed** (read one chat's messages, grep the IDs against `line_messages`).
   - **Ceiling:** only the ~252 users who actually sent a webhook message can ever be joined this
     way; the remaining ~266 scraped chats have no webhook message to match on.

2. **Name + profile-icon-hash match — proven fallback (the Zenn method).**
   - Join chat-API `profile.name` / `iconHash` against `/v2/bot/profile/{userId}`
     `displayName` / `pictureUrl` (SHA-256 of the image bytes to disambiguate same-name people).
     Reduced 1,350→1,064 with manual cleanup of the rest in the published case. Works **without** a
     webhook message, and reuses Phase 12's existing name-matcher infrastructure
     (`src/lib/line/name-matcher.ts`, `backlog-matcher.ts`).

3. **Text + timestamp correlation — last resort.** Lower precision, brittle across clock skew and
   identical short messages; only if 1 and 2 both fail.

**Diagnostic to run first (≈30 min, read-only):**
- (a) `SELECT DISTINCT line_oa_account_id FROM line_oa_resolver_rows;` → the scraped botId(s).
- (b) `GET https://api.line.me/v2/bot/info` with `LINE_CHANNEL_ACCESS_TOKEN` → the webhook bot's
  `userId` / `basicId`.
- (c) Compare: **equal ⇒ same OA** (IDs are chatId-vs-userId; bridge via 1 then 2);
  **different ⇒ different OA/provider** — labels are not bridgeable to this channel's userIds, and
  the realistic answer becomes Re-label-in-app.
- (d) Confirm the message-ID assumption: open one scraped chat, read its messages via the chat API,
  check whether any `.id` exists in `line_messages.lineMessageId`.

---

## Q5 — Provider/channel architecture (repo evidence)

- **Env (names only):** `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (both optional),
  `ENABLE_LINE_SCHEDULER` (`src/lib/env.ts:13-15`; `.env.example:24-26`). **One** Messaging API
  channel; **no** botId/channelId/providerId hardcoded anywhere.
- **Webhook side** (`src/lib/line/data.ts` `recordLineWebhookPayload`): reads
  `event.source.userId` (the provider-scoped Messaging-API userId), and stores
  `lineMessages.lineMessageId = message.id` and `webhookEventId` — i.e. **the webhook message IDs
  needed for the join in Q4 are already in the DB.** Client base is `https://api.line.me`,
  endpoints `/v2/bot/profile/{userId}`, `/v2/bot/followers/ids`, `/v2/bot/message/push`
  (`src/lib/line/client.ts`).
- **Extension side** (`extensions/line-oa-resolver/content.js:23`):
  `^https://chat\.line\.biz/(U[a-fA-F0-9]{32})/chat/(U[a-fA-F0-9]{32})` → group 1 captured as
  `lineOaAccountId` (= **botId**), group 2 captured as **`lineUserId`** and posted to Scheduler.
  **Naming trap:** that second segment is the chat-surface **chatId**, *not* the Messaging-API
  userId — yet the column `line_oa_resolver_rows.lineUserId` (`schema.ts:1894`) stores it under the
  `userId` name. The mislabel is plausibly the entire root cause of the "zero overlap" surprise.
- **botId is captured and stored** per row (`lineOaAccountId`, `schema.ts:1893`), so the Q4
  diagnostic runs directly against existing data. The **webhook channel's** own bot ID is stored
  nowhere and must be fetched via `GET /v2/bot/info`.
- The extension reads labels by DOM text (`currentAdminNoteText`, mom/dad/secretary regex), **not**
  via the chat API — so it currently captures only a weak relationship hint, not the actual
  admin nickname/tags that the chat API would expose.

---

## Options table

| Option | Feasibility | Precision | Effort | Fragility |
|---|---|---|---|---|
| **Official API only** (`followers/ids` + `profile`) | Low — gives userIds + LINE displayName but **no admin nickname/tags**; can't recover the labels | n/a for labels | Low | Low (but doesn't solve the problem) |
| **Internal chat-API dump** (`/api/v2/bots/{botId}/chats`) for nickname/name/iconHash/tags | High — only programmatic source of admin labels; replaces DOM scraping | High (labels) | Medium | Medium — undocumented, cookie+XSRF+version-header, ToS grey area, UI-version churn |
| **Message-ID join** (chatId→userId) | Conditional — needs same-OA + chat/webhook message IDs equal (**unverified**); caps at the ~252 who messaged | Very high *if* it holds | Medium | Medium — breaks if IDs differ or OA differs |
| **Name + icon-hash match** (Zenn method) | High — proven; works without a webhook message; reuses Phase 12 name-matcher | Medium–High (icon-hash disambiguates) | Medium | Medium — ambiguous on same-name + no/blank avatar |
| **Text + timestamp correlation** | Medium | Medium | Medium | High |
| **Re-label in app** (internal labeling UI, drop the bridge) | High — no LINE-side dependency | Perfect (human) | High (re-touch ~662) | None |

---

## Recommendation

1. **Gate everything on the Q4 diagnostic first** (read-only, ~30 min). Compare scraped
   `lineOaAccountId` vs `GET /v2/bot/info`, and test the chat-API-message-id ↔
   `line_messages.lineMessageId` equality. This single test determines whether a bridge is even
   possible and which one to build — do not write bridge code before it passes.

2. **If same OA (botIds match):** build the bridge on the **internal chat API** as the data source —
   sweep `/api/v2/bots/{botId}/chats` for `chatId` + admin nickname + name + iconHash + tags (this
   also retires the brittle search-box DOM scraping). Bridge `chatId → lineUserId` with a
   **two-tier matcher: (a) message-ID join** (deterministic, for the ~252 who messaged), **(b) name +
   profile-icon-hash match** as fallback (Phase 12's `name-matcher.ts`), leaving residue for manual
   review. Keep all auto-matches as *suggested* links pending admin confirmation — consistent with
   the existing fail-closed, dry-run posture of the LINE feature.

3. **If botIds differ (different OA/provider):** the scraped labels belong to a channel whose
   userIds this webhook never sees — **no programmatic bridge is possible**. Fall back to
   **re-label-in-app**: surface webhook contacts in `/line-review` and let admins re-attach student
   codes, optionally seeded by name match against the scraped labels.

Rationale: the internal chat API is the *only* programmatic source of the admin labels regardless
of branch, so it is the spine of any solution. The message-ID join is the most precise bridge but
is both unverified and capped at the messaged subset, so it must be paired with the proven name +
icon-hash fallback rather than relied on alone.

---

## Open risks

- **Same-OA vs different-OA is still unknown** until the Q4 diagnostic runs; the entire plan
  branches on it. Zero overlap is suggestive but not conclusive.
- **Message-ID equality across surfaces is unverified.** If the chat-API `.id` ≠ webhook
  `message.id`, option 1 collapses to the name/icon-hash fallback.
- **Undocumented API = ToS and stability risk.** `chat.line.biz/api/*` can change without notice;
  `x-oa-chat-client-version` is a pinned date string in third-party clients; aggressive use risks
  session/account flags. Throttle, reuse the human-authenticated session, treat as best-effort.
- **Coverage ceiling.** Even a perfect bridge only links the subset of scraped chats that have a
  matching webhook contact; one-time/never-messaged contacts stay unbridged. Manual review of the
  residue is unavoidable.
- **`followers/ids` / `bot/info` require verified/premium** — already satisfied (Phase 12 uses
  followers/ids), but re-confirm the access token's scope before relying on `bot/info`.
- **Naming-trap migration:** `line_oa_resolver_rows.lineUserId` actually holds the chat-surface
  chatId; any bridge code and any docs must not treat that column as a Messaging-API userId.

---

## DIAGNOSTIC RESULTS (run 2026-06-10, read-only)

The gating diagnostic from the Recommendation section was executed against production:

1. **Scraped botId(s)** — `SELECT line_oa_account_id, count(*) FROM line_oa_resolver_rows GROUP BY 1`:
   - `Ueebc1942ed1ed3bd52bb0c6e8d122565` → 816 rows
   - empty/null → 4,332 rows (older runs didn't capture the field)
2. **Webhook channel identity** — `GET https://api.line.me/v2/bot/info` with production
   `LINE_CHANNEL_ACCESS_TOKEN`:
   - `userId: U3c0bf81c065eab835ecabc2d5a51a5a8`, `basicId: @699fovgg`,
     `premiumId: @begifted`, `displayName: "BeGifted Education"`, `chatMode: chat`
3. **Verdict: SAME OA, different ID namespaces.** The raw IDs differ — but resolver-row evidence
   proves the scraped surface is the BeGifted OA: `candidateContacts[0].adminNoteRaw =
   "BeGifted Education\nPaid"` on rows under `Ueebc1942…`. So `Ueebc1942…` is chat.line.biz's
   bot identifier for the SAME OA whose Messaging-API bot userId is `U3c0bf81c…`. The
   chat-surface path segment is NOT the Messaging-API bot userId — same naming-trap class as
   the chatId/userId confusion. Corroborating signal: Phase 12's dry-run matched 229
   high-confidence followers of the webhook channel against resolver targets with coherent
   names — impossible if the two surfaces served different parent populations.
4. **Consequence: the bridge IS possible.** Proceed per Recommendation §2 (same-OA branch):
   source admin nicknames/tags via the authenticated chat.line.biz internal API
   (`GET /api/v2/bots/Ueebc1942…/chats`), then join chatId → webhook userId via
   (a) message-ID equality test (still unverified — first build step) with
   (b) name + profile-iconHash fallback. All paths require an admin-authenticated
   chat.line.biz session (browser-extension capture or session cookie) — owner involvement
   required at build time.
