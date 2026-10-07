# Resend Email Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Resend the primary transport for all BGScheduler outbound email. Workspace Gmail and then the Apps Script relay remain as automatic fallbacks. Rollout is in two waves (staff mail first, teacher mail second). Delivery and bounce events are recorded, and the two admin digests get kill switches.

**Architecture:** Every outbound path already calls `createOutboundEmailSender()` in `src/lib/email/outbound.ts`, and all of them share one `ScheduleEmailSender` interface (`sendEmail(input) → { id }`). We add a Resend sender behind that same interface, plus a third value for `OUTBOUND_EMAIL_TRANSPORT`, `resend`. We also add an `audience` option so each caller states whether it sends staff or teacher mail, and `RESEND_AUDIENCE` decides which wave is live. Fallback safety follows the rules already in place: a `ScheduleEmailRejection` means "definitely not accepted, safe to try the next provider", while a plain `Error` means "outcome uncertain, never resend through another provider". Admissions drops its private Resend `fetch` and uses the shared sender. A signed Resend webhook writes delivery events to a new table.

**Tech Stack:** Next.js 16 App Router route handler, TypeScript, Drizzle (neon-http), Vitest, Resend REST API (`POST https://api.resend.com/emails`, `Idempotency-Key` header), Svix-signed webhooks (raw `node:crypto`, no SDK — the repo calls every vendor over raw `fetch`).

**Spec:** Decisions made with the owner in the 2026-10-07 session. They are restated in Global Constraints because no separate spec document exists. Human setup: [`docs/operations/resend-setup.md`](../../operations/resend-setup.md).

## Global Constraints

- No new npm dependencies. Call Resend with raw `fetch` and verify webhooks with `node:crypto`, the same way Wise, LINE, OpenAI, Apify and DataForSEO are called.
- `OUTBOUND_EMAIL_TRANSPORT` values: `resend` | `gmail` | anything else → `apps_script`. When unset or unrecognised, behaviour must be byte-for-byte what ships today.
- `RESEND_AUDIENCE` values: `all` sends both audiences through Resend. Anything else, including unset, sends only `staff` through Resend.
- The `audience` default is `"teacher"`, so an untagged or forgotten caller stays on the proven Gmail path.
- Fallback chain under `resend`. `primary` is Resend; on `ScheduleEmailRejection` it falls to Workspace Gmail, which already falls back to the Apps Script relay. `backup` is the Workspace Gmail chain, so existing "backup" failovers still reach a different provider.
- A plain `Error` (timeout, network error, 5xx, 409, 2xx with no id) is an uncertain outcome. Never fall back to another provider after it.
- `RESEND_FROM` is required for the Resend path, for example `BeGifted <no-reply@notify.begiftededucation.com>`. When missing, the Resend sender throws `ScheduleEmailRejection`, which falls back cleanly. Never default to `onboarding@resend.dev`.
- Reply-To: `RESEND_REPLY_TO` → `SCHEDULE_EMAIL_REPLY_TO` → `kevhsh7@gmail.com`.
- Never log a recipient address, a subject, a body, the API key or the webhook secret. Log only event type, Resend message id, HTTP status and error name.
- Webhook route path: `/api/email/resend-webhook`. It must be added to the `isPublicRoute` allowlist in `src/proxy.ts` and authenticated in the handler by Svix signature.
- Next migration number is `0111`. After `npm run db:generate`, trim any unrelated catch-up statements from the generated SQL (known drizzle snapshot drift).
- Tests live in a sibling `__tests__/` dir. Use double quotes and semicolons, named exports only, and `env = process.env` injection for config.

## Review Focus

