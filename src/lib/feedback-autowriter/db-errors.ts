/**
 * SQLSTATE of a database error. drizzle 0.45 wraps driver errors in a DrizzleQueryError whose own message is the
 * failed query, so the code is read from `code ?? cause.code` — never matched in message text (which can also
 * carry query parameters, i.e. lesson feedback).
 */
export function sqlStateOf(error: unknown): string | null {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (typeof candidate.code === "string") return candidate.code;
  return typeof candidate.cause?.code === "string" ? candidate.cause.code : null;
}

/** 42P01: a table the query needs does not exist (e.g. migration 0101 not applied yet). */
export function isMissingRelationError(error: unknown): boolean {
  return sqlStateOf(error) === "42P01";
}

/** 23505: a unique index refused the row. */
export function isUniqueViolationError(error: unknown): boolean {
  return sqlStateOf(error) === "23505";
}
