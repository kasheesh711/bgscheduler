/**
 * The constrained-rollout roster: the only Wise teacher accounts the
 * autowriter may write for. Each entry is a tutor's "… Online" Wise account.
 * `tutorNames` are the variants redacted from text sent to model hosts (never
 * the word "Online", which is ordinary English).
 */
export interface AutowriterTutor {
  wiseUserId: string;
  displayName: string;
  canonicalKey: string;
  tutorNames: readonly string[];
}

export const KEVIN_ONLINE_WISE_USER_ID = "696e2c4343579bbada2340ed";

export const AUTOWRITER_ROSTER: readonly AutowriterTutor[] = [
  {
    wiseUserId: KEVIN_ONLINE_WISE_USER_ID,
    displayName: "Kevin (Kev) Y. Hsieh Online",
    canonicalKey: "Kevin",
    tutorNames: ["Kevin Hsieh", "Kev"],
  },
  {
    wiseUserId: "696f1eee43579bbadad472e5",
    displayName: "Wanwisa (Gift) Montrikittiphant Online",
    canonicalKey: "Gift",
    tutorNames: ["Wanwisa Montrikittiphant", "Gift"],
  },
  {
    wiseUserId: "6976680baf7fbc5ac88c3ea9",
    displayName: "Apivit (Ek) Sirithana Online",
    canonicalKey: "Ek",
    tutorNames: ["Apivit Sirithana", "Ek"],
  },
  {
    wiseUserId: "696e2c4343579bbada233f70",
    displayName: "Kasidej (Peat) Jungrakangthong Online",
    canonicalKey: "Peat",
    tutorNames: ["Kasidej Jungrakangthong", "Peat"],
  },
  // Added 2026-09-29 to reach ≥20% of institution online classes (30-day share:
  // roster 119/841 = 14.1% → with Mimi 201/841 = 23.9%).
  {
    wiseUserId: "696e2c4343579bbada2340f8",
    displayName: "Thanit (Mimi) Montrikittiphant Online",
    canonicalKey: "Mimi",
    tutorNames: ["Thanit Montrikittiphant", "Mimi"],
  },
];

export const AUTOWRITER_TEACHER_ALLOWLIST: ReadonlySet<string> = new Set(
  AUTOWRITER_ROSTER.map((tutor) => tutor.wiseUserId),
);

export function rosterTutor(wiseUserId: string | null | undefined): AutowriterTutor | null {
  return AUTOWRITER_ROSTER.find((tutor) => tutor.wiseUserId === wiseUserId) ?? null;
}
