# Tutor room booking reference

## HTTP interfaces

All mobile API responses are private and `no-store`. A bearer capability grants exactly one tutor; every request rechecks current tutor approval. Admin endpoints use the existing Auth.js and page namespace gates. No route accepts a caller-supplied tutor identity in place of authorization.

| Method and path | Access | Contract |
|---|---|---|
| GET `/room/[token]` | Capability | Mobile page; invalid, revoked, or expired access renders a new-link notice |
| GET `/api/room/availability` | Bearer capability | Today's `date`, `nowMinute`, `tutorName`, `fresh`, `checkedAt`, `writesEnabled`, `classes`, `rooms`, and owned `reservations` |
| POST `/api/room/reservations` | Bearer capability | Strict JSON: `roomId` UUID, `date` YYYY-MM-DD, integer `startMinute`, `endMinute`, optional `immediate`, UUID `idempotencyKey`; returns `{reservation}` |
| DELETE `/api/room/reservations/[id]` | Bearer capability | Cancel the actor's reservation; returns `{reservation}` |
| GET `/api/tutor-profiles/line-links` | Admin | `{links,tutors}` access request directory |
| PATCH `/api/tutor-profiles/line-links` | Admin | `lineUserId`, `status` (`approved`, `rejected`, `revoked`), `canonicalKey` required for approval |
| GET `/api/class-assignments/reservations?date=YYYY-MM-DD` | Admin | Date, room occupancy, reservations, last check and collector error |
| PATCH `/api/class-assignments/reservations` | Admin | `{id}` cancels a reservation with admin audit and private notification |
| GET `/api/internal/room-booking` | Cron secret | Occupancy refresh and durable retries; `maxDuration = 300` |

Availability intervals use integer Bangkok minutes and half-open `[startMinute,endMinute)` boundaries. Rooms include ID/name, capacity, TV/category, occupancy intervals labelled `class` or `reservation`, and proven free intervals. The tutor view excludes raw Wise IDs and other tutor identifiers. Classes include the tutor's times, actual room or Remote/Room TBC, and a differing planned room when applicable.

Booking failures include `BOOKING_DISABLED`, `ROOMS_UPDATING`, `STALE_ROOMS`, `ROOM_UNAVAILABLE`, `ROOM_CONFLICT`, `TUTOR_CONFLICT`, and `PAST_TIME` (409); invalid time/date/interval inputs use 400. Bad or expired grants use 401, and unavailable tutor approval uses 403. Foreign cancellation IDs return 404. Unexpected service failures return a generic 500 without tokens or backend details.

LINE `/room` text and `room:` postbacks enter through the existing signature-verified webhook. They are durably recorded separately and scheduled with `after()`. Existing LINE command families retain their original authorization.

## Persistence

Migration: `0081_tutor_room_booking.sql`.

| Table | Grain and constraints |
|---|---|
| `room_tutor_links` | One LINE user; pending/approved/rejected/revoked state; partial unique approved canonical tutor key; reviewer and timestamps |
| `room_booking_groups` | One conversation's explicit room enablement and actor |
| `room_day_states` | One Bangkok day; occupancy evidence and successful check time, revision, refresh claim, classroom writer lease, latest error |
| `room_reservations` | One standalone room hold; room FK, durable tutor/LINE identity, interval, confirmed/cancelled/preempted state, source and audit; unique actor/idempotency key |
| `room_access_grants` | SHA-256 capability hash, LINE identity, expiry; plaintext tokens are not stored here |
| `room_actions` | One expiring, actor/conversation-bound LINE action or confirmation |
| `room_command_events` | Unique webhook event, durable payload, processing claim, attempts and status |
| `room_notifications` | One cancellation/preemption notification per reservation; durable LINE retry UUID, attempts, delivery outcome |

None of these tables depend on snapshot IDs. Tutor identities are resolved through the current active snapshot; reservations survive rotation. Notifications and reservations retain audit history after cancellation or preemption.
