# BeGifted LINE OA Resolver

Internal unpacked Chrome extension for bulk LINE parent linking.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder: `extensions/line-oa-resolver`.

## Use

1. Open Scheduler `/line-review`.
2. Open **Bulk OA resolver** and create a run.
3. Copy the token.
4. Open `https://chat.line.biz/` while signed in.
5. Open the extension, paste the Scheduler URL and token, then click **Start / resume**.
6. Leave the LINE OA tab open while it searches each student code.
7. Resolve pauses manually when the extension cannot pick one chat safely.
8. Return to Scheduler, review matched rows, and commit suggested links.

The extension stores no screenshots. It sends only student-code search results and captured LINE OA chat URLs back to Scheduler.

If Chrome says the receiving end does not exist, refresh the LINE OA tab and reload the extension from `chrome://extensions`. Existing LINE OA tabs opened before extension install/reload may not have the content script attached yet.
