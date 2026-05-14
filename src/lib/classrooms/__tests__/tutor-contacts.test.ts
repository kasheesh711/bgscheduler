import { describe, expect, it } from "vitest";
import {
  buildDefaultTutorContacts,
  canonicalKeyFromContactName,
} from "../tutor-contacts";

describe("tutor contact defaults", () => {
  it("collapses online and onsite records under the same canonical key", () => {
    const contacts = buildDefaultTutorContacts([
      { name: "Samantha (Sam) Nicole Beattie Online", email: "online@example.com" },
      { name: "Samantha (Sam) Nicole Beattie", phoneNumber: "661", email: "onsite@example.com" },
    ]);

    expect(contacts).toEqual([
      expect.objectContaining({
        canonicalKey: "Samantha",
        onsiteEmail: "onsite@example.com",
        onlineEmail: "online@example.com",
        onsitePhone: "661",
      }),
    ]);
  });

  it("applies project aliases so contacts match active identity groups", () => {
    expect(canonicalKeyFromContactName("Prohrak (Paoju) Kruengthomya")).toBe("Paojuu");
    expect(canonicalKeyFromContactName("Nacha (Poi) Srinakarin")).toBe("Nacha (Poi)");
    expect(canonicalKeyFromContactName("Kevin (Kev) Y. Hsieh")).toBe("Kevin");
  });

  it("keeps a missing onsite email empty even when an online email exists", () => {
    const contacts = buildDefaultTutorContacts([
      { name: "Chanamon (Pearcha) Rattanapittayaporn Online", email: "online@example.com" },
      { name: "Chanamon (Pearcha) Rattanapittayaporn" },
    ]);

    expect(contacts[0]).toMatchObject({
      canonicalKey: "Pearcha",
      onsiteEmail: null,
      onlineEmail: "online@example.com",
    });
  });
});
