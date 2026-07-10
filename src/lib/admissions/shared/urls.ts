import { z } from "zod";

export interface AdmissionsUrlOptions {
  /** Require TLS for surfaces whose existing contract is HTTPS-only. */
  httpsOnly?: boolean;
}

/**
 * Returns a canonical absolute web URL and rejects embedded credentials.
 * Credentials are never a legitimate part of an admissions resource link;
 * accepting them risks persisting portal passwords in otherwise harmless URL
 * fields and can also make a deceptive host difficult to spot in the UI.
 */
export function normalizeAdmissionsUrl(
  value: string | null | undefined,
  field: string,
  options: AdmissionsUrlOptions = {},
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 2_048) throw new Error(`Invalid ${field}`);

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  const allowedProtocol = options.httpsOnly
    ? parsed.protocol === "https:"
    : parsed.protocol === "http:" || parsed.protocol === "https:";
  if (!allowedProtocol || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`Invalid ${field}`);
  }
  return parsed.toString();
}

export function isSafeAdmissionsUrl(
  value: string,
  options: AdmissionsUrlOptions = {},
): boolean {
  try {
    return normalizeAdmissionsUrl(value, "URL", options) != null;
  } catch {
    return false;
  }
}

/** Client-safe route/form schemas backed by the same domain invariant. */
export const admissionsHttpUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => isSafeAdmissionsUrl(value), {
    message: "Use an absolute http(s) URL without embedded credentials",
  });

export const admissionsHttpsUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => isSafeAdmissionsUrl(value, { httpsOnly: true }), {
    message: "Use an absolute https URL without embedded credentials",
  });
