import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScheduleEmailSendInput } from "@/lib/classrooms/schedule-email";
import { buildAlertDigest, sendAlertDigest } from "../alerts";
import type { PendingAlert } from "../store";
import { CLASS_ID, SESSION_ID } from "./fixtures";

const KEVIN = "696e2c4343579bbada2340ed";
const NOT_HALTED = { haltedAt: null, haltReason: null };

function alert(overrides: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    wiseSessionId: SESSION_ID,
    wiseClassId: CLASS_ID,
    wiseTeacherUserId: KEVIN,
    kind: "held",
    state: "held",
    reason: "sol:unfaithful:scored 95%",
    deadlineAt: new Date("2026-09-30T16:59:59.999Z"),
    ...overrides,
  };
}

/** A `judge_failing` alert with its run of failures. */
function judgeFailing(judge: Partial<NonNullable<PendingAlert["judge"]>>, overrides: Partial<PendingAlert> = {}): PendingAlert {
  return alert({
    kind: "judge_failing", state: "transcribing", reason: "infra:judge:medium:timeout",
    judge: { errors: 0, unreached: 0, unreachedCause: null, since: "2026-09-30T05:10:00.000Z", ...judge },
    ...overrides,
  });
}

const keyOf = (...parts: string[]) => `feedback-autowriter:${createHash("sha256").update(parts.toSorted().join("|")).digest("hex").slice(0, 32)}`;

describe("buildAlertDigest", () => {
  it("names the tutor, the deadline in Bangkok time, what to do and the class's reason", () => {
    const digest = buildAlertDigest([alert()], NOT_HALTED);
    expect(digest.subject).toBe("Feedback autowriter: 1 class needs attention");
    expect(digest.text).toContain("Kevin (Kev) Y. Hsieh Online · deadline 30 Sept, 23:59 (Bangkok) · Not written — the draft failed checks.");
    expect(digest.text).toContain("[sol:unfaithful:scored 95%]");
    expect(digest.html).toContain("<li><b>Kevin (Kev) Y. Hsieh Online</b>");
    expect(buildAlertDigest([alert(), alert({ id: "00000000-0000-4000-8000-000000000002", kind: "expired" })], { haltedAt: new Date("2026-09-30T04:00:00.000Z"), haltReason: "POST not verified" }))
      .toMatchObject({ subject: "Feedback autowriter: 2 classes need attention", text: expect.stringContaining("Autowriter is HALTED since 30 Sept, 11:00: POST not verified") });
  });

  describe("judge_failing: says why the draft could not be checked, and blames the judge model only for its own failures", () => {
    const text = (judge: Partial<NonNullable<PendingAlert["judge"]>>) => buildAlertDigest([judgeFailing(judge)], NOT_HALTED).text;
    const BLAME = /the judge model failed|failures of the judge model/u;

    it("three failures of the judge itself", () => {
      const own = text({ errors: 3 });
      expect(own).toContain("The draft could not be checked 3 runs in a row (the judge model failed: a time-out, no verdict, an answer from the wrong route or a provider error), so nothing has been posted.");
      expect(own).toContain("keeps retrying every 10 minutes until the deadline; write it yourself if it stays blank.");
      expect(own).toContain("[infra:judge:medium:timeout]");
    });

    it("six runs in which the judge could not be asked: a rate limit, our function's time, our account or connection", () => {
      const limited = text({ unreached: 6, unreachedCause: "rate_limited" });
      expect(limited).toContain("could not be checked 6 runs in a row (not a failure of the judge model: OpenRouter rate limited the judge's route)");
      const outOfTime = text({ unreached: 6, unreachedCause: "out_of_time" });
      expect(outOfTime).toContain("(not a failure of the judge model: our own function ran out of time before the judge could start)");
      const account = text({ unreached: 7, unreachedCause: "account_or_connection" });
      expect(account).toContain("could not be checked 7 runs in a row (not a failure of the judge model: our OpenRouter account or connection refused the call (no credit, a bad key or a network error))");
      for (const written of [limited, outOfTime, account]) expect(written).not.toMatch(BLAME);
    });

    it("a mix of both: each is counted, and the judge model is blamed for its own share only", () => {
      expect(text({ errors: 2, unreached: 4, unreachedCause: "rate_limited" }))
        .toContain("could not be checked 6 runs in a row (failures of the judge model: 2; not its failure: 4 — the last time, OpenRouter rate limited the judge's route)");
      expect(text({ errors: 3, unreached: 1, unreachedCause: "out_of_time" }))
        .toContain("could not be checked 4 runs in a row (failures of the judge model: 3; not its failure: 1 — the last time, our own function ran out of time before the judge could start)");
    });

    it("blames nobody when the counts are not known", () => {
      for (const written of [text({}), buildAlertDigest([alert({ kind: "judge_failing", state: "pending" })], NOT_HALTED).text, text({ unreached: 6 })]) {
        expect(written).not.toMatch(BLAME);
      }
      expect(text({})).toContain("could not be checked several runs in a row (its check did not finish)");
      expect(text({ unreached: 6 })).toContain("6 runs in a row (not a failure of the judge model: the judge could not be asked)");
    });
  });

  describe("the relay's idempotency key", () => {
    it("is one key per set of alerts, whatever their order — as before for every kind but judge_failing", () => {
      const held = alert();
      const expired = alert({ id: "00000000-0000-4000-8000-000000000002", kind: "expired", state: "expired" });
      expect(buildAlertDigest([held], NOT_HALTED).idempotencyKey).toBe(keyOf(`${held.id}:held`));
      expect(buildAlertDigest([held, expired], NOT_HALTED).idempotencyKey).toBe(keyOf(`${held.id}:held`, `${expired.id}:expired`));
      expect(buildAlertDigest([expired, held], NOT_HALTED).idempotencyKey).toBe(buildAlertDigest([held, expired], NOT_HALTED).idempotencyKey);
      // Nothing about a run of judge failures enters another kind's key.
      expect(buildAlertDigest([{ ...held, judge: { errors: 3, unreached: 0, unreachedCause: null, since: "2026-09-30T05:10:00.000Z" } }], NOT_HALTED).idempotencyKey)
        .toBe(keyOf(`${held.id}:held`));
    });

    it("differs for each run of judge failures on the same class, so the relay sends the second one too", () => {
      const first = judgeFailing({ errors: 3, since: "2026-09-30T05:10:00.000Z" });
      const second = judgeFailing({ errors: 3, since: "2026-09-30T09:40:00.000Z" });
      const keys = [first, second].map((episode) => buildAlertDigest([episode], NOT_HALTED).idempotencyKey);
      expect(keys[0]).toBe(keyOf(`${first.id}:judge_failing:2026-09-30T05:10:00.000Z`));
      expect(keys[1]).toBe(keyOf(`${first.id}:judge_failing:2026-09-30T09:40:00.000Z`));
      expect(keys[1]).not.toBe(keys[0]);
      // The same episode keeps its key: a digest the relay already sent is not sent twice.
      expect(buildAlertDigest([judgeFailing({ errors: 4, since: "2026-09-30T05:10:00.000Z" })], NOT_HALTED).idempotencyKey).toBe(keys[0]);
      // Without a recorded time the key is the plain one.
      expect(buildAlertDigest([judgeFailing({ errors: 3, since: null })], NOT_HALTED).idempotencyKey).toBe(keyOf(`${first.id}:judge_failing`));
    });
  });
});

