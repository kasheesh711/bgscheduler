# Phase 6: MOD-01 Reliable Modality Detection - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 6-mod-01-reliable-modality-detection
**Areas discussed:** Confidence rubric, Contradiction policy, Icon set + placement + low-confidence UX, CACHE_VERSION scope

---

## Confidence rubric

### Single-record group + no sessionType — tier?

| Option | Description | Selected |
|--------|-------------|----------|
| high | Single record = only one possible modality; no ambiguity even without sessionType. Matches research Pitfall 2 scheme. | ✓ |
| medium | Treat missing sessionType as a data gap regardless of group shape. More conservative. | |
| unknown + data_issue | Strictest fail-closed — require sessionType on every session. Will spike /data-health count heavily. | |

**User's choice:** high (Recommended)
**Notes:** Single-record groups are structurally unambiguous. No need to demand a signal that can only say what we already know.

### Paired group + sessionType missing — treatment?

| Option | Description | Selected |
|--------|-------------|----------|
| low tier (labeled with caveat) | Return modality from isOnlineVariant with confidence='low'. UI treats 'low' visually like unknown but preserves inferred label in data for /data-health. Keeps 3-tier richness. | ✓ |
| collapse to unknown | Skip low tier entirely — 2 tiers (high/medium) + unknown. Simpler, strictest fail-closed. | |
| medium tier | Show inferred label with slightly less visual confidence than full-high. Blurs the rubric. | |

**User's choice:** low tier (Recommended)
**Notes:** Data-layer keeps the inference; UI honors fail-closed; /data-health can distinguish "inferred without corroboration" from "truly unresolved."

### sessionType synonym normalization?

| Option | Description | Selected |
|--------|-------------|----------|
| Match existing cascade | Treat {online, virtual} → online and {onsite, in-person, offline} → onsite (matches current ONLINE_SESSION_TYPES/ONSITE_SESSION_TYPES sets in compare.ts:4-5). Zero regression risk. | ✓ |
| Exact-match only | Only 'online' and 'onsite' count; others become missing sessionType. Strictest but loses data. | |
| Expand synonym set | Also match 'remote', 'classroom', 'face-to-face', etc. Fragile — Wise doesn't document full set. | |

**User's choice:** Match existing cascade (Recommended)
**Notes:** Zero regression, existing tests anchor on these sets.

---

## Contradiction policy

### Paired group, isOnlineVariant vs sessionType disagreement — output?

| Option | Description | Selected |
|--------|-------------|----------|
| 'unknown' + emit data_issue | Fail-closed. Use existing dataIssueTypeEnum 'conflict_model' tagged to the session. Matches research Pitfall 2. /data-health gets a new visible signal. | ✓ |
| Trust sessionType, mark medium | sessionType is session-specific; isOnlineVariant is teacher-record which admins mis-file. Softer but drifts from fail-closed. | |
| Trust isOnlineVariant, mark medium | Teacher record is authoritative. But research Pitfall 2 calls this out as a known upstream data-entry error case. | |

**User's choice:** 'unknown' + emit data_issue (Recommended)
**Notes:** Fail-closed over pragmatism. conflict_model enum already exists — no schema change.

### Single-record group, sessionType disagrees with only possible modality — treatment?

| Option | Description | Selected |
|--------|-------------|----------|
| 'unknown' + data_issue | Consistent with paired-group disagreement. Fail-closed. Surfaces data quality issue. | ✓ |
| Trust the single record (high) | Record structure is unambiguous — sessionType is a typo. Pragmatic but silent. | |
| Trust the sessionType (unknown group) | Fail-closed across both signal + structure. | |

**User's choice:** 'unknown' + data_issue (Recommended)
**Notes:** Consistency wins over pragmatism. Both disagreement paths handled the same way.

### /data-health surfacing?

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing modality counter | Keep single 'Modality issues' counter (route.ts:65); add new conflict_model issues into the same bucket. One number tells the truth. | ✓ |
| Split counter by tier | Show separate 'Unresolved modality' + 'Conflicting modality' counts. More info but more UI surface. | |
| Add a confidence breakdown | Show {high, medium, low, unknown} counts across all sessions. Rich but speculative — delays the phase. | |

**User's choice:** Extend existing modality counter (Recommended)
**Notes:** Post-deploy rise is expected (surface-of-reality); documented in verification template.

---

## Icon set, placement & low-confidence UX

### Lucide icon set for modality states?

| Option | Description | Selected |
|--------|-------------|----------|
| Video / MapPin / HelpCircle | Online=Video camera, Onsite=MapPin, Unknown=HelpCircle. Clean semantics; already in lucide-react. | ✓ |
| Wifi / Building / AlertCircle | Online=Wifi, Onsite=Building, Unknown=AlertCircle (stronger 'needs review' signal). | |
| Laptop / Users / HelpCircle | Online=Laptop, Onsite=Users, Unknown=HelpCircle. Less scheduling-standard. | |

**User's choice:** Video / MapPin / HelpCircle (Recommended)

