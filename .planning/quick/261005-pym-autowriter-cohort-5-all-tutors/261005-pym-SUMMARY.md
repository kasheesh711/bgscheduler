---
quick_id: 261005-pym
status: complete
pr: 163
---

# Summary: autowriter cohort 5 (all online tutors)

- Roster 27 → 48 tutors (96 accounts), all Luna first; online-class share 750/860 → 860/860.
- Redaction is word by word, so variants with English words were dropped (Shop, Win, Sunday, Key, Art nicknames;
  "Than", "Rod-em", "Jr."). New `selfNames` keeps them recognisable as the tutor in guest detection.
- `loadUncoveredTutors` (advisory, isolated) lists online tutors missing from the roster on the gate details.
- Expansion wording retired; the gate card reads "Accuracy gate".
- Verified: 896 unit, 163 integration, typecheck/lint clean; code review CLEAR after M1/M2 fixes. Draft PR #163.
