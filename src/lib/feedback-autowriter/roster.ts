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
  /** The tutor's first writer; unset means Sol (`writersFor` in config.ts). */
  writer?: "luna";
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
  // Added 2026-10-02 (owner decision): 13 tutors, both Wise accounts each, written by GPT-6 Luna first, Sol as
  // their fallback (`writer: "luna"`). Canonical keys are the snapshot's. "Fluke" is Chettaporn, not Fluke-Supha. Anavat's
  // nickname "A" is NOT a name variant: redaction is case-insensitive, so it would replace every article "a".
  {
    wiseUserId: "69f2f50500512973d762b9ad",
    displayName: "Rasna (Ras) Rajkitkul Online",
    canonicalKey: "Ras",
    tutorNames: ["Rasna Rajkitkul", "Ras"],
    writer: "luna",
  },
  {
    wiseUserId: "69f2f61500512973d763f134",
    displayName: "Rasna (Ras) Rajkitkul",
    canonicalKey: "Ras",
    tutorNames: ["Rasna Rajkitkul", "Ras"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233e41",
    displayName: "Chinnakrit (Celeste) Channiti Online",
    canonicalKey: "Celeste",
    tutorNames: ["Chinnakrit Channiti", "Celeste"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcb9c9",
    displayName: "Chinnakrit (Celeste) Channiti",
    canonicalKey: "Celeste",
    tutorNames: ["Chinnakrit Channiti", "Celeste"],
    writer: "luna",
  },
  {
    wiseUserId: "6ab0bdb118d8f4181aacb563",
    displayName: "Takuma (Taki) Notoda Online",
    canonicalKey: "Taki",
    tutorNames: ["Takuma Notoda", "Taki"],
    writer: "luna",
  },
  {
    wiseUserId: "6ab0bcf418d8f4181aac4b82",
    displayName: "Takuma (Taki) Notoda",
    canonicalKey: "Taki",
    tutorNames: ["Takuma Notoda", "Taki"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234179",
    displayName: "Kijpat (Dome) Thavorn Online",
    canonicalKey: "Dome",
    tutorNames: ["Kijpat Thavorn", "Dome"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbab2",
    displayName: "Kijpat (Dome) Thavorn",
    canonicalKey: "Dome",
    tutorNames: ["Kijpat Thavorn", "Dome"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233eb1",
    displayName: "Mandy (Mandy) Boontanrart Online",
    canonicalKey: "Mandy",
    tutorNames: ["Mandy Boontanrart", "Mandy"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbd31",
    displayName: "Mandy (Mandy) Boontanrart",
    canonicalKey: "Mandy",
    tutorNames: ["Mandy Boontanrart", "Mandy"],
    writer: "luna",
  },
  {
    wiseUserId: "697afb13af7fbc5ac8086c40",
    displayName: "Wongsiri (Grace) Montrikittiphant Online",
    canonicalKey: "Grace",
    tutorNames: ["Wongsiri Montrikittiphant", "Grace"],
    writer: "luna",
  },
  {
    wiseUserId: "697afac6af7fbc5ac8084581",
    displayName: "Wongsiri (Grace) Montrikittiphant",
    canonicalKey: "Grace",
    tutorNames: ["Wongsiri Montrikittiphant", "Grace"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234239",
    displayName: "Pornnapha (Mint) Montrikittiphant Online",
    canonicalKey: "Mint",
    tutorNames: ["Pornnapha Montrikittiphant", "Mint"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbcec",
    displayName: "Pornnapha (Mint) Montrikittiphant",
    canonicalKey: "Mint",
    tutorNames: ["Pornnapha Montrikittiphant", "Mint"],
    writer: "luna",
  },
  {
    wiseUserId: "698bddb3b0e4b23fd50633f2",
    displayName: "Chettaporn (Fluke) Chuesuphan Online",
    canonicalKey: "Fluke",
    tutorNames: ["Chettaporn Chuesuphan", "Fluke"],
    writer: "luna",
  },
  {
    wiseUserId: "698bdcc8b0e4b23fd5055a49",
    displayName: "Chettaporn (Fluke) Chuesuphan",
    canonicalKey: "Fluke",
    tutorNames: ["Chettaporn Chuesuphan", "Fluke"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234096",
    displayName: "Calvin (Calvin) Lim Wen Quan Online",
    canonicalKey: "Calvin",
    tutorNames: ["Calvin Lim Wen Quan", "Calvin"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcb9f6",
    displayName: "Calvin (Calvin) Lim Wen Quan",
    canonicalKey: "Calvin",
    tutorNames: ["Calvin Lim Wen Quan", "Calvin"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234167",
    displayName: "Ruke (Lukas) Ogan Online",
    canonicalKey: "Lukas",
    tutorNames: ["Ruke Ogan", "Lukas"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c128118f629edcbf9e",
    displayName: "Ruke (Lukas) Ogan",
    canonicalKey: "Lukas",
    tutorNames: ["Ruke Ogan", "Lukas"],
    writer: "luna",
  },
  {
    wiseUserId: "69daf6e898ee51775fec0aed",
    displayName: "Anavat (A) Siamwala Online",
    canonicalKey: "A",
    tutorNames: ["Anavat Siamwala"],
    writer: "luna",
  },
  {
    wiseUserId: "69d3dea798ee51775f5e21b3",
    displayName: "Anavat (A) Siamwala",
    canonicalKey: "A",
    tutorNames: ["Anavat Siamwala"],
    writer: "luna",
  },
  {
    wiseUserId: "6a848f585bc1ee067e2eb7ae",
    displayName: "Kriangdet (Ohm) Nakprasert Online",
    canonicalKey: "Ohm",
    tutorNames: ["Kriangdet Nakprasert", "Ohm"],
    writer: "luna",
  },
  {
    wiseUserId: "6a848eee5bc1ee067e2e67dc",
    displayName: "Kriangdet (Ohm) Nakprasert",
    canonicalKey: "Ohm",
    tutorNames: ["Kriangdet Nakprasert", "Ohm"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233e8c",
    displayName: "Phurit (Mookie) Bovornchutichai Online",
    canonicalKey: "Mookie",
    tutorNames: ["Phurit Bovornchutichai", "Mookie"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbb83",
    displayName: "Phurit (Mookie) Bovornchutichai",
    canonicalKey: "Mookie",
    tutorNames: ["Phurit Bovornchutichai", "Mookie"],
    writer: "luna",
  },
  // Added 2026-10-02 (owner decision, cohort 4): the next 9 tutors by 1:1 online hours in the 30 days before (Aey 56.4,
  // Mikki 52.0, Sagotty 48.6, Buzz 30.6, Linn 27.2, Eng 22.3, Kavin 20.9, Copter 20.4, Amy 16.1), both Wise accounts
  // each, Luna first like the cohort above. Roster share of online classes: 446/839 (53%) → 725/839 (86%). Eng's
  // nickname is NOT a name variant: "Eng" is also shorthand for English, and redaction is case-insensitive.
  {
    wiseUserId: "696e2c4343579bbada23423d",
    displayName: "Usanee (Aey) Tortermpun Online",
    canonicalKey: "Aey",
    tutorNames: ["Usanee Tortermpun", "Aey"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbb59",
    displayName: "Usanee (Aey) Tortermpun",
    canonicalKey: "Aey",
    tutorNames: ["Usanee Tortermpun", "Aey"],
    writer: "luna",
  },
  {
    wiseUserId: "6a832e195bc1ee067e0976ed",
    displayName: "Parin (Mikki) Notoda Online",
    canonicalKey: "Mikki",
    tutorNames: ["Parin Notoda", "Mikki"],
    writer: "luna",
  },
  {
    wiseUserId: "6a832df55bc1ee067e095509",
    displayName: "Parin (Mikki) Notoda",
    canonicalKey: "Mikki",
    tutorNames: ["Parin Notoda", "Mikki"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada23415b",
    displayName: "Narongsak (Sagotty) Sriwiran Online",
    canonicalKey: "Sagotty",
    tutorNames: ["Narongsak Sriwiran", "Sagotty"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbcc6",
    displayName: "Narongsak (Sagotty) Sriwiran",
    canonicalKey: "Sagotty",
    tutorNames: ["Narongsak Sriwiran", "Sagotty"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234170",
    displayName: "Hassakol (Buzz) Panaspraipong Online",
    canonicalKey: "Buzz",
    tutorNames: ["Hassakol Panaspraipong", "Buzz"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbab5",
    displayName: "Hassakol (Buzz) Panaspraipong",
    canonicalKey: "Buzz",
    tutorNames: ["Hassakol Panaspraipong", "Buzz"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233f6b",
    displayName: "Chidchanok (Linn) Saetiaw Online",
    canonicalKey: "Linn",
    tutorNames: ["Chidchanok Saetiaw", "Linn"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcb991",
    displayName: "Chidchanok (Linn) Saetiaw",
    canonicalKey: "Linn",
    tutorNames: ["Chidchanok Saetiaw", "Linn"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233e90",
    displayName: "Phattadon (Eng) Sucharittanonta Online",
    canonicalKey: "Eng",
    tutorNames: ["Phattadon Sucharittanonta"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbafd",
    displayName: "Phattadon (Eng) Sucharittanonta",
    canonicalKey: "Eng",
    tutorNames: ["Phattadon Sucharittanonta"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada2341c3",
    displayName: "Kavin (Kavin) Diwan Singh Online",
    canonicalKey: "Kavin",
    tutorNames: ["Kavin Diwan Singh", "Kavin"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbcbd",
    displayName: "Kavin (Kavin) Diwan Singh",
    canonicalKey: "Kavin",
    tutorNames: ["Kavin Diwan Singh", "Kavin"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada23428c",
    displayName: "Sanpat (Copter) Chanthanuraks Online",
    canonicalKey: "Copter",
    tutorNames: ["Sanpat Chanthanuraks", "Copter"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbb40",
    displayName: "Sanpat (Copter) Chanthanuraks",
    canonicalKey: "Copter",
    tutorNames: ["Sanpat Chanthanuraks", "Copter"],
    writer: "luna",
  },
  {
    wiseUserId: "6976f90eaf7fbc5ac8cd851a",
    displayName: "Tavinie (Amy) Olarnsakul Online",
    canonicalKey: "Amy",
    tutorNames: ["Tavinie Olarnsakul", "Amy"],
    writer: "luna",
  },
  {
    wiseUserId: "6976f4a5af7fbc5ac8cb9975",
    displayName: "Tavinie (Amy) Olarnsakul",
    canonicalKey: "Amy",
    tutorNames: ["Tavinie Olarnsakul", "Amy"],
    writer: "luna",
  },
];

export const AUTOWRITER_TEACHER_ALLOWLIST: ReadonlySet<string> = new Set(
  AUTOWRITER_ROSTER.map((tutor) => tutor.wiseUserId),
);

export function rosterTutor(wiseUserId: string | null | undefined): AutowriterTutor | null {
  return AUTOWRITER_ROSTER.find((tutor) => tutor.wiseUserId === wiseUserId) ?? null;
}

/** The first writer a tutor's roster entries name, or null for the default (Sol). */
export function rosterWriterArm(canonicalKey: string | null | undefined): AutowriterTutor["writer"] | null {
  return AUTOWRITER_ROSTER.find((tutor) => tutor.canonicalKey === canonicalKey)?.writer ?? null;
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