1. **Resend times out or returns 5xx after accepting the message.** The sender must throw a plain `Error` so the chain does not resend through Gmail, otherwise a teacher gets two copies. Pinned in Task 1 (`5xx is uncertain`) and Task 2 (`uncertain Resend outcome is not retried on Gmail`).
2. **`RESEND_FROM` unset or the domain not yet verified (Resend 403/422).** Mail must still go out through Gmail, not fail. Pinned in Task 1 (`missing from rejects`, `403 rejects`) and Task 2 (`rejection falls back to Gmail`).
3. **Idempotency key longer than Resend's 256-character limit.** Some callers build long keys (`pt-workspace-reminder:<uuid>`, post-class keys). They must be hashed, not truncated or rejected. Pinned in Task 1 (`long idempotency keys are hashed`).
4. **Webhook replay or forged signature.** A request with an old timestamp, a wrong secret or a duplicate `svix-id` must not create a row. Pinned in Task 6 (`rejects stale timestamp`, `rejects bad signature`, `duplicate svix-id is a no-op`).
5. **Subject containing CR/LF** (the autowriter incident subjects do). Resend accepts it, but header behaviour is undefined. Collapse whitespace as the Gmail path does. Pinned in Task 1 (`subject is single-line`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email/resend.ts` (create) | `createResendSender()` sends one message through Resend and classifies the outcome as accepted, rejected or uncertain |
| `src/lib/email/outbound.ts` (modify) | Transport selection, `audience` routing, fallback chain |
| `src/lib/email/__tests__/resend.test.ts` (create) | Resend sender outcome classification |
| `src/lib/email/__tests__/outbound.test.ts` (modify) | Routing and chain behaviour under `resend` |
| `src/lib/email/__tests__/audience-tags.test.ts` (create) | Static guard: every staff-facing module tags `audience: "staff"` |
| 9 caller modules (modify) | Pass `{ audience: "staff" }` |
| `src/lib/auth/email-code.ts` (modify) | One attempt under `resend` (the chain handles fallback) |
| `src/lib/admissions/notifications.ts` (modify) | Use `createResendSender` instead of the inline `fetch` |
| `src/lib/classrooms/admin-schedule-email.ts`, `src/lib/progress-tests/admin-digest.ts` (modify) | Env kill switches |
| `src/lib/db/schema.ts` + `drizzle/0111_email_delivery_events.sql` (modify/create) | `email_delivery_events` table |
| `src/lib/email/resend-webhook.ts` (create) | Svix signature check and event parsing |
| `src/app/api/email/resend-webhook/route.ts` (create) | Public webhook receiver |
| `src/proxy.ts`, `src/__tests__/middleware.test.ts` (modify) | Allowlist the webhook path |
| `docs/reference/env.md` (modify) | New env vars |

Suggested PR split: **PR A** = Tasks 1–4 (transport, routing, tags, auth). **PR B** = Task 5 (Admissions). **PR C** = Task 6 (digest switches). **PR D** = Tasks 7–8 (webhook). PR A is the only one on the critical path. B, C and D are independent of each other once A is merged.

*Execution note: this shipped as two PRs instead: PR1 = Tasks 1–6 (transport, routing, tags, auth, Admissions, digest switches; no migration) and PR2 = Tasks 7–8 (webhook, migration 0111). Admissions goes live at owner Phase 3 (when `RESEND_API_KEY` and the from address are deployed after PR1), not Phase 4.*

---

### Task 1: Resend sender

**Files:**
- Create: `src/lib/email/resend.ts`
- Test: `src/lib/email/__tests__/resend.test.ts`

**Interfaces:**
- Consumes: `ScheduleEmailSender`, `ScheduleEmailSendInput`, `ScheduleEmailRejection` from `@/lib/classrooms/schedule-email`.
- Produces:
  ```ts
  export interface ResendSenderOptions { from?: string; replyTo?: string; fetchImpl?: typeof fetch }
  export function createResendSender(env?: OutboundEmailEnvironment, options?: ResendSenderOptions): ScheduleEmailSender;
  export function resendIdempotencyKey(key: string): string;
  export function resendConfigured(env?: OutboundEmailEnvironment): boolean; // RESEND_API_KEY && RESEND_FROM present
  ```
  `OutboundEmailEnvironment` is redeclared locally as `{ readonly [name: string]: string | undefined }`. Do not import it from `outbound.ts`, because that would create a cycle.
- **Import-cycle rule:** the modules form a loop, `resend.ts` → `schedule-email.ts` → `outbound.ts` → `resend.ts`. That loop is safe only because `resend.ts` touches `ScheduleEmailRejection` at **call time**. Never `extends ScheduleEmailRejection` at module scope in this file. The Gmail sender breaks the same kind of cycle with dynamic imports for exactly this reason (see the comment above `loadWorkspaceGmailSender`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/email/__tests__/resend.test.ts
import { describe, expect, it, vi } from "vitest";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
import { createResendSender, resendConfigured, resendIdempotencyKey } from "../resend";

const ENV = { RESEND_API_KEY: "re_test", RESEND_FROM: "BeGifted <no-reply@notify.example.com>", SCHEDULE_EMAIL_REPLY_TO: "ops@example.com" };
const input = { to: "tutor@example.com", subject: "Schedule", html: "<p>h</p>", text: "h", idempotencyKey: "k-1" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("createResendSender", () => {
  it("posts one message with from, reply_to, idempotency header and returns the Resend id", async () => {
    const fetchImpl = reply(200, { id: "re-msg-1" });
    const result = await createResendSender(ENV, { fetchImpl }).sendEmail(input);
    expect(result).toEqual({ id: "re-msg-1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({
      from: ENV.RESEND_FROM, to: ["tutor@example.com"], subject: "Schedule",
      html: "<p>h</p>", text: "h", reply_to: "ops@example.com",
    });
  });

  it("prefers RESEND_REPLY_TO and per-call overrides", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await createResendSender({ ...ENV, RESEND_REPLY_TO: "r@example.com" }, { fetchImpl, from: "A <a@notify.example.com>" }).sendEmail(input);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBe("r@example.com");
    expect(body.from).toBe("A <a@notify.example.com>");
  });

  it("subject is single-line", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await createResendSender(ENV, { fetchImpl }).sendEmail({ ...input, subject: "Incident:\r\n style  down " });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).subject).toBe("Incident: style down");
  });

  it("missing from rejects before any network call", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await expect(createResendSender({ RESEND_API_KEY: "re_test" }, { fetchImpl }).sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("missing api key rejects before any network call", async () => {
    const fetchImpl = reply(200, { id: "x" });
    await expect(createResendSender({ RESEND_FROM: ENV.RESEND_FROM }, { fetchImpl }).sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422, 429])("%i rejects (definitely not accepted)", async (status) => {
    const sender = createResendSender(ENV, { fetchImpl: reply(status, { name: "validation_error", message: "nope" }) });
    await expect(sender.sendEmail(input)).rejects.toBeInstanceOf(ScheduleEmailRejection);
  });

  it.each([409, 500, 502, 503])("%i is uncertain (plain Error, never a rejection)", async (status) => {
    const sender = createResendSender(ENV, { fetchImpl: reply(status, { message: "x" }) });
    const error = await sender.sendEmail(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("5xx is uncertain even with a provider message", async () => {
    const sender = createResendSender(ENV, { fetchImpl: reply(500, { message: "internal" }) });
    await expect(sender.sendEmail(input)).rejects.toThrow(/uncertain/i);
  });

  it("network failure is uncertain", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const error = await createResendSender(ENV, { fetchImpl }).sendEmail(input).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("2xx without an id is uncertain", async () => {
    const error = await createResendSender(ENV, { fetchImpl: reply(200, {}) }).sendEmail(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ScheduleEmailRejection);
  });

  it("never puts the api key or recipient in an error message", async () => {
    const error = await createResendSender(ENV, { fetchImpl: reply(422, { message: "tutor@example.com is invalid" }) }).sendEmail(input).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("tutor@example.com");
    expect(String((error as Error).message)).not.toContain("re_test");
  });
});

describe("resendIdempotencyKey", () => {
  it("passes short keys through", () => expect(resendIdempotencyKey("auth-code:1")).toBe("auth-code:1"));
  it("long idempotency keys are hashed to a stable 64-char hex", () => {
    const long = "x".repeat(300);
    expect(resendIdempotencyKey(long)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resendIdempotencyKey(long)).toBe(resendIdempotencyKey(long));
  });
});

describe("resendConfigured", () => {
  it("needs both key and from", () => {
    expect(resendConfigured(ENV)).toBe(true);
    expect(resendConfigured({ RESEND_API_KEY: "x" })).toBe(false);
    expect(resendConfigured({ RESEND_FROM: "x" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/lib/email/__tests__/resend.test.ts`
Expected: FAIL with "Cannot find module '../resend'".

- [ ] **Step 3: Implement**

```ts
// src/lib/email/resend.ts
import { createHash } from "node:crypto";
import {
  ScheduleEmailRejection,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_REPLY_TO = "kevhsh7@gmail.com";
/** Resend caps Idempotency-Key at 256 characters and remembers it for 24 hours. */
const MAX_IDEMPOTENCY_KEY = 256;
/** Statuses Resend returns before it accepts a message: safe to try another provider. */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);

interface ResendEnvironment {
  readonly [name: string]: string | undefined;
}

export interface ResendSenderOptions {
  from?: string;
  replyTo?: string;
  fetchImpl?: typeof fetch;
}

export function resendConfigured(env: ResendEnvironment = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FROM?.trim());
}

export function resendIdempotencyKey(key: string): string {
  if (key.length <= MAX_IDEMPOTENCY_KEY) return key;
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Sends one message through Resend.
 *
 * Outcome discipline (matches the Gmail and Apps Script senders):
 * - `ScheduleEmailRejection`: definitely not accepted (config missing, 4xx
 *   validation/auth/quota). The caller may try another provider.
 * - plain `Error`: uncertain (network, timeout, 409 idempotency conflict, 5xx,
 *   2xx without an id). The caller must not resend elsewhere; a retry through
 *   Resend with the same Idempotency-Key within 24h is safe.
 * Error messages never carry the recipient, the body or the key.
 */
export function createResendSender(
  env: ResendEnvironment = process.env,
  options: ResendSenderOptions = {},
): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      const apiKey = env.RESEND_API_KEY?.trim();
      const from = options.from?.trim() || env.RESEND_FROM?.trim();
      if (!apiKey) throw new ScheduleEmailRejection("RESEND_API_KEY is not configured");
      if (!from) throw new ScheduleEmailRejection("RESEND_FROM is not configured");
      const replyTo = options.replyTo?.trim()
        || env.RESEND_REPLY_TO?.trim()
        || env.SCHEDULE_EMAIL_REPLY_TO?.trim()
        || DEFAULT_REPLY_TO;

      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(RESEND_ENDPOINT, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": resendIdempotencyKey(input.idempotencyKey),
          },
          body: JSON.stringify({
            from,
            to: [input.to.trim()],
            subject: input.subject.replace(/\s+/g, " ").trim(),
            html: input.html,
            text: input.text,
            reply_to: replyTo,
          }),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "UnknownError";
        throw new Error(`Resend acceptance is uncertain (${name}). Check the Resend log before resending.`);
      }

      const json = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
      if (REJECTED_STATUSES.has(response.status)) {
        const code = typeof json?.name === "string" ? json.name : "rejected";
        throw new ScheduleEmailRejection(`Resend rejected the message before acceptance (HTTP ${response.status}, ${code}).`);
      }
      if (!response.ok) {
        throw new Error(`Resend acceptance is uncertain (HTTP ${response.status}). Check the Resend log before resending.`);
      }
      if (typeof json?.id !== "string" || !json.id.trim()) {
        throw new Error("Resend returned no acceptance receipt. Check the Resend log before resending.");
      }
      return { id: json.id };
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/lib/email/__tests__/resend.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/resend.ts src/lib/email/__tests__/resend.test.ts
git commit -m "feat(email): add Resend sender with strict accepted/rejected/uncertain outcomes"
```

---

### Task 2: Route the outbound factory through Resend

**Files:**
- Modify: `src/lib/email/outbound.ts`
- Test: `src/lib/email/__tests__/outbound.test.ts`

**Interfaces:**
- Consumes: `createResendSender`, `resendConfigured` (Task 1).
- Produces:
  ```ts
  export type OutboundEmailTransport = "apps_script" | "gmail" | "resend";
  export type OutboundEmailAudience = "staff" | "teacher";
  export function outboundEmailTransport(env?): OutboundEmailTransport;
  export function resendServesAudience(audience: OutboundEmailAudience, env?): boolean;
  export function createOutboundEmailSender(
    senderKey?: ScheduleEmailSenderKey,
    options?: { strictOutcome?: boolean; audience?: OutboundEmailAudience },
    env?: OutboundEmailEnvironment,
  ): ScheduleEmailSender;
  ```
  `outboundRelayKey` must map to `"primary"` under `resend`, as it already does under `gmail`.

- [ ] **Step 1: Add the failing tests** to `outbound.test.ts`. Add a hoisted Resend mock next to the existing mocks, then a new `describe` block.

```ts
// near the other vi.hoisted mocks
const resendSend = vi.hoisted(() => vi.fn<(input: unknown) => Promise<{ id: string }>>(async () => ({ id: "resend-1" })));
const createResendSender = vi.hoisted(() => vi.fn(() => ({ sendEmail: resendSend })));
const resendConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/email/resend", () => ({ createResendSender, resendConfigured }));
```

```ts
const RESEND = { OUTBOUND_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", RESEND_FROM: "B <b@notify.example.com>" };

describe("resend transport", () => {
  afterEach(() => resendConfigured.mockReturnValue(true));

  it("parses resend case-insensitively", () => {
    expect(outboundEmailTransport({ OUTBOUND_EMAIL_TRANSPORT: " Resend " })).toBe("resend");
  });

  it("maps both keys to the primary relay under resend", () => {
    expect(outboundRelayKey("backup", RESEND)).toBe("primary");
  });

  it("sends staff mail through Resend in wave one", async () => {
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "resend-1" });
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("keeps teacher mail (and untagged callers) on Workspace Gmail until RESEND_AUDIENCE=all", async () => {
    expect(await createOutboundEmailSender("primary", {}, RESEND).sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(await createOutboundEmailSender("primary", { audience: "teacher" }, RESEND).sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("sends teacher mail through Resend once RESEND_AUDIENCE=all", async () => {
    const sender = createOutboundEmailSender("primary", { audience: "teacher" }, { ...RESEND, RESEND_AUDIENCE: "all" });
    expect(await sender.sendEmail(input)).toEqual({ id: "resend-1" });
  });

  it("rejection falls back to Gmail with the same input", async () => {
    resendSend.mockRejectedValueOnce(new Rejection("403"));
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(gmailSend).toHaveBeenCalledWith(input);
  });

  it("uncertain Resend outcome is not retried on Gmail", async () => {
    resendSend.mockRejectedValueOnce(new Error("Resend acceptance is uncertain (HTTP 500)."));
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    await expect(sender.sendEmail(input)).rejects.toThrow(/uncertain/);
    expect(gmailSend).not.toHaveBeenCalled();
    expect(relaySend).not.toHaveBeenCalled();
  });

  it("skips Resend entirely when it is not configured", async () => {
    resendConfigured.mockReturnValue(false);
    const sender = createOutboundEmailSender("primary", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("backup is the Gmail chain, never Resend", async () => {
    const sender = createOutboundEmailSender("backup", { audience: "staff" }, RESEND);
    expect(await sender.sendEmail(input)).toEqual({ id: "gmail-1" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("leaves apps_script and gmail behaviour untouched", async () => {
    await createOutboundEmailSender("primary", { audience: "staff" }, {}).sendEmail(input);
    expect(relaySend).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/lib/email/__tests__/outbound.test.ts`
Expected: the new block FAILS (`"resend"` is parsed as `apps_script`, Resend is never called). The existing tests still PASS.

- [ ] **Step 3: Implement** in `src/lib/email/outbound.ts`

Replace the transport type, parser and relay-key function:

```ts
export type OutboundEmailTransport = "apps_script" | "gmail" | "resend";
/** Who reads the mail. Decides which rollout wave can move it to Resend. */
export type OutboundEmailAudience = "staff" | "teacher";

export function outboundEmailTransport(env: OutboundEmailEnvironment = process.env): OutboundEmailTransport {
  const value = env.OUTBOUND_EMAIL_TRANSPORT?.trim().toLowerCase();
  return value === "gmail" || value === "resend" ? value : "apps_script";
}

/**
 * Rollout gate: wave one moves staff mail only; RESEND_AUDIENCE=all moves
 * teacher mail too. Untagged callers default to "teacher" so a forgotten tag
 * keeps mail on the proven Gmail path.
 */
export function resendServesAudience(
  audience: OutboundEmailAudience,
  env: OutboundEmailEnvironment = process.env,
): boolean {
  return audience === "staff" || env.RESEND_AUDIENCE?.trim().toLowerCase() === "all";
}

export function outboundRelayKey(
  senderKey: ScheduleEmailSenderKey,
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSenderKey {
  return outboundEmailTransport(env) === "apps_script" ? senderKey : "primary";
}
```

Update the JSDoc block above `OutboundEmailTransport` with a third bullet:

```ts
 * - `resend`: Resend (notify subdomain) for the audiences RESEND_AUDIENCE
 *   allows, falling back to the `gmail` chain on a pre-acceptance rejection.
```

Add the Resend-first sender above `createOutboundEmailSender`:

```ts
/**
 * Resend first; a rejection known to precede acceptance (unconfigured key or
 * from, unverified domain, validation, quota) hands the same input and
 * idempotency key to the Workspace Gmail chain. An uncertain Resend outcome
 * is rethrown, never resent.
 */
function createResendFirstSender(env: OutboundEmailEnvironment, next: ScheduleEmailSender): ScheduleEmailSender {
  return {
    async sendEmail(input) {
      try {
        return await createResendSender(env).sendEmail(input);
      } catch (error) {
        if (!(error instanceof ScheduleEmailRejection)) throw error;
        console.error(`Resend rejected outbound email before acceptance; using Workspace Gmail: ${error.message}`);
        return next.sendEmail(input);
      }
    },
  };
}
```

Add `import { createResendSender, resendConfigured } from "@/lib/email/resend";` at the top. Then replace the body of `createOutboundEmailSender`:

```ts
export function createOutboundEmailSender(
  senderKey: ScheduleEmailSenderKey = "primary",
  options: { strictOutcome?: boolean; audience?: OutboundEmailAudience } = {},
  env: OutboundEmailEnvironment = process.env,
): ScheduleEmailSender {
  const { audience = "teacher", ...relayOptions } = options;
  const transport = outboundEmailTransport(env);
  const relay = createAppsScriptScheduleEmailSender(outboundRelayKey(senderKey, env), relayOptions);
  if (transport === "apps_script") return relay;
  const gmailChain = createWorkspaceGmailSender(env, relay);
  if (transport === "gmail") return senderKey === "backup" ? relay : gmailChain;
  // resend
  if (senderKey === "backup" || !resendServesAudience(audience, env) || !resendConfigured(env)) return gmailChain;
  return createResendFirstSender(env, gmailChain);
}
```

Check: the existing `relay` mock is called with `(key, options)`, so `relayOptions` must equal the old `options` whenever `audience` is absent. The existing test `toHaveBeenCalledWith("backup", { strictOutcome: true })` still passes because `audience` has been destructured out.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/lib/email/__tests__/`
Expected: PASS (all, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/outbound.ts src/lib/email/__tests__/outbound.test.ts
git commit -m "feat(email): add resend transport with audience-gated rollout and Gmail fallback"
```

---

### Task 3: Tag staff-facing callers and fix the sign-in code path

**Files (modify, one-line change each):**
- `src/lib/internal/cron-watchdog.ts:696` and `:764`
- `src/lib/feedback-autowriter/alerts.ts:90`
- `src/lib/feedback-autowriter/incidents.ts:138`
- `src/lib/classrooms/weekend-check.ts:93`
- `src/lib/classrooms/admin-schedule-email.ts:410`
- `src/lib/progress-tests/admin-digest.ts:396`
- `src/lib/leave-requests/sync.ts:395`
- `src/lib/auth/email-code.ts:44,62`
- Create: `src/lib/email/__tests__/audience-tags.test.ts`

Teacher-facing callers stay **untagged** on purpose and default to `"teacher"`: `classrooms/schedule-email.ts`, `post-class-feedback/notifications.ts`, `progress-tests/teacher-heads-up.ts`, `progress-tests/workspace/sync.ts`, `tutor-sit-ins/worker.ts`.

**Interfaces:**
- Consumes: `createOutboundEmailSender(senderKey, { audience })` (Task 2).

- [ ] **Step 1: Write the failing static guard**

```ts
// src/lib/email/__tests__/audience-tags.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Modules whose recipients are staff only: they ride Resend in wave one. */
const STAFF_MODULES = [
  "src/lib/internal/cron-watchdog.ts",
  "src/lib/feedback-autowriter/alerts.ts",
  "src/lib/feedback-autowriter/incidents.ts",
  "src/lib/classrooms/weekend-check.ts",
  "src/lib/classrooms/admin-schedule-email.ts",
  "src/lib/progress-tests/admin-digest.ts",
  "src/lib/leave-requests/sync.ts",
  "src/lib/auth/email-code.ts",
];

describe("staff email modules", () => {
  it.each(STAFF_MODULES)("%s tags every outbound sender as staff", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const calls = source.match(/createOutboundEmailSender\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('audience: "staff"');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project unit src/lib/email/__tests__/audience-tags.test.ts`
Expected: FAIL for all 8 modules.

- [ ] **Step 3: Tag each call site.** Exact replacements:

```ts
// cron-watchdog.ts:696, alerts.ts:90, incidents.ts:138
createOutboundEmailSender("primary", { strictOutcome: true, audience: "staff" })
// cron-watchdog.ts:764, admin-schedule-email.ts:410, admin-digest.ts:396
createOutboundEmailSender("primary", { audience: "staff" })
// weekend-check.ts:93
(options.sender ?? createOutboundEmailSender("primary", { audience: "staff" })).sendEmail({
// leave-requests/sync.ts:395
options.sender ?? createOutboundEmailSender("primary", { audience: "staff" })
// email-code.ts:62
await createOutboundEmailSender(key, { audience: "staff" }).sendEmail({ to: email, ...content, idempotencyKey: "auth-code:" + challengeId });
```

In `email-code.ts:44`, the chain already falls back on its own under `resend`, so a second key would only repeat Gmail:

```ts
  if (outboundEmailTransport() !== "apps_script") return ["primary"];
```

Update the comment above that line to read: `// Workspace Gmail and Resend fall back down their own chain, and "backup" is that same chain, so a second attempt would only repeat it.`

- [ ] **Step 4: Run the guard plus each touched module's existing suite**

Run: `npx vitest run --project unit src/lib/email src/lib/auth src/lib/internal src/lib/feedback-autowriter src/lib/classrooms src/lib/progress-tests src/lib/leave-requests`
Expected: PASS. If an existing test asserts `createOutboundEmailSender` was called with exact args, update that expectation to include `{ audience: "staff" }`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add -A src/lib
git commit -m "feat(email): route staff-facing mail and sign-in codes onto the Resend wave"
```

---

### Task 4: PR A gate

- [ ] **Step 1:** `npm test` → all unit suites pass.
- [ ] **Step 2:** `git diff --check` → clean.
- [ ] **Step 3:** Update `docs/reference/env.md`. Add rows for `RESEND_FROM`, `RESEND_REPLY_TO` and `RESEND_AUDIENCE` (values `staff` default | `all`). Add `resend` to the `OUTBOUND_EMAIL_TRANSPORT` row. Update the `RESEND_API_KEY` row to say it is now read by the shared transport, not just Admissions. Commit as `docs(env): document Resend transport variables`.
- [ ] **Step 4:** Open PR A as a **draft** (owner policy for paths that change delivery). Title: `feat(email): Resend transport (staff wave)`. Body: list the env vars, say that with `OUTBOUND_EMAIL_TRANSPORT` unset behaviour is unchanged, and link the setup guide.

---

### Task 5: Admissions uses the shared Resend sender (PR B)

**Files:**
- Modify: `src/lib/admissions/notifications.ts` (constants block at lines ~43–49 and the send block at ~299–322)
- Test: `src/lib/admissions/__tests__/notifications.test.ts`

**Interfaces:**
- Consumes: `createResendSender(env, { from, replyTo })` (Task 1).

- [ ] **Step 1: Update the failing expectations** in `notifications.test.ts`. The existing test stubs `RESEND_API_KEY` and asserts `fetch` was called with `https://api.resend.com/emails`. Add assertions for the new behaviour:

```ts
it("sends with an Idempotency-Key derived from the dedupe key", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-api-key");
  vi.stubEnv("ADMISSIONS_EMAIL_FROM", "BeGifted Admissions <admissions@notify.example.com>");
  // ...existing arrange for a send with dedupeKey "case-1:deadline:2026-10-10"...
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("admissions:case-1:deadline:2026-10-10");
  expect(JSON.parse(init.body as string).from).toBe("BeGifted Admissions <admissions@notify.example.com>");
});

it("falls back to RESEND_FROM, never onboarding@resend.dev", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-api-key");
  vi.stubEnv("ADMISSIONS_EMAIL_FROM", "");
  vi.stubEnv("RESEND_FROM", "BeGifted <no-reply@notify.example.com>");
  // ...send...
  expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).from).toBe("BeGifted <no-reply@notify.example.com>");
});
```

For the arrange step in both tests, copy the input object and `db` stub from the suite's existing "sends via Resend" test (the one asserting `url === "https://api.resend.com/emails"`). Set `dedupeKey: "case-1:deadline:2026-10-10"` in the first test and leave it unset in the second. Use the `fetchMock` variable name that the existing suite uses for its stubbed `fetch`. Keep the existing test `throws when RESEND_API_KEY is not configured (no log row)` and change its regex to `/RESEND_API_KEY|RESEND_FROM/`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/lib/admissions/__tests__/notifications.test.ts`
Expected: the new tests FAIL (no Idempotency-Key header, `from` falls back to resend.dev).

- [ ] **Step 3: Implement.** Delete `RESEND_ENDPOINT` and `DEFAULT_FROM`, and drop the `ResendEmailResponse` type if nothing else uses it. Replace the block from `const apiKey = …` through the `resendEmailId` assignment with:

```ts
  const sender = createResendSender(process.env, {
    from: process.env.ADMISSIONS_EMAIL_FROM?.trim() || undefined,
    replyTo: process.env.ADMISSIONS_EMAIL_REPLY_TO?.trim() || DEFAULT_REPLY_TO,
  });
  // Resend remembers the key for 24h, so a crashed run that retries the same
  // dedupe key cannot double-send; unkeyed sends get a fresh one.
  const { id } = await sender.sendEmail({
    to,
    subject: input.subject,
    html: input.html,
    text: input.text ?? "",
    idempotencyKey: `admissions:${dedupeKey ?? randomUUID()}`,
  });
  const resendEmailId = id;
```

Add imports: `import { randomUUID } from "node:crypto";` and `import { createResendSender } from "@/lib/email/resend";`. If `SendAdmissionsEmailInput` has no `text` field, use `text: ""`. Resend accepts an empty text part, and the html part is what gets rendered.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/lib/admissions`
Expected: PASS.

- [ ] **Step 5: Commit and open a draft PR**

```bash
git add src/lib/admissions
git commit -m "fix(admissions): send through the shared Resend sender with idempotency keys"
```

---

### Task 6: Digest kill switches (PR C)

**Files:**
- Modify: `src/lib/classrooms/admin-schedule-email.ts:321` (top of `sendAdminClassroomScheduleEmail`)
- Modify: `src/lib/progress-tests/admin-digest.ts:316` (top of `sendProgressTestAdminDigest`)
- Test: each module's existing `__tests__/` suite (`admin-schedule-email.test.ts`, `admin-digest.test.ts`)

Default is **on**, which keeps today's behaviour. The owner turns a digest off with an env value, and turning it back on is the same kind of value change. Crons keep firing and simply return `skipped`, so the cron registry, `vercel.json` and the collision test stay untouched.

- [ ] **Step 1: Write the failing tests**

```ts
// admin-schedule-email.test.ts
it("skips without touching the database when CLASSROOM_ADMIN_EMAIL_ENABLED=false", async () => {
  vi.stubEnv("CLASSROOM_ADMIN_EMAIL_ENABLED", "false");
  const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() } as unknown as Database;
  const sender = { sendEmail: vi.fn() };
  const result = await sendAdminClassroomScheduleEmail(db, { sender, assignmentDate: "2026-10-08" });
  expect(result).toMatchObject({ status: "skipped", assignmentDate: "2026-10-08", attempted: 0 });
  expect(result.message).toMatch(/disabled/i);
  expect(sender.sendEmail).not.toHaveBeenCalled();
  expect(db.select).not.toHaveBeenCalled();
});

