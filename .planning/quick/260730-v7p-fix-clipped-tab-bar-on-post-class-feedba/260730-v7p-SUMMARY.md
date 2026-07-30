---
id: 260730-v7p
status: complete
completed: 2026-07-30
commits:
  - be74191 fix(post-class-feedback): stop the workspace tab bar from clipping its labels
---

# Quick Task 260730-v7p — Summary

The `/post-class-feedback` tab row (Operations · Analytics · Deductions · Payouts · Audit ·
Settings) rendered with the label text sliced horizontally and the active-tab underline missing.
Two compounding causes, both on the single `TabsList` at
[post-class-feedback-workspace.tsx:251](src/components/post-class-feedback/post-class-feedback-workspace.tsx:251).

## Cause 1 — the `h-10` on the list never applied

The shadcn primitive ([ui/tabs.tsx:26](src/components/ui/tabs.tsx:26)) carries
`group-data-horizontal/tabs:h-8`. `data-horizontal` is a shadcn-supplied custom variant
(`node_modules/shadcn/dist/tailwind.css`) that expands to `&:where([data-orientation="horizontal"])`
— `:where()` contributes zero specificity, so the compiled selector scores (0,1,0), exactly tying
the plain `.h-10` utility. `tailwind-merge` does not treat a variant class as conflicting with a
bare one, so both survive `cn()` and stylesheet order breaks the tie: the variant is emitted later
and wins. **The list was 32px, not the intended 40px.**

Worth knowing beyond this page: any `h-*` written on a `TabsList` in this codebase is silently
ignored unless it is marked important.

## Cause 2 — `overflow-x-auto` clipped the row vertically

Setting one overflow axis to a non-`visible` value makes the other compute from `visible` to `auto`,
so the list was a scroll container on both axes. When a horizontal scrollbar is present (classic
always-visible scrollbars, or a viewport narrow enough for six tabs to overflow) it consumes ~15px
of the fixed 32px. Triggers are `h-[calc(100%-1px)]` — a percentage of the list's content box — so
they collapsed from 24px to ~9px while the 20px line-height text stayed put. The text overflowed its
own trigger and `overflow-y` sliced it. The same clip hid the underline, drawn outside the trigger
box at `after:bottom-[-5px]`.

## Fix

Horizontal scrolling moved to a wrapper `div` (`mb-3 max-w-full overflow-x-auto pb-1`) whose height
is content-driven, so a scrollbar adds height below the row instead of stealing it from the row. The
list became `h-10! w-max min-w-full justify-start gap-4 border-b px-1` — `h-10!` wins on specificity
rather than on source order, and `w-max min-w-full` fills the width when the tabs fit and overflows
into the wrapper's scroll when they do not. `pb-1` keeps the underline inside the wrapper's clip box.

`src/components/ui/tabs.tsx` was deliberately left alone — it is shared with every other tabbed page.

## Verification

No dev server or authenticated session was available locally, so the page itself was not driven.
Instead a standalone repro was generated from the project's own `globals.css`, compiled through
`@tailwindcss/postcss`, using the real `cn()`-merged class strings and base-ui's DOM shape
(`data-orientation="horizontal"` on both root and list), then measured in a browser with a forced
15px horizontal scrollbar:

| Markup | List height | Trigger height | Labels |
|---|---|---|---|
| Before | 32px | 9px | clipped |
| After | 40px | 32px | intact, underline visible |

`npm run typecheck` clean · `npm run lint` 0 errors (16 pre-existing warnings) ·
`npm test` 3872 passed / 346 files.

Still unconfirmed against the live page: the exact condition that produced the scrollbar in the
reporter's browser (classic scrollbars are the likely trigger — one is visible in their screenshot).
The fix removes the failure mode regardless of which condition supplied it.
