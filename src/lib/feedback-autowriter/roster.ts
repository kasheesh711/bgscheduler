/**
 * The constrained-rollout roster: the only Wise teacher accounts the
 * autowriter may write for. Each tutor has two Wise accounts, the "… Online"
 * one and their main one, and teaches online from either (Gift's online classes
 * are all on her main account). Both are listed; in-person classes on either
 * are skipped by Wise's session type (`OFFLINE`), checked before anything else.
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
  // Main accounts, added 2026-09-29 (owner decision): in the 30 days before,
  // they held 8 online classes (Gift 7, Mimi 1) and 222 in-person ones.
  {
    wiseUserId: "695369c028118f629edcb986",
    displayName: "Kevin (Kev) Y. Hsieh",
    canonicalKey: "Kevin",
    tutorNames: ["Kevin Hsieh", "Kev"],
  },
  {
    wiseUserId: "695369c028118f629edcb9cb",
    displayName: "Wanwisa (Gift) Montrikittiphant",
    canonicalKey: "Gift",
    tutorNames: ["Wanwisa Montrikittiphant", "Gift"],
  },
  {
    wiseUserId: "695369c028118f629edcba05",
    displayName: "Apivit (Ek) Sirithana",
    canonicalKey: "Ek",
    tutorNames: ["Apivit Sirithana", "Ek"],
  },
  {
    wiseUserId: "695369c028118f629edcbd79",
    displayName: "Kasidej (Peat) Jungrakangthong",
    canonicalKey: "Peat",
    tutorNames: ["Kasidej Jungrakangthong", "Peat"],
  },
  {
    wiseUserId: "695369c028118f629edcbaf3",
    displayName: "Thanit (Mimi) Montrikittiphant",
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

/** A tutor's name without the account suffix, e.g. "Wanwisa (Gift) Montrikittiphant". */
export function tutorLabel(tutor: Pick<AutowriterTutor, "displayName">): string {
  return tutor.displayName.replace(/ Online$/u, "");
}

/** All of a tutor's roster accounts (both Wise accounts). */
export function rosterAccountIds(canonicalKey: string): string[] {
  return AUTOWRITER_ROSTER.filter((tutor) => tutor.canonicalKey === canonicalKey).map((tutor) => tutor.wiseUserId);
}

/** One entry per tutor, in roster order, with every account they teach from. */
export const AUTOWRITER_TUTORS: ReadonlyArray<{ canonicalKey: string; label: string; wiseUserIds: readonly string[] }> =
  [...new Set(AUTOWRITER_ROSTER.map((tutor) => tutor.canonicalKey))].map((canonicalKey) => {
    const accounts = AUTOWRITER_ROSTER.filter((tutor) => tutor.canonicalKey === canonicalKey);
    return { canonicalKey, label: tutorLabel(accounts[0]), wiseUserIds: accounts.map((tutor) => tutor.wiseUserId) };
  });