// admin-digest.test.ts
it("skips without touching the database when PROGRESS_TEST_ADMIN_DIGEST_ENABLED=false", async () => {
  vi.stubEnv("PROGRESS_TEST_ADMIN_DIGEST_ENABLED", "false");
  const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn() } as unknown as Database;
  const sender = { sendEmail: vi.fn() };
  const result = await sendProgressTestAdminDigest(db, new Date("2026-10-07T02:00:00Z"), { sender });
  expect(result).toMatchObject({ status: "skipped", digestDate: "2026-10-07", attempted: 0 });
  expect(result.message).toMatch(/disabled/i);
  expect(db.select).not.toHaveBeenCalled();
});
```

Add `afterEach(() => vi.unstubAllEnvs())` if the suite doesn't already have it.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit src/lib/classrooms/__tests__/admin-schedule-email.test.ts src/lib/progress-tests/__tests__/admin-digest.test.ts`
Expected: the new tests FAIL (the database is touched and the status is not skipped).

- [ ] **Step 3: Implement.** In `admin-schedule-email.ts`, insert the following right after `const assignmentDate = …` and before `hasTerminalAdminEmailForDate`:

```ts
  if (process.env.CLASSROOM_ADMIN_EMAIL_ENABLED?.trim().toLowerCase() === "false") {
    return {
      status: "skipped", assignmentDate, assignmentRunId: null, emailRunId: null,
      attempted: 0, success: 0, failed: 0,
      message: "Admin classroom schedule email is disabled (CLASSROOM_ADMIN_EMAIL_ENABLED=false).",
    };
  }
```