describe("sendAlertDigest", () => {
  it("sends one email per recipient, each under the digest's key and the recipient", async () => {
    const emails: ScheduleEmailSendInput[] = [];
    const alerts = [judgeFailing({ errors: 3 })];
    const sent = await sendAlertDigest({
      alerts, recipients: ["a@example.com", "b@example.com"], halt: NOT_HALTED,
      sender: { sendEmail: async (input) => { emails.push(input); return { id: "e" }; } },
    });
    expect(sent).toEqual({ sent: true, error: null });
    const key = buildAlertDigest(alerts, NOT_HALTED).idempotencyKey;
    expect(emails.map((email) => [email.to, email.idempotencyKey])).toEqual([["a@example.com", `${key}:a@example.com`], ["b@example.com", `${key}:b@example.com`]]);
  });

  it("reports a relay failure, no recipients and nothing to send without claiming a send", async () => {
    const failing = { sendEmail: async () => { throw new Error("relay down"); } };
    expect(await sendAlertDigest({ alerts: [alert()], recipients: ["a@example.com"], halt: NOT_HALTED, sender: failing })).toEqual({ sent: false, error: "relay down" });
    expect(await sendAlertDigest({ alerts: [alert()], recipients: [], halt: NOT_HALTED })).toEqual({ sent: false, error: "FEEDBACK_AUTOWRITER_ALERT_EMAILS is empty" });
    expect(await sendAlertDigest({ alerts: [], recipients: ["a@example.com"], halt: NOT_HALTED })).toEqual({ sent: false, error: null });
  });
});
