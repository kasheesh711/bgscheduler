// ----------------------------------------------------------------------------
// Maintenance mode — the in-app off switch for the staff UI.
//
// Vercel's Pause Project cannot serve this purpose: pausing blocks the
// production deployment, and the 17 Vercel Crons target that same deployment,
// so pausing stops the syncs too. This gate lives above the auth check instead,
// which lets the human-facing surface go dark while the data keeps flowing.
//
//   MAINT-01  Fail-open flag. Maintenance engages only on the exact string
//             "true". Unset, empty, "TRUE", or a typo all leave the site up.
//             This is the inverse polarity of ENABLE_STUDENT_SCHEDULE_LIVE
//             (src/lib/student-schedule/live.ts) on purpose: that flag defaults
//             on and opts out, this one defaults off and opts in, because a bad
//             env value must never black out production.
//   MAINT-02  Exempt prefixes. /api/internal/ keeps every cron alive, /schedule/
//             keeps parent links working, and /api/auth/ + /login keep sign-in
//             reachable so a bypass admin can get in. Everything else is gated,
//             INCLUDING /api/line/webhook — see MAINT-04.
//   MAINT-03  Bypass allowlist. MAINTENANCE_BYPASS_EMAILS is comma-separated and
//             fail-closed: unset or empty means nobody bypasses. Mirrors
//             scheduleBotAdminIds (src/lib/line/schedule-bot.ts:112).
//   MAINT-04  Gate ordering. The caller must run this BEFORE its public-route
//             allowlist. src/middleware.ts allowlists /api/line/webhook, so a
//             gate placed after it would wave the webhook straight through.
//             Blocking the webhook is a deliberate choice with a real cost:
//             LINE does not redeliver by default, so inbound OA messages during
//             a maintenance window are lost, not queued.
//   MAINT-05  Response shape. 503 with Retry-After. JSON under /api/ so callers
//             parse a body rather than HTML; a self-contained inline-styled page
//             elsewhere, because a middleware response never loads the app shell
//             and therefore has no Tailwind.
// ----------------------------------------------------------------------------

import { NextResponse } from "next/server";

/**
 * Paths that stay reachable while maintenance mode is on (MAINT-02).
 *
 * The trailing slash on "/schedule/" is load-bearing: it exempts the public
 * parent pages while leaving the authenticated "/student-schedule" admin page
 * gated. src/middleware.ts relies on the same trick for its public allowlist.
 */
export const MAINTENANCE_EXEMPT_PREFIXES = [
  "/api/internal/",
  "/schedule/",
  "/api/auth/",
  "/login",
] as const;

/** How long a client should wait before retrying, in seconds (MAINT-05). */
const MAINTENANCE_RETRY_AFTER_SECONDS = 3600;

/**
 * True only when MAINTENANCE_MODE is the exact string "true" (MAINT-01).
 *
 * Fail-open by construction — every other value, including unset, leaves the
 * site serving normally.
 */
export function isMaintenanceMode(raw = process.env.MAINTENANCE_MODE): boolean {
  return raw === "true";
}

/**
 * True when the path must keep working during maintenance (MAINT-02).
 *
 * "/login" is matched exactly as well as by prefix so the bare path qualifies
 * without a trailing slash.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  return MAINTENANCE_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

/**
 * Parses MAINTENANCE_BYPASS_EMAILS. Blank entries are dropped; an empty or
 * unset value yields an empty set, which means nobody bypasses (MAINT-03).
 */
export function maintenanceBypassEmails(
  raw = process.env.MAINTENANCE_BYPASS_EMAILS,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * True when this signed-in user may use the app during maintenance (MAINT-03).
 *
 * Fail-closed: a missing email, or an unset allowlist, never bypasses.
 */
export function isMaintenanceBypassEmail(
  email: string | null | undefined,
  raw = process.env.MAINTENANCE_BYPASS_EMAILS,
): boolean {
  if (!email) return false;
  return maintenanceBypassEmails(raw).has(email.trim().toLowerCase());
}

const MAINTENANCE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>BGScheduler — Down for maintenance</title>
</head>
<body style="margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#fdfcf8;color:#1c1917;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:28rem;padding:2rem;text-align:center">
<h1 style="margin:0 0 .75rem;font-size:1.25rem;font-weight:600">BGScheduler is down for maintenance</h1>
<p style="margin:0;font-size:.875rem;line-height:1.6;color:#57534e">Scheduled work is in progress. Nothing has been lost &mdash; please check back shortly.</p>
</main>
</body></html>`;

/**
 * The 503 a gated request receives (MAINT-05). JSON under /api/, HTML elsewhere.
 */
export function maintenanceResponse(pathname: string): NextResponse {
  const headers = { "retry-after": String(MAINTENANCE_RETRY_AFTER_SECONDS) };

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Service unavailable — maintenance mode" },
      { status: 503, headers },
    );
  }

  return new NextResponse(MAINTENANCE_HTML, {
    status: 503,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