In `admin-digest.ts`, insert this right after `const digestDate = todayBangkok(now);`:

```ts
  if (process.env.PROGRESS_TEST_ADMIN_DIGEST_ENABLED?.trim().toLowerCase() === "false") return {
    status: "skipped", digestDate, digestRunId: null, approachingCount: 0, dueCount: 0,
    unresolvedCount: 0, attempted: 0, success: 0, failed: 0,
    message: "Progress test admin digest is disabled (PROGRESS_TEST_ADMIN_DIGEST_ENABLED=false).",
  };
```

- [ ] **Step 4: Run the tests and confirm they pass.** Also run `npx vitest run --project unit src/lib/data-health src/lib/classrooms` to confirm `run-job.ts` and `daily-automation.ts` still handle a `skipped` result. Both already receive `skipped` today for the "already recorded" path.

- [ ] **Step 5:** Add both vars to `docs/reference/env.md`. Commit as `feat: env kill switches for the classroom admin email and progress-test admin digest`. Open a draft PR.

---

### Task 7: Delivery-events table and webhook verifier (PR D, part 1)

**Files:**
- Modify: `src/lib/db/schema.ts` (append after `wiseWebhookEvents`, ~line 6342)
- Create: `drizzle/0111_email_delivery_events.sql` (generated, then trimmed)
- Create: `src/lib/email/resend-webhook.ts`
- Test: `src/lib/email/__tests__/resend-webhook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const RESEND_WEBHOOK_MAX_BODY_BYTES = 256_000;
  export function verifyResendSignature(input: { secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; now?: Date }): boolean;
  export interface ParsedResendEvent { type: string; messageId: string | null; occurredAt: Date | null; bounceType: string | null }
  export function parseResendEvent(body: string): ParsedResendEvent | null;
  export function isDeliveryProblem(type: string): boolean; // email.bounced | email.complained | email.delivery_delayed | email.failed
  ```

