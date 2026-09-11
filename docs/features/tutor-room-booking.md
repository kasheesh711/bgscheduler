# Tutor room booking

**Status: implemented; collector and new reservations require explicit enablement.**

Tutors use `/room` in a private LINE chat or an admin-enabled staff/tutor group to see their classes, assigned rooms, and free rooms today. They can reserve standalone room time through LINE cards, typed commands, or a private mobile timetable. All copy is English; times are Asia/Bangkok.

## Booking rules

- Today only, 07:00–21:00. Scheduled starts and ends use 15-minute steps; the minimum duration is 15 minutes. `now` permits an immediate start. One tutor cannot hold overlapping standalone reservations, even in different rooms.
- Rooms must be free for the whole interval. Adjacent reservations are allowed. Active assignable rooms include the online booths; room names and `(TV)` aliases map to a single physical room.
- Standalone reservations are stored locally. They do not create, reschedule, or move Wise classes. They block classroom generation, reconciliation, overrides, publish destinations, and temporary rooms used in publish swap cycles.
- Wise classes take priority. A refreshed Wise class that overlaps a confirmed room reservation preempts the whole reservation, preserves its audit, and queues a private LINE notification. Tutors choose a replacement themselves.
- Availability reads use persisted evidence. A complete Wise room refresh is required within five minutes. Missing, incomplete, or stale evidence cannot advertise new bookable intervals. Cancellation still works during an outage.

## Tutor flow

| Command | Result |
|---|---|
| `/room` | My classes, room assignments, reservations, and rooms free now with “free until” times |
| `/room free 14:00 15:00` | Rooms free for the whole interval |
| `/room book Focus 14:00 15:00` | Preview and confirmation; `now` also works as the start |
| `/room confirm <confirmation-id>` | Confirm the preview, with a fresh transactional conflict check |
| `/room bookings` | Reservations and cancellation controls |
| `/room cancel <booking-id>` | Cancel an owned reservation and release its remaining time |
| `/room web` | DM a private mobile timetable link |
| `/room help` | Command reference |

Buttons provide the same actions, native start/end pickers, and paginated room cards. Confirmations expire in five minutes and are bound to the tutor and conversation. Other tutors cannot reuse them. Room events bypass the parent AI classifier and the existing admin-only scheduler router.

The mobile page provides My day, Available rooms, and My bookings, with a room timeline. It refreshes while visible every 30 seconds and after changes. Group responses contain no student names, and room occupancy reveals no other tutor identifiers. Mobile capability links are delivered only by DM, expire after 60 minutes or Bangkok midnight, and allow their holder to book as that tutor. They are never placed in the group response.

## Administration and identity

An unlinked tutor DMs `/room` to create a pending access request. **Tutor Profiles → Tutor LINE access** lets an admin verify the person and select their stable tutor profile. No automatic matching by display name occurs. One active tutor profile maps to one LINE user. Approval does not grant access to `/schedule`, `/credit`, `/report`, or admin pages.

An existing bot admin enables a group using `/schedule setup staff`, then `/room setup on`. `/room setup off` disables room commands. Both the staff audience and room enablement are checked on subsequent requests.

**Class Assignments → Room reservations** lists and cancels standalone reservations. The floor plan, room calendar, and heat map include reservation overlays; their popovers direct administrators to the reservation tab rather than offering a Wise room override. Revoking tutor access invalidates grants and confirmations and cancels remaining reservations.

## Reliability

A Postgres day row serializes booking commits. A persisted day lease excludes assignment and publish writers while they perform Wise I/O without holding a database transaction. Ending a writer lease invalidates old room evidence. The collector claims a separate refresh lease, checks day revisions before promoting evidence, and does not steal an unexpired writer lease. Abandoned writer leases can be cleared after 15 minutes, longer than the existing 800-second route limit, with evidence invalidated before recovery.

Wise collection validates future and same-day past pagination, retains completed class history, and verifies missing known sessions individually. Unknown room occupancy blocks the relevant interval. Online sessions need proof that they have no onsite connection before being treated as remote. Classroom plans reserve pending destinations until verified cancellation or a time change supersedes them.

Webhook IDs, reservation idempotency keys, and durable notification retry keys prevent duplicate effects. A five-minute cron refreshes room evidence during 06:55–21:05 Bangkok and retries notifications and interrupted room commands. It fires at UTC minutes 4, 9, 14, …, 59 to avoid the existing cron minute slots.

See [API and persistence](../reference/api/tutor-room-booking.md) and [enablement and recovery](../operations/tutor-room-booking.md).
