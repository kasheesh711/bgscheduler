import { describe, expect, it } from "vitest";

import {
  isExplicitlyUnassignedPayoutLedgerIdentity,
  isPayoutTutorBlockedUntilLedgerIdentity,
  resolveReviewedPayoutTutorMapping,
} from "../payout-tutor-mapping";

describe("reviewed payout tutor mappings", () => {
  it.each([
    [
      "Kevin",
      ["Kevin (Kev) Y. Hsieh", "Kevin (Kev) Y. Hsieh Online"],
      ["Kevin (Kev) Y. Hsieh", "Kevin (Kev) Y. Hsieh Online"],
    ],
    [
      "Paojuu",
      ["Prohrak (Paoju) Kruengthomya", "Prohrak (Paoju) Kruengthomya Online"],
      ["Prohrak (Paoju) Kruengthomya", "Prohrak (Paoju) Kruengthomya Online"],
    ],
    [
      "Samantha",
      ["Samantha (Sam) Nicole Beattie Online"],
      ["Samantha (Sam) Nicole Beattie Online", null],
    ],
    [
      "Prae",
      ["Vasinee (Prae) Chuenglertsiri Online"],
      ["Vasinee (Prae) Chuenglertsiri Online", null],
    ],
  ])("uses only reviewed exact identities for %s", (key, identities, expected) => {
    const mapping = resolveReviewedPayoutTutorMapping(key, new Set(identities));
    expect([
      mapping?.primaryLedgerName,
      mapping?.alternateLedgerName,
    ]).toEqual(expected);
  });

  it("does not synthesize a missing alternate or map a missing primary", () => {
    expect(resolveReviewedPayoutTutorMapping(
      "Kevin",
      new Set(["Kevin (Kev) Y. Hsieh"]),
    )).toMatchObject({ alternateLedgerName: null });
    expect(resolveReviewedPayoutTutorMapping(
      "Kevin",
      new Set(["Kevin (Kev) Y. Hsieh Online"]),
    )).toBeNull();
  });

  it.each([
    "Kemjira (Kem) Waritpariya",
    "Roger (Roger) Tang",
    "Roger (Roger) Tang Online",
    "Tulya (Kristie) Tulyasuwan",
    "Tulya (Kristie) Online",
  ])("keeps %s explicitly unassigned", (identity) => {
    expect(isExplicitlyUnassignedPayoutLedgerIdentity(identity)).toBe(true);
  });

  it.each(["Fluke-Supha", "Muk", "Nacha (Poi)", "Win-Bordin"])(
    "keeps %s blocked until an exact ledger identity appears",
    (canonicalKey) => {
      expect(isPayoutTutorBlockedUntilLedgerIdentity(canonicalKey)).toBe(true);
    },
  );
});
