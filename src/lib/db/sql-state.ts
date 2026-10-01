/**
 * SQLSTATE of a database error, or null when it carries none. drizzle 0.45 wraps driver errors in a
 * `DrizzleQueryError` whose own message is the failed query and its parameters, so the code is read from
 * `code ?? cause.code` (strings only) and never matched in message text.
 */
export function sqlStateOf(error: unknown): string | null {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (typeof candidate.code === "string") return candidate.code;
  return typeof candidate.cause?.code === "string" ? candidate.cause.code : null;
}