### Icon placement on session cards?

| Option | Description | Selected |
|--------|-------------|----------|
| Top-right corner chip | Small icon (w-3 h-3) in top-right, same weight as conflict badge. Doesn't fight title/time layout. Hover/click opens existing popover. | ✓ |
| Inline with time | Icon immediately before/after the time string. Integrates with text; risks narrow-card overflow in 3-tutor view. | |
| Popover-only (no card glyph) | Modality shown only in popover. Minimal visual weight; loses at-a-glance — doesn't satisfy MOD-04. | |

**User's choice:** Top-right corner chip (Recommended)

### Low-confidence card rendering?

| Option | Description | Selected |
|--------|-------------|----------|
| Render identical to unknown | HelpCircle icon for both low and unknown. Popover reveals 'Likely online — unconfirmed'. Matches research Pitfall 3. | ✓ |
| Inferred icon + muted treatment | Video/MapPin at reduced opacity with popover caveat. Preserves at-a-glance but admins may mis-read. | |
| Inferred icon + small '?' badge | Video/MapPin with superscript '?' glyph. Explicit but noisy at narrow widths. | |

**User's choice:** Render identical to unknown (Recommended)
**Notes:** Data-layer still carries the inferred modality for /data-health.

### Popover label wording?

| Option | Description | Selected |
|--------|-------------|----------|
| Terse: Online / Onsite / Unknown | One word per state. No confidence phrasing on-screen; confidence lives in data/data-health. | ✓ |
| With confidence: Online (verified) / Online (likely) / Unknown | Surfaces high vs medium vs low explicitly. More info but more decisions pushed to user. | |
| Verbose: Online session / Onsite session / Modality unknown — check Wise | Full sentences; directs action on unknown. Wordy for a popover. | |

**User's choice:** Terse — Online / Onsite / Unknown (Recommended)
**Notes:** Low renders identically to unknown except popover reveals 'Likely online/onsite — unconfirmed'.

---

## CACHE_VERSION scope

### Where does the CACHE_VERSION constant live?

| Option | Description | Selected |
|--------|-------------|----------|
| src/lib/search/cache-version.ts | Dedicated one-line module alongside other search utilities. Clean import surface, greppable, matches project convention. | ✓ |
| Colocated in src/hooks/use-compare.ts | Lives next to only current consumer. Zero new file, but future consumers pulling from a hook file is awkward. | |
| src/lib/constants.ts (new barrel) | General constants module. Over-abstracts for a single constant. | |

**User's choice:** src/lib/search/cache-version.ts (Recommended)

### What does CACHE_VERSION namespace?

| Option | Description | Selected |
|--------|-------------|----------|
| Only tutorCache Map keys | Append to ${tutorGroupId}:${weekStart} → ${tutorGroupId}:${weekStart}:${CACHE_VERSION}. Only client-side cache carrying modality shape change. | ✓ |
| tutorCache + recent-searches localStorage | Also version recent-searches. Adds safety if we ever persist richer shapes. Speculative today. | |
| Any client persistence boundary | Policy-only. Good discipline, no concrete enforcement. | |

**User's choice:** Only tutorCache Map keys (Recommended)

### Starting value for CACHE_VERSION?

| Option | Description | Selected |
|--------|-------------|----------|
| 'v1' with bump-on-shape-change comment | Simple monotonic. Comment explains bump rule for future v1.1 phases. Matches research Pitfall 14. | ✓ |
| 'mod-01-v1' (phase-tagged) | Encodes introducing phase. Readable but collides with bump policy — future phases shouldn't rename the prefix. | |
| Git commit short-hash | Auto-invalidate per commit. Requires build-time injection. Overkill. | |

**User's choice:** 'v1' with bump-on-shape-change comment (Recommended)

---

## Claude's Discretion

Areas explicitly left to planner / executor per CONTEXT.md D-23..28:
- Typing choice for confidence signal (object vs sibling field vs discriminated union)
- Resolver internal structure (single function vs split into classify/score/emit)
- Popover markup details (extend TutorProfilePopover vs new SessionModalityPopover)
- Group-level deriveModality review (planner confirms no change needed)
- MOD-01 kickoff validation query (WiseSession.type NULL rate)
- Test matrix size (representative subset, minimum bar documented in CONTEXT.md)
- Commit cadence (atomic per-concern is fine)

## Deferred Ideas

- MOD-06 modality filter dropdown (v1.2)
- MOD-07 modality summary in tutor profile popover (v1.2)
- Admin override UI (v1.2+)
- Dashed-vs-solid border restoration (PERMANENTLY rejected — research Pitfall 3)
- New data_issue enum types (conflict_model is sufficient)
- Runtime CACHE_VERSION enforcement (grep discipline only)
- Group-level deriveModality refactor (out of MOD-01 scope)
- WiseSession.type presence as a phase blocker (planner scopes at kickoff)
- Medium-tier emission in MOD-01 implementation (union includes it for future phases)