- [ ] **Step 1: Add the table** to `schema.ts`:

```ts
/**
 * Resend delivery webhooks (email.sent / delivered / bounced / complained /
 * delivery_delayed / failed). One row per Svix message id; recipient and
 * content are deliberately not stored — join on provider_message_id to the
 * sending feature's own log when an address is needed.
 */
export const emailDeliveryEvents = pgTable("email_delivery_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  svixId: text("svix_id").notNull(),
  provider: text("provider").notNull().default("resend"),
  providerMessageId: text("provider_message_id"),
  eventType: text("event_type").notNull(),
  bounceType: text("bounce_type"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("email_delivery_events_svix_idx").on(table.svixId),
  index("email_delivery_events_message_idx").on(table.providerMessageId),
  index("email_delivery_events_type_idx").on(table.eventType, table.receivedAt),
]);
```

Run `npm run db:generate`, rename the output to `drizzle/0111_email_delivery_events.sql`, and confirm that the SQL contains **only** the `CREATE TABLE email_delivery_events` statement and its three indexes. Delete any catch-up statements from snapshot drift, and keep the journal entry consistent with the rename.

- [ ] **Step 2: Write the failing verifier tests**

```ts
// src/lib/email/__tests__/resend-webhook.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isDeliveryProblem, parseResendEvent, verifyResendSignature } from "../resend-webhook";

const rawSecret = Buffer.from("super-secret-bytes").toString("base64");
const secret = `whsec_${rawSecret}`;
const now = new Date("2026-10-07T03:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ type: "email.bounced", created_at: "2026-10-07T02:59:58.000Z", data: { email_id: "re-msg-1", bounce: { type: "Permanent" } } });
const sign = (id: string, t: string, b: string) =>
  "v1," + createHmac("sha256", Buffer.from(rawSecret, "base64")).update(`${id}.${t}.${b}`).digest("base64");

describe("verifyResendSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body), body, now })).toBe(true);
  });
  it("accepts when one of several space-separated signatures matches", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sign("msg_1", ts, body)}`, body, now })).toBe(true);
  });
  it("rejects bad signature", () => {
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body + " "), body, now })).toBe(false);
  });
  it("rejects stale timestamp (> 5 minutes)", () => {
    const old = String(Number(ts) - 301);
    expect(verifyResendSignature({ secret, id: "msg_1", timestamp: old, signature: sign("msg_1", old, body), body, now })).toBe(false);
  });
  it("rejects missing headers", () => {
    expect(verifyResendSignature({ secret, id: null, timestamp: ts, signature: "v1,x", body, now })).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("extracts type, message id, time and bounce type", () => {
    expect(parseResendEvent(body)).toEqual({
      type: "email.bounced", messageId: "re-msg-1",
      occurredAt: new Date("2026-10-07T02:59:58.000Z"), bounceType: "Permanent",
    });
  });
  it("returns null for junk", () => {
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe("isDeliveryProblem", () => {
  it("flags bounces and complaints only", () => {
    expect(isDeliveryProblem("email.bounced")).toBe(true);
    expect(isDeliveryProblem("email.complained")).toBe(true);
    expect(isDeliveryProblem("email.delivered")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail.** Run `npx vitest run --project unit src/lib/email/__tests__/resend-webhook.test.ts`. Expected: module not found.

- [ ] **Step 4: Implement**

```ts
// src/lib/email/resend-webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const RESEND_WEBHOOK_MAX_BODY_BYTES = 256_000;
/** Svix replay window. */
const TOLERANCE_SECONDS = 300;
const PROBLEM_TYPES: ReadonlySet<string> = new Set([
  "email.bounced", "email.complained", "email.delivery_delayed", "email.failed",
]);

/**
 * Verifies a Svix-signed Resend webhook: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` keyed by the base64 part of the
 * `whsec_…` secret; `svix-signature` holds space-separated `v1,<base64>`
 * candidates. Constant-time compare; 5-minute timestamp window.
 */
export function verifyResendSignature(input: {
  secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; now?: Date;
}): boolean {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface ParsedResendEvent {
  type: string;
  messageId: string | null;
  occurredAt: Date | null;
  bounceType: string | null;
}

export function parseResendEvent(body: string): ParsedResendEvent | null {
  let json: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; bounce?: { type?: unknown } } };
  try { json = JSON.parse(body); } catch { return null; }
  if (typeof json?.type !== "string" || !json.type) return null;
  const created = typeof json.created_at === "string" ? new Date(json.created_at) : null;
  return {
    type: json.type,
    messageId: typeof json.data?.email_id === "string" ? json.data.email_id : null,
    occurredAt: created && !Number.isNaN(created.getTime()) ? created : null,
    bounceType: typeof json.data?.bounce?.type === "string" ? json.data.bounce.type : null,
  };
}

export function isDeliveryProblem(type: string): boolean {
  return PROBLEM_TYPES.has(type);
}
```

- [ ] **Step 5: Run the tests and confirm they pass. Typecheck and commit.**

```bash
npx vitest run --project unit src/lib/email/__tests__/resend-webhook.test.ts && npm run typecheck
git add src/lib/db/schema.ts drizzle/ src/lib/email/resend-webhook.ts src/lib/email/__tests__/resend-webhook.test.ts
git commit -m "feat(email): delivery-events table and Svix webhook verification"
```

---

### Task 8: Webhook route and proxy allowlist (PR D, part 2)

**Files:**
- Create: `src/app/api/email/resend-webhook/route.ts`
- Create: `src/app/api/email/resend-webhook/__tests__/route.test.ts`
- Modify: `src/proxy.ts` (`isPublicRoute`, next to the Wise webhook line)
- Modify: `src/__tests__/middleware.test.ts`

**Interfaces:**
- Consumes: `verifyResendSignature`, `parseResendEvent`, `isDeliveryProblem`, `RESEND_WEBHOOK_MAX_BODY_BYTES`, `emailDeliveryEvents` (Task 7).

- [ ] **Step 1: Write the failing route tests**

```ts
// src/app/api/email/resend-webhook/__tests__/route.test.ts
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.hoisted(() => vi.fn());
const onConflictDoNothing = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ insert: () => ({ values: (v: unknown) => { insertValues(v); return { onConflictDoNothing }; } }) }),
}));

import { POST } from "../route";

const rawSecret = Buffer.from("s").toString("base64");
const body = JSON.stringify({ type: "email.bounced", created_at: "2026-10-07T03:00:00.000Z", data: { email_id: "re-1", bounce: { type: "Permanent" } } });
function request(opts: { sig?: string; id?: string; ts?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const id = opts.id ?? "msg_1";
  const sig = opts.sig ?? "v1," + createHmac("sha256", Buffer.from(rawSecret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("https://x/api/email/resend-webhook", {
    method: "POST", body, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig, "content-type": "application/json" },
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("POST /api/email/resend-webhook", () => {
  it("503s when the secret is not configured", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await POST(request() as never)).status).toBe(503);
  });
  it("401s on a bad signature and stores nothing", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${rawSecret}`);
    expect((await POST(request({ sig: "v1,AAAA" }) as never)).status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });
  it("stores a verified event keyed by svix id and answers 200", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${rawSecret}`);
    const res = await POST(request() as never);
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      svixId: "msg_1", providerMessageId: "re-1", eventType: "email.bounced", bounceType: "Permanent",
    }));
    expect(onConflictDoNothing).toHaveBeenCalled(); // duplicate svix-id is a no-op
  });
});
```

Add to `src/__tests__/middleware.test.ts`, following the file's existing pattern for the Wise webhook case:

```ts
it("lets the Resend webhook through without a session", async () => {
  // mirror the existing "/api/wise/webhook" assertion, path "/api/email/resend-webhook"
});
```

Copy the Wise webhook test body exactly and change only the path string.

- [ ] **Step 2: Run the tests and confirm they fail.** Expected: route module missing, and the middleware test redirects to `/login`.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/email/resend-webhook/route.ts
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  RESEND_WEBHOOK_MAX_BODY_BYTES,
  isDeliveryProblem,
  parseResendEvent,
  verifyResendSignature,
} from "@/lib/email/resend-webhook";

/**
 * Resend delivery webhook. Public route (proxy allowlist); authenticated
 * in-handler by Svix signature. Stores one row per svix-id (replays are
 * no-ops) and logs bounces/complaints by type + message id only.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? "0") > RESEND_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }
  const body = await request.text();
  const svixId = request.headers.get("svix-id");
  const verified = verifyResendSignature({
    secret,
    id: svixId,
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body,
  });
  if (!verified || !svixId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const event = parseResendEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });
  try {
    await getDb()
      .insert(schema.emailDeliveryEvents)
      .values({
        svixId,
        providerMessageId: event.messageId,
        eventType: event.type,
        bounceType: event.bounceType,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error("[resend-webhook] store failed:", error instanceof Error ? error.name : "UnknownError");
    // 500 makes Svix retry with backoff.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (isDeliveryProblem(event.type)) {
    console.error(`[resend-webhook] ${event.type} ${event.bounceType ?? ""} message=${event.messageId ?? "unknown"}`);
  }
  return NextResponse.json({ ok: true });
}
```

