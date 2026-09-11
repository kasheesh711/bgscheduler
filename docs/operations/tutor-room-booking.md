# Enable and operate tutor room booking

The feature ships with new reservations and Wise collection off by default. Existing reservations always remain blockers, even when new booking writes are disabled.

1. Apply the additive `0081_tutor_room_booking.sql` migration through the normal Drizzle migration procedure before deploying code that reads the new tables.
2. In the target environment, set `ROOM_BOOKING_COLLECTOR_ENABLED=true`. Keep `ROOM_BOOKING_WRITES_ENABLED` unset or `false`. Existing LINE credentials and `ENABLE_LINE_SCHEDULER` must permit the webhook; set `APP_BASE_URL` to the target app's HTTPS origin.
3. Run **Data Health → Tutor Room Availability** at any time. Confirm a successful, complete refresh and verify the displayed room timetable against Wise. The refresh collects evidence only; it does not generate or publish classroom assignments.
4. Have the test tutor add/message the Official Account and DM `/room`. In **Tutor Profiles → Tutor LINE access**, verify and approve their tutor identity. Ensure the account can receive DMs before relying on private links and conflict notifications.
5. For group access, an existing `LINE_SCHEDULE_BOT_ADMIN_IDS` admin runs `/schedule setup staff`, then `/room setup on` in the intended tutor group.
6. In a test environment, set `ROOM_BOOKING_WRITES_ENABLED=true` and verify a free room booking, cancellation, mobile link, and conflict notification. After this check, enable the write flag in production and verify one intended real reservation with the linked tutor.

The cron runs every four minutes, around the clock, at UTC minutes 1, 5, 9, …, 57. It shares one complete future-session read across today and tomorrow and retains failed dates’ previous evidence independently. This cadence deliberately overlaps some other crons but avoids the heavy half-hour Wise snapshot. Refresh/day leases continue to serialize competing room operations. If evidence is more than five minutes old, tutors can view prior schedules and cancel reservations but cannot create new ones.

## Recovery

- Disable **new bookings** with `ROOM_BOOKING_WRITES_ENABLED=false`. Keep the collector active so existing reservations continue to reconcile and notify. This does not remove reservations from the classroom allocator.
- A room occupied by a later Wise class preempts the entire overlapping reservation. Review the state in **Class Assignments → Room reservations**. The tutor receives a private notification and chooses another slot.
- Failed LINE notifications retain their retry key and are retried by the cron. Inspect `room_notifications.last_error`, `attempts`, and `sent_at` when investigating delivery. The bot must be able to DM that user.
- After a crashed classroom writer, booking stays unavailable until its 15-minute lease expires and the collector verifies new evidence. Do not manually clear an unexpired lease while publishing is running.
- If the room list is empty, initialize the normal classroom catalog through Class Assignments. If identities or locations are ambiguous, resolve them in the existing admin tools and let the collector refresh; do not treat missing evidence as an empty room.
- Revoke a tutor through Tutor Profiles to invalidate their private links and release remaining reservations. Approving a different LINE account requires revoking the existing approved link first.

## Local verification

Use only a disposable local PostgreSQL database. The integration suite migrates and truncates its target.

```bash
TEST_DATABASE_URL=postgresql://room_test@127.0.0.1:55439/room_booking_test npx vitest run --project integration src/lib/room-booking/__tests__/booking.integration.test.ts
```

For the browser smoke test, start the app on port 3311 with `DATABASE_URL` pointing to the same scratch database, `ROOM_BOOKING_WRITES_ENABLED=true`, and `ROOM_BOOKING_COLLECTOR_ENABLED=false`. Start the test server with the local-only driver preload (production continues to use Neon HTTP):

```bash
TEST_DATABASE_URL=postgresql://room_test@127.0.0.1:55439/room_booking_test DATABASE_URL=postgresql://room_test@127.0.0.1:55439/room_booking_test ROOM_BOOKING_WRITES_ENABLED=true ROOM_BOOKING_COLLECTOR_ENABLED=false ENABLE_LINE_SCHEDULER=false NODE_OPTIONS="--require ./scripts/room-browser-db.cjs" npm run dev -- --port 3311
```

Then run:

```bash
TEST_DATABASE_URL=postgresql://room_test@127.0.0.1:55439/room_booking_test node scripts/verify-room-booking.mjs
```

The script refuses remote database/app hosts, uses a synthetic linked tutor, verifies booking/cancellation and expired access, and saves light/dark screenshots under `/tmp/room-browser-artifacts`. It does not call Wise or send LINE messages. It can run at any time; it books tomorrow morning.

## Diagnosing a zero-room report

Check the selected date and interval first. Stale evidence, unresolved locations, and invalid times render explicit messages rather than a zero-room count. Class Assignments → Room reservations shows the selected date’s freshness and unresolved intervals. Online classes with blank Wise locations can use current matching Class Assignments rooms; they do not require an OFFLINE-only Wise publication. Check both dates after deployment and confirm the collector runs overnight. No database migration is required for next-day support; the original room-booking tables already carry dates.
