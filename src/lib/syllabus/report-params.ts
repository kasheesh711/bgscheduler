import { z } from "zod";

// Notes cap: Thai text percent-encodes at ~9 bytes/char. 1,000 chars ≈ 9 KB,
// which together with max-length Thai names stays under Vercel's 14 KB
// request-URI limit and Node's 16 KB header budget. 1,500 did not — do not
// raise without moving notes out of the query string.
export const reportParamsSchema = z.object({
  student: z.string().trim().min(1, "Student name is required").max(80),
  year: z.coerce.number().int().min(1).max(13),
  tutor: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1000).optional(),
  // Omitted = all topics. Otherwise CSV of topic codes ("A,B,D").
  topics: z
    .string()
    .regex(/^[A-Z]+(,[A-Z]+)*$/)
    .optional(),
});

export type ReportParams = z.infer<typeof reportParamsSchema>;

/** null = all topics selected. */
export function parseTopicCodes(topics: string | undefined): Set<string> | null {
  if (!topics) return null;
  return new Set(topics.split(","));
}

/**
 * Next.js searchParams values are string | string[] | undefined; collapse
 * arrays to their first value and drop empty strings so optional Zod fields
 * treat `?tutor=` as absent.
 */
export function normalizeSearchParams(
  params: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) out[key] = first;
  }
  return out;
}
