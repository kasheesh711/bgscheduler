# Thea weekend bot

Thea (BOT) uses the existing BeGifted Tutors LINE account (@257xgqmk), Messaging API channel 2012273048, at `/api/line/webhook?bot=tutors`. Keep its tutor reminder and form commands. The selected artwork is `public/brand/thea/avatar.png` (concept C).

Enable `THEA_WEEKEND_COMMANDS_ENABLED=true` only after setting `THEA_LINE_GROUP_ID` to the verified BG The Loop group ID. Group names are not an authorization boundary. `APP_BASE_URL` must be the HTTPS application URL. Existing tutor credentials and `AUTH_SECRET` remain in secret storage.

Any member of this one group can send `/จัดตะราง` or `/จัดตาราง`. A valid tutor-channel signature is required. Other groups and direct messages are ignored. The receipt is stored before acknowledgement. Duplicate webhook event IDs cannot create duplicate requests.

The weekend is the upcoming Saturday/Sunday in Bangkok; Sunday remains part of the current weekend. The worker creates missing saved allocations only. Existing plans, overrides and started classes stay intact. Changed classes or newly added classes require Kevin's review. Eligible unchanged room assignments are published with the existing global publisher and per-day locks. Thea checks its active request lease before every Wise write. Background automation remains paused.

The webhook starts processing after its response. The existing five-minute publish-recovery cron resumes pending Thea requests before ordinary recovery. Both handlers have an 800-second limit. A lease lasts 15 minutes; stages save their run IDs and results. Failed stages retry up to three times; retrying the command preserves saved allocations. The two queue tables are introduced by migration 0125.

The PDF link includes a keyed capability. Only its hash is stored; its plaintext is reconstructed for retry-safe delivery. It expires at Tuesday 00:00 Bangkok immediately after the weekend (the end of Monday). Forwarded links work until expiry. The link grants only the two saved runs. Changing the bound group or disabling Thea revokes access.

`/weekend-schedule/{token}` returns a private, non-cacheable A4 landscape PDF. Its protected-by-token `/print` page reuses the existing classroom print components for both room and tutor views, refreshes exact Wise rosters, checks current revisions, and labels changed plans as draft. Failed roster verification blocks export. Chromium is the existing installed renderer; external asset requests are blocked.

## Activation and acceptance

Verify the account in LINE Manager; set its name to Thea (BOT), upload the C avatar, and preserve its existing webhook and tutor groups. LINE permits one OA in a group, so inspect BG The Loop before replacing an existing OA there. Do not migrate other groups. Before binding a group ID, send `/จัดตาราง` once. The signed tutor webhook logs only `THEA_GROUP_DISCOVERY` and the verified LINE group ID/name; it does not allocate or publish. Record that ID and verify the intended group before enabling commands.

Apply migration 0125, set the two Thea variables and the base URL, deploy the tested commit, and send one command in BG The Loop. Check request receipt, saved run reuse/creation, eligible Wise location read-back, final LINE delivery and the two-view PDF. Repeating the command must preserve the run IDs. Staff must open the resulting PDF before acceptance is recorded.

To stop this feature, set `THEA_WEEKEND_COMMANDS_ENABLED=false`. This stops command processing, background recovery, capability access and further Thea publishing without enabling or changing other classroom jobs.
