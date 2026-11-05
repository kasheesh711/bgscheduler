# Thea teacher queries

## Design

Thea answers teacher availability and named-teacher daily schedule questions in the existing bound BG The Loop group. LINE must mark a real mention of the bot (`mention.mentionees[].isSelf`); text that merely spells its display name does not invoke it. Other tutor commands and the weekend bot remain intact.

Use `deepseek/deepseek-v4.1-flash-1017` through the existing OpenRouter transport to extract a strict query. The model sees the question, recent same-user clarification context and filter vocabulary. It does not receive student rosters or decide availability. Validate date, time, subject, curriculum, level and intent in code. Ask for missing dates, unsupported requests or ambiguous teachers. Format the reply from checked data.

Use a shared, short-lived Wise read cache: roster and one-day teacher working hours/leave for 10 minutes; requested-day sessions for 2 minutes. The existing authenticated Wise receiver invalidates session caches on session-created/updated/deleted events. Webhooks do not replace API reads because working hours and leaves lack full webhook coverage. Show the oldest relevant check time in the reply. No full snapshot sync per message; no new polling fleet.

A durable queue deduplicates LINE events and allows one worker across instances. The worker uses a single Wise client capped at one HTTP attempt every two seconds, including pagination. Stop immediately on 429 and save a shared cooldown. Limit work per query; an incomplete read produces a retry/refinement message, never an availability result. Reuse identity, qualification and availability normalization plus the deterministic search engine. Reject ambiguous identity and missing/invalid availability data.

Budget: Kevin approved $1 for integration testing and $5 per Bangkok calendar month in use. Reserve $0.005 before each model attempt, bound input/output and provider prices, and stop when the reserved monthly total reaches $5. Retain reservations if billing is unknown. Replies are persisted before retry-safe LINE delivery. Group queries are read-only toward Wise. Classroom automation remains paused.

## Implementation steps and checks

1. Add the small query receipt/lease and cache tables; preserve existing schema and migrations.
2. Add strict query parsing and deterministic fresh-day search/schedule formatting, with focused tests for ambiguity, leave/conflicts, invalid payloads and missing dates.
3. Add mention ingestion, queue, budget and cache/cooldown controls. Test signature/group/mention boundaries, deduplication and cross-instance exclusion.
4. Wire the existing LINE handler, recovery cron and Wise webhook invalidation. Run required type, lint, unit, integration and build checks.
5. Deploy disabled, apply additive migration, configure the approved model/key/budget, enable only the existing group, and verify a real mention and answer. Do not alter other automation.
