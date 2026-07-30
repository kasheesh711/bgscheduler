export interface ReviewedPayoutTutorMapping {
  canonicalKey: string;
  primaryLedgerName: string;
  alternateLedgerName: string | null;
}

/**
 * Finance-reviewed exceptions to nickname-derived matching.
 *
 * A mapping is usable only when its literal primary identity exists in the
 * source ledger. Optional alternates are included only when they also exist;
 * this module never manufactures an online/onsite twin.
 */
export const REVIEWED_PAYOUT_TUTOR_MAPPINGS = [
  {
    canonicalKey: "Kevin",
    primaryLedgerName: "Kevin (Kev) Y. Hsieh",
    alternateLedgerName: "Kevin (Kev) Y. Hsieh Online",
  },
  {
    canonicalKey: "Paojuu",
    primaryLedgerName: "Prohrak (Paoju) Kruengthomya",
    alternateLedgerName: "Prohrak (Paoju) Kruengthomya Online",
  },
  {
    canonicalKey: "Samantha",
    primaryLedgerName: "Samantha (Sam) Nicole Beattie Online",
    alternateLedgerName: null,
  },
  {
    canonicalKey: "Prae",
    primaryLedgerName: "Vasinee (Prae) Chuenglertsiri Online",
    alternateLedgerName: null,
  },
] as const satisfies readonly ReviewedPayoutTutorMapping[];

export const PAYOUT_TUTOR_UNASSIGNED_LEDGER_PREFIXES = [
  "Kemjira (Kem) Waritpariya",
  "Roger (Roger) Tang",
  "Tulya (Kristie)",
] as const;

export const PAYOUT_TUTOR_BLOCKED_KEYS = [
  "Fluke-Supha",
  "Muk",
  "Nacha (Poi)",
  "Win-Bordin",
] as const;

export function resolveReviewedPayoutTutorMapping(
  canonicalKey: string,
  sourceIdentities: ReadonlySet<string>,
): ReviewedPayoutTutorMapping | null {
  const reviewed = REVIEWED_PAYOUT_TUTOR_MAPPINGS.find(
    (candidate) => candidate.canonicalKey === canonicalKey,
  );
  if (!reviewed || !sourceIdentities.has(reviewed.primaryLedgerName)) return null;
  return {
    canonicalKey: reviewed.canonicalKey,
    primaryLedgerName: reviewed.primaryLedgerName,
    alternateLedgerName: reviewed.alternateLedgerName
      && sourceIdentities.has(reviewed.alternateLedgerName)
      ? reviewed.alternateLedgerName
      : null,
  };
}

export function isExplicitlyUnassignedPayoutLedgerIdentity(name: string): boolean {
  return PAYOUT_TUTOR_UNASSIGNED_LEDGER_PREFIXES.some((prefix) =>
    name.startsWith(prefix));
}

export function isPayoutTutorBlockedUntilLedgerIdentity(canonicalKey: string): boolean {
  return PAYOUT_TUTOR_BLOCKED_KEYS.includes(
    canonicalKey as (typeof PAYOUT_TUTOR_BLOCKED_KEYS)[number],
  );
}
