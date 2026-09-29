import { DrizzleQueryError } from "drizzle-orm/errors";

import {
  PostClassConflictError,
  PostClassNotFoundError,
  PostClassValidationError,
} from "./errors";

// ── Safe error fields for money-path logs ───────────────────────────────
//
// A caught error at a deduction boundary is logged by what identifies it,
// never by what it carries: a drizzle `DrizzleQueryError` message holds the
// SQL and its parameters, and a `pg` `DatabaseError` detail holds row values.

export interface SafeErrorFields {
  errorName: string;
  /** The wrapped error's class, e.g. `NeonDbError` under a `DrizzleQueryError`. */
  causeName?: string;
  /** A SQLSTATE (e.g. `40001`) or system/network code (e.g. `ECONNRESET`): an identifier, never data. */
  code?: string;
  /** Only for this domain's typed errors, whose text the code itself writes. */
  message?: string;
}

/** SQLSTATEs are five characters; Node and undici codes are upper-case words like `UND_ERR_SOCKET`. */
const CODE_PATTERN = /^[A-Z0-9_]{2,40}$/;

function identifierCode(value: unknown): string | undefined {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : undefined;
}

/** drizzle 0.45 never sets `DrizzleQueryError.name`, so a real query failure would otherwise log as plain `Error`. */
function errorClassName(error: unknown): string {
  if (error instanceof DrizzleQueryError) return "DrizzleQueryError";
  return error instanceof Error ? error.name : "UnknownError";
}

/** The error's own code, else its cause's: drizzle 0.45 wraps the driver error in `cause`. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return identifierCode(code)
    ?? (typeof cause === "object" && cause !== null ? identifierCode((cause as { code?: unknown }).code) : undefined);
}

/**
 * The fields of a caught error that are safe to log where deductions move:
 * 1. `errorName`: the class, or `UnknownError` for a thrown non-Error.
 * 2. `causeName`: the class of the error it wraps, when it wraps one.
 * 3. `code`: a SQLSTATE or network code, when one is present.
 * 4. `message`: only for `PostClassValidationError`, `PostClassConflictError` and
 *    `PostClassNotFoundError` instances. Every other message is dropped, because it
 *    can carry SQL, parameters, row values or response bodies.
 *
 * The message allowlist is by class, not by call site. On the deduction sweeps and
 * reassessment these classes carry only months, lease expiries, field labels and
 * exemption codes; elsewhere the same classes can carry an email or a tutor key, so
 * check what a new call site can throw before reusing this there.
 */
export function safeErrorFields(error: unknown): SafeErrorFields {
  const fields: SafeErrorFields = { errorName: errorClassName(error) };
  if (error instanceof Error && error.cause instanceof Error) fields.causeName = errorClassName(error.cause);
  const code = errorCode(error);
  if (code) fields.code = code;
  if (
    error instanceof PostClassValidationError ||
    error instanceof PostClassConflictError ||
    error instanceof PostClassNotFoundError
  ) {
    fields.message = error.message;
  }
  return fields;
}
