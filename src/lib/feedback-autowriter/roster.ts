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
  },  // Added 2026-10-05 (owner decision, cohort 5): every remaining tutor who taught an online class in the 30 days
  // before, both Wise accounts each, Luna first. Ranked by 1:1 online classes (Tito 17, Petch-Than 12, Praew 12, Shop 12,
  // Tai 8, Menika 6, Fay 6, Pat 6, Punlee 6, Pech 4, Jennie 3, Mek-Sila 3, Pakgad 3, Glai 3, Rew 2, Win 2, Sunday 1,
  // Nithit 1, Key 1, Ayush 1, Art 1). Roster share of online classes: 750/860 (87%) → 860/860. The owner chose this
  // before the accuracy gate passed (14-day lower bound 75.6%), overriding the expand-after-the-gate rule.
  // Redaction is a case-insensitive whole-word match on each name AND on every word of it (`knownNameVariants`), so no
  // variant may hold an ordinary English word: the nicknames Shop, Win, Sunday, Key and Art are left out; Petch-Than is
  // listed as "Petch" ("than"); Supatcha's surname Rod-em is left out ("rod", "em"); Art's "Jr." is dropped. Tai and Pat
  // are those tutors' own first names, redacted with their full names anyway. Mek-Sila's main account spells the
  // surname "Phonrak", so both spellings are listed.
  {
    wiseUserId: "696e2c4343579bbada23427b",
    displayName: "Smit (Tito) Kanjanapas Online",
    canonicalKey: "Tito",
    tutorNames: ["Smit Kanjanapas", "Tito"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbc09",
    displayName: "Smit (Tito) Kanjanapas",
    canonicalKey: "Tito",
    tutorNames: ["Smit Kanjanapas", "Tito"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234052",
    displayName: "Thanyawat (Petch-Than) Phattharathitinan Online",
    canonicalKey: "Petch-Than",
    tutorNames: ["Thanyawat Phattharathitinan", "Petch"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbda2",
    displayName: "Thanyawat (Petch-Than) Phattharathitinan",
    canonicalKey: "Petch-Than",
    tutorNames: ["Thanyawat Phattharathitinan", "Petch"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada2341d5",
    displayName: "Wichaya (Praew) Peechapat Online",
    canonicalKey: "Praew",
    tutorNames: ["Wichaya Peechapat", "Praew"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbc1d",
    displayName: "Wichaya (Praew) Peechapat",
    canonicalKey: "Praew",
    tutorNames: ["Wichaya Peechapat", "Praew"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233fee",
    displayName: "Warit (Shop) Trikasemsak Online",
    canonicalKey: "Shop",
    tutorNames: ["Warit Trikasemsak"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbc93",
    displayName: "Warit (Shop) Trikasemsak",
    canonicalKey: "Shop",
    tutorNames: ["Warit Trikasemsak"],
    writer: "luna",
  },
  {
    wiseUserId: "6a65fb671041f7a8a81aebec",
    displayName: "Tai (Tai) Chaiamarit Online",
    canonicalKey: "Tai",
    tutorNames: ["Tai Chaiamarit", "Tai"],
    writer: "luna",
  },
  {
    wiseUserId: "6a65fa3b1041f7a8a819e84a",
    displayName: "Tai (Tai) Chaiamarit",
    canonicalKey: "Tai",
    tutorNames: ["Tai Chaiamarit", "Tai"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada23408e",
    displayName: "Menika (Menika) Ratnakovit Online",
    canonicalKey: "Menika",
    tutorNames: ["Menika Ratnakovit", "Menika"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbd9e",
    displayName: "Menika (Menika) Ratnakovit",
    canonicalKey: "Menika",
    tutorNames: ["Menika Ratnakovit", "Menika"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233ebc",
    displayName: "Susama (Fay) Kitiyakara Online",
    canonicalKey: "Fay",
    tutorNames: ["Susama Kitiyakara", "Fay"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbcac",
    displayName: "Susama (Fay) Kitiyakara",
    canonicalKey: "Fay",
    tutorNames: ["Susama Kitiyakara", "Fay"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada233f49",
    displayName: "Pat (Pat) O'Corner Online",
    canonicalKey: "Pat",
    tutorNames: ["Pat O'Corner", "Pat"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbc13",
    displayName: "Pat (Pat) O'Corner",
    canonicalKey: "Pat",
    tutorNames: ["Pat O'Corner", "Pat"],
    writer: "luna",
  },
  {
    wiseUserId: "698bdca3b0e4b23fd5054e06",
    displayName: "Pariwat (Punlee) Leelaaburanapong Online",
    canonicalKey: "Punlee",
    tutorNames: ["Pariwat Leelaaburanapong", "Punlee"],
    writer: "luna",
  },
  {
    wiseUserId: "698bdc79b0e4b23fd5053b93",
    displayName: "Pariwat (Punlee) Leelaaburanapong",
    canonicalKey: "Punlee",
    tutorNames: ["Pariwat Leelaaburanapong", "Punlee"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada2341cd",
    displayName: "Kumpanat (Pech) Thongmai Online",
    canonicalKey: "Pech",
    tutorNames: ["Kumpanat Thongmai", "Pech"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbaca",
    displayName: "Kumpanat (Pech) Thongmai",
    canonicalKey: "Pech",
    tutorNames: ["Kumpanat Thongmai", "Pech"],
    writer: "luna",
  },
  {
    wiseUserId: "697b1d19af7fbc5ac8204f8e",
    displayName: "Jennie (Jennie) Williams Online",
    canonicalKey: "Jennie",
    tutorNames: ["Jennie Williams", "Jennie"],
    writer: "luna",
  },
  {
    wiseUserId: "695c97ee28118f629e3fd012",
    displayName: "Jennie (Jennie) Williams",
    canonicalKey: "Jennie",
    tutorNames: ["Jennie Williams", "Jennie"],
    writer: "luna",
  },
  {
    wiseUserId: "6a9aba0ee5489b5ec8f1b1a2",
    displayName: "Sila (Mek-Sila) Phonak Online",
    canonicalKey: "Mek-Sila",
    tutorNames: ["Sila Phonak", "Sila Phonrak", "Mek-Sila"],
    writer: "luna",
  },
  {
    wiseUserId: "6a68e368002fa65af6597623",
    displayName: "Sila (Mek-Sila) Phonrak",
    canonicalKey: "Mek-Sila",
    tutorNames: ["Sila Phonak", "Sila Phonrak", "Mek-Sila"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada2340d7",
    displayName: "Supatcha (Pakgad) Rod-em Online",
    canonicalKey: "Pakgad",
    tutorNames: ["Supatcha", "Pakgad"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbd05",
    displayName: "Supatcha (Pakgad) Rod-em",
    canonicalKey: "Pakgad",
    tutorNames: ["Supatcha", "Pakgad"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada23400e",
    displayName: "Dolruethai (Glai) Rodma Online",
    canonicalKey: "Glai",
    tutorNames: ["Dolruethai Rodma", "Glai"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbb43",
    displayName: "Dolruethai (Glai) Rodma",
    canonicalKey: "Glai",
    tutorNames: ["Dolruethai Rodma", "Glai"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada234092",
    displayName: "Nonthawat (Rew) Lertprasitchok Online",
    canonicalKey: "Rew",
    tutorNames: ["Nonthawat Lertprasitchok", "Rew"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcbd1a",
    displayName: "Nonthawat (Rew) Lertprasitchok",
    canonicalKey: "Rew",
    tutorNames: ["Nonthawat Lertprasitchok", "Rew"],
    writer: "luna",
  },
  {
    wiseUserId: "698bdbddb0e4b23fd504d9d7",
    displayName: "Veerawin (Win) Su Online",
    canonicalKey: "Win",
    tutorNames: ["Veerawin Su"],
    writer: "luna",
  },
  {
    wiseUserId: "698bdb23b0e4b23fd504054f",
    displayName: "Veerawin (Win) Su",
    canonicalKey: "Win",
    tutorNames: ["Veerawin Su"],
    writer: "luna",
  },
  {
    wiseUserId: "6a8c5ab95bc1ee067e243346",
    displayName: "Tanachot (Sunday) Phitprom Online",
    canonicalKey: "Sunday",
    tutorNames: ["Tanachot Phitprom"],
    writer: "luna",
  },
  {
    wiseUserId: "6a8c5a9f5bc1ee067e2414ec",
    displayName: "Tanachot (Sunday) Phitprom",
    canonicalKey: "Sunday",
    tutorNames: ["Tanachot Phitprom"],
    writer: "luna",
  },
  {
    wiseUserId: "696e2c4343579bbada2340d5",
    displayName: "Nithit (Nithit) Singhsachthep Online",
    canonicalKey: "Nithit",
    tutorNames: ["Nithit Singhsachthep", "Nithit"],
    writer: "luna",
  },
  {
    wiseUserId: "695369c028118f629edcba5e",
    displayName: "Nithit (Nithit) Singhsachthep",
    canonicalKey: "Nithit",
    tutorNames: ["Nithit Singhsachthep", "Nithit"],
    writer: "luna",
  },
  {
    wiseUserId: "69fcc5998b92db95a261a1ee",
    displayName: "Kieran (Key) Wilkinson Online",
    canonicalKey: "Key",
    tutorNames: ["Kieran Wilkinson"],
    writer: "luna",
  },
  {
    wiseUserId: "69fcc4c78b92db95a260c2d4",
    displayName: "Kieran (Key) Wilkinson",
    canonicalKey: "Key",
    tutorNames: ["Kieran Wilkinson"],
    writer: "luna",
  },
  {
    wiseUserId: "6a7de83d5bc1ee067e1a969f",
    displayName: "Ayush (Ayush) Madan Online",
    canonicalKey: "Ayush",
    tutorNames: ["Ayush Madan", "Ayush"],
    writer: "luna",
  },
  {
    wiseUserId: "6a7de78a5bc1ee067e19e28c",
    displayName: "Ayush (Ayush) Madan",
    canonicalKey: "Ayush",
    tutorNames: ["Ayush Madan", "Ayush"],
    writer: "luna",
  },
  {
    wiseUserId: "6a803b5b5bc1ee067ec045ec",
    displayName: "Artemio (Art) Jr. Padilla Online",
    canonicalKey: "Art",
    tutorNames: ["Artemio Padilla"],
    writer: "luna",
  },
  {
    wiseUserId: "6a803afa5bc1ee067ebffdf0",
    displayName: "Artemio (Art) Jr. Padilla",
    canonicalKey: "Art",
    tutorNames: ["Artemio Padilla"],
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
