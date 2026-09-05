import { describe, expect, it } from "vitest";
import { onboardingEnabled, resolveOnboardingIdentities, planTutorContacts, unmanagedTeacherSessions, scheduleRecipientEmail, type AccountMapping, type Contact, type Account } from "../planner";
import type { WiseTeacher } from "@/lib/wise/types";
const teacher = (id = "one", name = "Alice (Ali) Smith", email: string | undefined = "ali@example.com"): WiseTeacher => ({ _id: id, userId: { _id: `user-${id}`, name, email } });
const contact = (patch: Partial<Contact> = {}): Contact => ({ canonicalKey: "Ali", displayName: "Ali", onsiteEmail: null, onlineEmail: null, active: true, sourceNames: [], wiseEmailState: {}, ...patch });
function plan(teachers = [teacher()], contacts: Contact[] = [], previous: Account[] = [], mappings: AccountMapping[] = previous) {
  const identities = resolveOnboardingIdentities(teachers, [], mappings);
  return planTutorContacts(teachers, identities.groups, identities.blocked, contacts, previous);
}
describe("Wise teacher onboarding", () => {
  it("starts at September 6 Bangkok midnight", () => {
    expect(onboardingEnabled(new Date("2026-09-05T16:59:59Z"))).toBe(false);
    expect(onboardingEnabled(new Date("2026-09-05T17:00:00Z"))).toBe(true);
  });
  it("imports new teachers and normalizes their Wise email", () => {
    const p = plan([teacher("one", "Alice (Ali) Smith", " ALI@EXAMPLE.COM ")]);
    expect(p.contacts[0].onsiteEmail).toBe("ali@example.com");
    expect(p.counts).toEqual({ created: 1, updated: 0, blocked: 0 });
    expect(plan([teacher()], p.contacts, p.accounts).counts).toEqual({ created: 0, updated: 0, blocked: 0 });
  });
  it("uses Online email only as fallback", () => {
    const p = plan([teacher("online", "Alice (Ali) Smith Online")]);
    expect(p.contacts[0].onsiteEmail).toBeNull();
    expect(scheduleRecipientEmail(p.contacts[0])).toBe("ali@example.com");
    expect(scheduleRecipientEmail({ onsiteEmail: "configured@example.com", onlineEmail: "online@example.com" })).toBe("configured@example.com");
    expect(scheduleRecipientEmail({ onsiteEmail: "invalid", onlineEmail: "online@example.com" })).toBe("online@example.com");
  });
  it("imports a legitimate pair without merging unrelated nickname matches", () => {
    expect(plan([teacher(), teacher("online", "Alice (Ali) Smith Online", "online@example.com")]).counts.blocked).toBe(0);
    expect(plan([teacher(), teacher("online", "Another (Ali) Person Online")]).counts.blocked).toBe(2);
    expect(plan([teacher(), teacher("other", "Another (Ali) Person")]).contacts[0].onsiteEmail).toBeNull();
  });
  it("pairs exact full names without nicknames under a stable account key", () => {
    const p = plan([teacher("one", "Alice Smith"), teacher("online", "Alice Smith Online", "online@example.com")]);
    expect(p.contacts).toHaveLength(1);
    expect(p.contacts[0]).toMatchObject({ canonicalKey: "wise:user-one", onsiteEmail: "ali@example.com", onlineEmail: "online@example.com" });
  });

  it("gives a new teacher without a nickname a stable account identity", () => {
    const p = plan([teacher("one", "Alice Smith")]);
    expect(p.contacts[0].canonicalKey).toBe("wise:user-one");
    const renamed = plan([teacher("one", "Alice (New) Smith")], p.contacts, p.accounts);
    expect(renamed.accounts[0].canonicalKey).toBe("wise:user-one");
  });
  it("preserves legacy canonical keys and existing addresses", () => {
    const old = contact({ onsiteEmail: "configured@example.com" });
    const p = plan([teacher("one", "Alice (Changed) Smith")], [old], [], [{ wiseTeacherId: "one", wiseUserId: "user-one", canonicalKey: "Ali", displayName: "Alice (Ali) Smith", isOnlineVariant: false }]);
    expect(p.contacts[0].onsiteEmail).toBe("configured@example.com");
    expect(p.accounts[0].canonicalKey).toBe("Ali");
  });
  it("updates managed addresses, preserves human edits and manual clearing", () => {
    const p = plan();
    const next = plan([teacher("one", undefined, "new@example.com")], p.contacts, p.accounts);
    expect(next.contacts[0].onsiteEmail).toBe("new@example.com");
    for (const edited of ["manual@example.com", null]) {
      const edit = plan([teacher()], [{ ...p.contacts[0], onsiteEmail: edited }], p.accounts);
      expect(edit.contacts[0].onsiteEmail).toBe(edited);
      expect(edit.contacts[0].wiseEmailState.onsiteEmail?.mode).toBe("manual");
      expect(plan([teacher()], edit.contacts, edit.accounts).contacts[0].onsiteEmail).toBe(edited);
    }
  });
  it("does not reactivate or fill a manually inactive contact", () => {
    const p = plan([teacher()], [contact({ active: false })]);
    expect(p.contacts[0].active).toBe(false);
    expect(p.contacts[0].onsiteEmail).toBeNull();
  });
  it("retires missing and invalid imported emails, then recovers", () => {
    const p = plan();
    for (const teachers of [[], [teacher("one", undefined, "bad")]]) {
      const retired = plan(teachers, p.contacts, p.accounts);
      expect(retired.contacts[0].onsiteEmail).toBeNull();
      const restored = plan([teacher()], retired.contacts, retired.accounts);
      expect(restored.contacts[0].onsiteEmail).toBe("ali@example.com");
    }
  });
  it("blocks duplicate addresses across unrelated new or configured contacts", () => {
    const p = plan([teacher(), teacher("two", "Bob (Bob) Jones")]);
    expect(p.counts.blocked).toBe(2);
    expect(p.contacts.every(c => c.onsiteEmail === null)).toBe(true);
    expect(plan([teacher()], [contact({ canonicalKey: "Other", onsiteEmail: "ali@example.com" })]).counts.blocked).toBe(1);
  });
  it("does not allow a newly hired namesake to inherit a retired teacher identity", () => {
    const p = plan();
    const next = plan([teacher("new", "Another (Ali) Person")], p.contacts, p.accounts);
    expect(next.counts.blocked).toBeGreaterThanOrEqual(1);
    expect(next.contacts[0].onsiteEmail).toBeNull();
  });
  it("retiring an unused imported contact does not create a permanent delivery blocker", () => {
    const p = plan();
    const retired = plan([], p.contacts, p.accounts);
    expect(retired.counts.blocked).toBe(0);
    expect(retired.contacts[0].onsiteEmail).toBeNull();
  });
  it("isolates duplicate user IDs instead of losing an account or importing its email", () => {
    const first = teacher();
    const second = { ...teacher("two", "Bob (Bob) Jones"), userId: { _id: "user-one", name: "Bob (Bob) Jones", email: "bob@example.com" } };
    const p = plan([first, second]);
    expect(p.accounts).toHaveLength(2);
    expect(p.accounts.every(a => !!a.canonicalKey && a.status !== "active")).toBe(true);
    expect(p.contacts.every(c => !scheduleRecipientEmail(c))).toBe(true);
  });

  it("reports absent-roster Kem sessions and clears the mismatch once the roster includes him", () => {
    const sessions = [{ _id: "kem-session", userId: "user-kem", scheduledStartTime: "2026-09-09T11:45:00Z", scheduledEndTime: "2026-09-09T12:45:00Z", type: "SCHEDULED" }];
    expect(unmanagedTeacherSessions([], sessions)[0]).toMatchObject({ sessionId: "kem-session", teacherUserId: "user-kem" });
    expect(unmanagedTeacherSessions([teacher("kem", "Kemjira (Kem) Waritpariya")], sessions)).toEqual([]);
  });
});
