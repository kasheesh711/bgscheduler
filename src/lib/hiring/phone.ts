/** How a stored phone number is shown and dialled. No I/O; the stored value is never changed here. */

/**
 * A Thai number in its national form, however it was typed: `+66812345678`, `66812345678`, `812345678` and
 * `0812345678` are all `0812345678`. Null when the number is not clearly Thai (a foreign number, or too few digits).
 */
export function thaiNational(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  // 66 is the country code. A Thai number after it has 8 digits (a landline) or 9 (a mobile), with no leading 0.
  if (/^66[1-9]\d{7,8}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^660[1-9]\d{7,8}$/.test(digits)) return digits.slice(2);
  if (plus) return null;
  if (/^0[1-9]\d{7,8}$/.test(digits)) return digits;
  // A mobile typed without its first 0.
  if (/^[689]\d{8}$/.test(digits)) return `0${digits}`;
  return null;
}

/**
 * `display` is what HR reads: `081 234 5678` for a mobile, `02 123 4567` for Bangkok, `053 123 456` for another
 * landline. `href` dials the full international number, so a tap calls from any phone, in Thailand or abroad.
 * A number that is not Thai is shown as stored.
 */
export function phoneView(raw: string): { display: string; href: string } {
  const national = thaiNational(raw);
  if (!national) return { display: raw.trim(), href: `tel:${raw.replace(/[^\d+]/g, "")}` };
  const display =
    national.length === 10
      ? `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
      : national.startsWith("02")
        ? `02 ${national.slice(2, 5)} ${national.slice(5)}`
        : `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  return { display, href: `tel:+66${national.slice(1)}` };
}
