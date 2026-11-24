import type { Assessment } from "./scoring";

/** The degree choices of the booking page that a résumé can confirm. "Below Bachelor's" is never read from a résumé. */
export type KnownDegree = { degree: "Bachelor's" | "Master's" | "PhD"; field: string };

// Each level: the word (any case), then the abbreviations (exact case, so "MA" in "MARA University" does not count).
const LEVELS: [KnownDegree["degree"], RegExp, RegExp][] = [
  ["PhD", /\b(?:ph\.?\s?d\b\.?|d\.?phil\b\.?|doctor of\b|doctorate\b)/i, /\bPharmD\b/],
  ["Master's", /\bmaster(?:['’]?s)?\b/i, /\b(?:M\.?A|M\.?Sc|MSc|M\.?S|M\.?Ed|M\.?Eng|MBA|M\.?Phil|LL\.?M|M\.?P\.?A|M\.?Com|MCA)\b\.?/],
  ["Bachelor's", /\bbachelor(?:['’]?s)?\b/i, /\b(?:B\.?A|B\.?Sc|BSc|B\.?S|B\.?Ed|B\.?Eng|BE|BBA|B\.?Com|LL\.?B|B\.?F\.?A|MBBS|B\.?Arch|B\.?Pharm)\b\.?/],
];
const ABBREVIATION_WORD = /^(?:[A-Z]\.?){1,4}$/;
// "Bachelor of Arts" names no subject. "Education" does, so it stays.
const GENERIC = /^(?:arts?|sciences?|philosophy|letters|degree|honou?rs?|hons\.?|graduate|studies|program(?:me)?|international program(?:me)?)$/i;
const NOT_A_FIELD = /universit|college|institut|school|academy|campus|\d|@|http/i;
// Where a field of study ends: an institution, a date, a grade or punctuation that starts the next fact.
const END =
  /\s{2,}|\n|\s[|–—-]\s|[|,;:([\]•]|\.\s|\s(?:from|at|graduated|finished|gpa|majoring|major|with|class|honou?rs?|hons|and minor|qualification|degree)\b|\d/i;

function phrase(text: string) {
  const at = text.search(END);
  return (at < 0 ? text : text.slice(0, at)).trim().replace(/[.\s]+$/, "");
}

function clean(value: string | null | undefined): string | null {
  const field = (value ?? "").trim().replace(/^the\s+/i, "");
  if (field.length < 2 || field.length > 80 || GENERIC.test(field) || NOT_A_FIELD.test(field) || !/[a-z]/i.test(field)) return null;
  // A degree name is not a field ("M.Sc", "BSc"), and a phrase cut before its subject ends on a joining word.
  if (ABBREVIATION_WORD.test(field) || (!/\s/.test(field) && LEVELS.some(([, word, abbreviation]) => word.test(field) || abbreviation.test(field)))) return null;
  if (/\b(?:in|of|and|with|for)$/i.test(field)) return null;
  // All capitals in a CV heading: write it as a name.
  if (field === field.toUpperCase())
    return field
      .toLowerCase()
      .replace(/\b([a-z])/g, (m) => m.toUpperCase())
      .replace(/\b(And|Of|In|For|The)\b/g, (m) => m.toLowerCase());
  return field;
}

/** The field named after a degree word: "of X", "in X", "(X)", "[X]", "— X", "majoring in X". */
function fieldAfter(rest: string): string | null {
  let r = rest
    .replace(/^\s*degree\b/i, "")
    .replace(/^\s*\((?:[A-Z]\.?\s?){1,5}\.?\)/, "")
    .replace(/^\s*\((?:hons?\.?|honou?rs)\)/i, "");
  let base: string | null = null;
  const of = r.match(/^\s*of\s+/i);
  if (of) {
    r = r.slice(of[0].length);
    base = phrase(r);
    r = r.slice(r.indexOf(base) + base.length);
    // "Bachelor of Arts (B.A.) in Thai" and "Bachelor of Science (Hons)" carry a second bracket before the subject.
    r = r.replace(/^\s*\((?:[A-Z]\.?\s?){1,5}\.?\)/, "").replace(/^\s*\((?:hons?\.?|honou?rs)\)/i, "");
  }
  const inside = base?.match(/^(?:arts?|sciences?|philosophy|education)\s+in\s+(.+)$/i);
  if (inside) return clean(inside[1]);
  const specific = r.match(/^\s*(?:\(\s*([^)]+?)\s*\)|\[\s*([^\]]+?)\s*\]|[—–-]\s+(.+)|,?\s*(?:majoring|major)\s+in\s+(.+)|\s*in\s+(.+))/i);
  const named = specific ? clean(phrase(specific.slice(1).find(Boolean) ?? "")) : null;
  if (named) return named;
  if (base) return clean(base);
  // "BSc. Food Technology", "B.S Business Management": the subject follows the abbreviation directly.
  const direct = r.match(/^\.?\s+([A-Z][A-Za-z&' ]+)/);
  return direct ? clean(phrase(direct[1])) : null;
}

/**
 * The highest completed degree and its field from the résumé assessment, or null when the résumé does not say both.
 * Only degrees the AI marked complete count. The booking page shows this for one-tap confirmation and the candidate can
 * edit it (Kevin, 24 Nov 2026), so a missed reading only means the two questions are asked as before.
 */
export function profileDegree(assessment: Pick<Assessment, "universities"> | null | undefined): KnownDegree | null {
  let best: KnownDegree | null = null;
  let bestRank = Infinity;
  for (const university of assessment?.universities ?? []) {
    if (!university.completedDegree) continue;
    const text = university.evidence;
    LEVELS.forEach(([degree, word, abbreviation], rank) => {
      if (rank >= bestRank) return;
      const match = text.match(word) ?? text.match(abbreviation);
      if (!match || match.index === undefined) return;
      // A professional doctorate (medicine, pharmacy, veterinary, dental) is not a PhD: ask the questions instead.
      if (degree === "PhD" && /doctor of (?:medicine|pharmacy|veterinary|dental|optometry)|\b(?:MD|PharmD|DVM|DDS)\b/i.test(text)) {
        bestRank = rank;
        best = null;
        return;
      }
      const field = fieldAfter(text.slice(match.index + match[0].length));
      // The highest level decides. Its field must be known, or the line is not a confirmation.
      bestRank = rank;
      best = field ? { degree, field } : null;
    });
  }
  return best;
}