In `src/proxy.ts`, add the following directly below the Wise webhook line:

```ts
    // Resend delivery webhook: authenticated in-handler by Svix signature.
    pathname === "/api/email/resend-webhook" ||
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit src/app/api/email src/__tests__/middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate, docs and commit**

```bash
npm run typecheck && npm test && git diff --check
```

Add `RESEND_WEBHOOK_SECRET` to `docs/reference/env.md`. Add the endpoint to `docs/reference/api/misc.md` (public, Svix signature). Then:

```bash
git add src/app/api/email src/proxy.ts src/__tests__/middleware.test.ts docs/reference
git commit -m "feat(email): signed Resend delivery webhook with replay-safe storage"
```

Open as a draft PR. The migration `0111` must be applied to prod **before** merge (see the setup guide, Phase 5).

---

## Rollout order (the owner flips these; code ships dark)

1. Merge PR A. With `OUTBOUND_EMAIL_TRANSPORT` unset, nothing changes.
2. Set `OUTBOUND_EMAIL_TRANSPORT=resend` and redeploy. Staff mail and sign-in codes now go through Resend; teacher mail goes through Workspace Gmail, which also moves it off the Apps Script relay.
3. Merge PR B. Admissions starts working.
4. Merge PR C, then set the two `*_ENABLED=false` values if the digests are being dropped.
5. Merge PR D after migration 0111, then add the webhook in Resend and set `RESEND_WEBHOOK_SECRET`.
6. After 1–2 weeks with a low bounce rate, set `RESEND_AUDIENCE=all` so teacher mail moves too.

*Execution note: shipped as two PRs (PR1 = Tasks 1–6, PR2 = Tasks 7–8). Admissions goes live at owner Phase 3 (Resend key + from address deployed after PR1), not Phase 4.*

**Rollback at any point:** set `OUTBOUND_EMAIL_TRANSPORT=gmail` and redeploy. Mail goes back to Workspace Gmail with the relay as fallback.

## Deferred (not in this plan)

- A Data Health card showing bounces and complaints from `email_delivery_events` over the last 7 days.
- Replacing the cron-watchdog email with a LINE ping (owner still choosing between turning the email off and the LINE ping).
- Investigating the 2026-09-08 leave-request burst (790 rows marked `success` within 28 seconds).
