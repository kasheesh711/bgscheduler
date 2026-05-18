# Wise Location Catalog Cleanup Checklist - 2026-05-16

Generated after the guarded plain TV-room cleanup dry-run/probe.

## Preconditions
- [ ] `npm run wise:plain-tv-cleanup -- --verify` reports 0 future blocking sessions in invalid plain TV rooms.
- [ ] Exact Wise `(TV)` locations still exist.
- [ ] No class/session deletion is being attempted.

## Invalid Plain TV Locations
- [ ] Remove or deactivate invalid plain Wise location: `Iconic`
- [ ] Remove or deactivate invalid plain Wise location: `Joy`
- [ ] Remove or deactivate invalid plain Wise location: `Keep Going`
- [ ] Remove or deactivate invalid plain Wise location: `Never Ever`
- [ ] Remove or deactivate invalid plain Wise location: `Relax`
- [ ] Remove or deactivate invalid plain Wise location: `Turn The Page`
- [ ] Remove or deactivate invalid plain Wise location: `Remember`
- [ ] Remove or deactivate invalid plain Wise location: `Here There`
- [ ] Remove or deactivate invalid plain Wise location: `Go All In`
- [ ] Remove or deactivate invalid plain Wise location: `Doubt`
- [ ] Remove or deactivate invalid plain Wise location: `Big Memories`

## Non-mutating API Probe
- Probe not run in this command.

## Manual Admin Steps
1. Open the Wise location/admin catalog.
2. Remove or deactivate only the 11 invalid plain TV names listed above.
3. Keep the exact `(TV)` locations unchanged.
4. Re-run `npm run wise:plain-tv-cleanup -- --verify` and confirm the session count is still 0.

## Current Session Cleanup Summary
- 20 invalid future blocking session occurrence(s); 1 distinct Wise class(es); 20 proposed session update(s); 0 manual-required item(s)
- Confirmation token for current session repair plan: `all:20`
