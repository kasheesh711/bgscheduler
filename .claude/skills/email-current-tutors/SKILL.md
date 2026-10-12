---
name: email-current-tutors
description: Draft a BeGifted-branded email to every tutor who is teaching now (an upcoming class, or a class in the last 30 days) as a Gmail draft with the tutors in BCC. Use when staff ask to email, announce or send an update to all current tutors or teachers. Only drafts; a person sends it from Gmail.
---

# Email current tutors

Build a BeGifted email (v3 company design) for every tutor who is teaching now and leave it as a **draft** in the
sender's Gmail. You never send it: the sender reviews the draft in Gmail and presses Send.

This folder (`.claude/skills/email-current-tutors/`) holds `build-email.mjs` and the bundled `renderer/`. Run
commands from the repository root.

## Hard rules

- Never call a tool that sends email (`send_message`, `reply`, `forward` or similar). Only create or update drafts.
- Tutors go in **BCC only**, never To or CC.
- Stop if there are more than 450 recipients (Gmail allows 500 per message).
- Keep the recipient list out of the repository, commits, uploads and other chats. Put working files in a new
  folder under the OS temp directory (`node -e "console.log(require('os').tmpdir())"`).
- Use only facts the sender gives you. Ask for any missing date, time, link or policy detail; never invent one.
- Write the email in English.

## 1. Get the list

The list comes from BGScheduler: `https://bgscheduler.vercel.app/api/tutor-offboarding/current-tutors`. The
sender must be signed in to BGScheduler with access to Tutor Offboarding.

- **A browser tool is available** (the desktop app's built-in browser, or Claude in Chrome): open that URL and read
  the page text. It is JSON. If you see a sign-in page or any HTML instead, ask the sender to sign in to
  BGScheduler in that browser, then reload.
- **No browser tool**: ask the sender to open
  `https://bgscheduler.vercel.app/api/tutor-offboarding/current-tutors?format=csv` in their own browser and tell
  you the downloaded file's path. The file is UTF-8 with a BOM and has the columns `name,email,reason`. Drop the
  BOM. A name that starts with `'` had that apostrophe added to defuse spreadsheet formulas, so drop it too. The
  CSV holds recipients only; if the sender wants the review lists below, they can open the JSON URL.

JSON fields:
- `recipients`: `name`, `email`, `reason` (`upcoming` = has a future class; `recent` = taught in the last 30 days).
- `needsEmail`: people teaching now whose address is unknown or ambiguous, with `candidates`.
- `excludedConfirmed`: people still teaching who are crossed out in the tutor sheet, left out on purpose.
- `stale`, `unmatchedSheetRows`, `snapshotCreatedAt`.

`{ "available": false, "reason": … }` means BGScheduler has no list right now. Stop and tell the sender the reason.
If the JSON has an `error` field instead, show it to the sender and stop. `Unauthorized` means they need to sign
in again; `Forbidden` means their account does not have Tutor Offboarding access, which Kevin can grant.

## 2. Confirm the recipients

Show the sender, in this order:
1. "N tutors will be BCC'd", with their names in a compact list.
2. Each `needsEmail` person with the candidate addresses. The sender picks one, types one, or skips the person.
3. The `excludedConfirmed` names: "still teaching but crossed out in the tutor sheet, not included".
4. Warnings:
   - `stale: true`: "BGScheduler's data is older than usual (snapshot at <snapshotCreatedAt>)."
   - `unmatchedSheetRows > 0`: "N crossed-out rows in the tutor sheet could not be matched to a tutor. Check
     Tutor Offboarding if one of them might still be on this list."

The sender may add or remove addresses. **Wait for an explicit yes.** If there are zero recipients, stop.

## 3. Write the email

Agree the content with the sender, then choose a template:
- `event`: a dated event. Needs `eventDetails`, a list of `{ "label": …, "value": … }` (date, time, place).
- `programme`: an announcement with details and one main action. Optional `programmeDetails` (same shape).
- `newsletter`: anything else.

Save the spec as `spec.json` in the temp folder:

```json
{
  "template": "newsletter",
  "subject": "[BeGifted] …",
  "preheader": "One-line inbox preview",
  "title": "Headline",
  "greeting": "Dear tutors,",
  "paragraphs": ["First paragraph.", "Second paragraph."],
  "sections": [{ "heading": "What to do", "paragraphs": ["…"], "bullets": ["…"] }],
  "action": { "label": "Open the form", "url": "https://…" }
}
```

Required fields: `template`, `subject`, `preheader`, `title`, `paragraphs`. Optional: `subtitle`, `greeting`,
`sections`, `action`, `eventDetails`, `programmeDetails`. Every value is plain text, never HTML. Links must be
full `https://` addresses.

## 4. Render and preview

```bash
node .claude/skills/email-current-tutors/build-email.mjs <temp-folder>/spec.json --out <temp-folder>/out
```

The script writes `email.html`, `email.txt` and `subject.txt`. If it prints `Could not build the email: …`, fix
the spec and run it again. Show the sender `email.txt`. If a browser tool is available, open `email.html` so they
can see the design. Revise until the sender approves the content.

## 5. Create the Gmail draft

Use the Gmail connector's `create_draft` tool. If it is deferred, load it with ToolSearch (query
`gmail create_draft`). Ask which address the draft should go To; normally that is the sender's own address. Call:
- `to`: [the sender's address]
- `bcc`: every confirmed recipient address, exactly as confirmed
- `subject`: the contents of `subject.txt`
- `htmlBody`: the contents of `email.html`
- `body`: the contents of `email.txt`

Then read the draft back with the connector's `get_draft` and compare its BCC addresses with the confirmed list.
They must match exactly, with the same count and the same addresses. If they differ, correct the draft with
`update_draft` and check again.

If there is no Gmail connector, tell the sender: "Connect Gmail in claude.ai → Settings → Connectors, then run
this again." Meanwhile offer the manual fallback: the path of `email.html`, and the BCC list as one
comma-separated line to paste into Gmail's BCC field.

## 6. Hand back

Give the sender the draft's `viewUrl` and the count, for example: "Draft ready with 58 tutors in BCC: <viewUrl>.
Review it in Gmail and press Send." Do not send it.
