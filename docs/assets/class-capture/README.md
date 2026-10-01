# Class Capture synthetic acceptance evidence

These screenshots show the real Class Capture React components at 390 × 844 and
1440 × 1080. All names, sessions, transcripts, worksheet images, microphone data,
and API responses are fictional. No person was recorded and no provider was called.

Run `node scripts/dev/verify-class-capture.mjs` from the repository root. It bundles
the existing component and design-system CSS, starts a temporary localhost server,
and uses headless Chrome. The harness substitutes the microphone and Blob upload
client and blocks requests outside that localhost origin. It is not an application
route, production fixture, login bypass, or live-provider test.

- `mobile-select-class.png`: scheduled session selection.
- `mobile-consent.png`: participant, guardian, and named-provider attestations.
- `mobile-recording.png`: visible recording and the persistent Stop control.
- `mobile-review.png`: editable draft and the tutor’s review responsibility.
- `mobile-handoff.png`: saved review, copy, and explicit Wise submission handoff.
- `desktop-capture.png` / `desktop-review.png`: wider layouts.
- `mobile-paused.png`: default-off behavior.
- `acceptance-results.json`: outcomes and synthetic request counts.

The checks exercise permission denial, cancellation of a delayed permission
response, stopping on background, real IndexedDB recovery across reload, account
isolation, upload interruption/cancellation/retry with one asset intent, explicit
transcription, worksheet permission, draft regeneration, uncertain-provider
evidence removal, and saved-review gating. Touch controls are checked at 44 px or
larger and the mobile document is checked for horizontal overflow.

Unverified: real iOS/Android microphone and lockscreen behavior; browser or OS
termination during a chunk write; live private Blob uploads and multipart behavior;
Soniox language quality; OpenRouter output; production grants, snapshots and
migrations; Wise submission. The synthetic audio bytes are a transport fixture,
not a playable recording. Browser recovery is best effort and does not promise
background recording or resuming an unfinished multipart upload across reload.
