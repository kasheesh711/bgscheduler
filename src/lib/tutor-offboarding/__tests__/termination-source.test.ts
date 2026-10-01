import { describe, expect, it } from "vitest";
import { buildTerminationMatches, parseTerminationSheet, type TerminationSheetRow } from "../termination-source";
import type { PersonSignals } from "../types";

const NOW = new Date("2026-10-01T05:00:00Z");
const headers = ["Tutor Full Name", "Wise Tutor", "Tutor Nickname", "Tutor email", "Tutor email 2"];
const cell = (formattedValue: string, strikethrough = false) => ({ formattedValue, effectiveFormat: { textFormat: { strikethrough } } });
function sheet(values: ReturnType<typeof cell>[][]) {
  return { sheets: [{ properties: { sheetId: 470328060, title: "Tutors" }, data: [{ startColumn: 3, rowData: [{ values: headers.map((v) => cell(v)) }, ...values.map((v) => ({ values: v }))] }] }] };
}
function source(overrides: Partial<TerminationSheetRow> = {}): TerminationSheetRow {
  return { sourceRow: 2, fullName: "Aria Smith", wiseName: "Aria (Ari) Smith", nickname: "Ari", emails: ["aria@example.com"], terminated: true, ...overrides };
}
function person(key: string, email = "aria@example.com", name = "Aria (Ari) Smith"): PersonSignals {
  return { canonicalKey: key, displayName: key, accounts: [{ wiseTeacherId: key, wiseUserId: key, displayName: name, email, status: "active", relation: "TEACHER", joinedOn: null, courseCount: null, activated: null, availabilityKnown: true, workingHourWindows: 0, isOnlineVariant: false }], lastTaughtAt: null, lastTaughtBySource: { ledger: null, pastBlocks: null, postClass: null }, upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false };
}
function match(people: PersonSignals[], rows: TerminationSheetRow[], checkedAt: string | null = NOW.toISOString(), lastError: string | null = null) {
  return buildTerminationMatches(people, { rows, checkedAt, lastError }, NOW);
}

describe("parseTerminationSheet", () => {
  it("reads effective name strikethrough and retains unstruck identities for conflict checks", () => {
    const rows = parseTerminationSheet(sheet([
      [cell("Aria Smith", true), cell("Aria (Ari) Smith", true), cell("Ari", true), cell(" ARIA@example.com "), cell("")],
      [cell("Bodhi Jones"), cell("Bodhi (Bo) Jones"), cell("Bo"), cell("bo@example.com"), cell("")],
    ]));
    expect(rows).toEqual([source(), source({ sourceRow: 3, fullName: "Bodhi Jones", wiseName: "Bodhi (Bo) Jones", nickname: "Bo", emails: ["bo@example.com"], terminated: false })]);
  });
  it("rejects a changed header, wrong tab, or empty source instead of replacing good evidence", () => {
    const bad = sheet([]);
    expect(() => parseTerminationSheet(bad)).toThrow();
    bad.sheets[0].properties.sheetId = 1;
    expect(() => parseTerminationSheet(bad)).toThrow();
    const changed = sheet([[cell("Name")]]);
    changed.sheets[0].data[0].rowData[0].values[0].formattedValue = "Unknown";
    expect(() => parseTerminationSheet(changed)).toThrow();
  });
  it("fails visibly on inconsistent or partial name strikethrough", () => {
    expect(() => parseTerminationSheet(sheet([[cell("Aria Smith", true), cell("Aria (Ari) Smith"), cell("Ari"), cell("")]]))).toThrow();
    const partial = sheet([[cell("Aria Smith", true), cell("Aria (Ari) Smith", true), cell("Ari", true), cell("")]]);
    Object.assign(partial.sheets[0].data[0].rowData[1].values[0], { textFormatRuns: [{ startIndex: 5, format: { strikethrough: false } }] });
    expect(() => parseTerminationSheet(partial)).toThrow();
  });
  it("accepts full-cell rich text strikethrough", () => {
    const rich = sheet([[cell("Aria Smith"), cell("Aria (Ari) Smith", true), cell("Ari", true), cell("")]]);
    Object.assign(rich.sheets[0].data[0].rowData[1].values[0], { textFormatRuns: [{ startIndex: 0, format: { strikethrough: true } }] });
    expect(parseTerminationSheet(rich)[0].terminated).toBe(true);
  });
  it("ignores modality notes in email columns as unknown identity signals", () => {
    const result = parseTerminationSheet(sheet([[cell("Aria Smith", true), cell("Aria (Ari) Smith", true), cell("Ari", true), cell("aria@example.com"), cell("Online class only")]]));
    expect(result[0].emails).toEqual(["aria@example.com"]);
  });
});

describe("buildTerminationMatches", () => {
  it("matches unique normalized email and provides an exact source link", () => {
    const result = match([person("Ari", " ARIA@example.com ")], [source()]);
    expect(result.byKey.Ari).toMatchObject({ sourceRow: 2, match: "email", checkedAt: NOW.toISOString() });
    expect(result.byKey.Ari.sourceUrl).toContain("range=D2:H2");
    expect(result.source).toMatchObject({ status: "ready", confirmedRows: 1, matchedPeople: 1, unmatched: [] });
  });
  it("allows unique full Wise name when the email is unavailable but never a nickname alone", () => {
    expect(match([person("Ari", "")], [source()]).byKey.Ari?.match).toBe("full_name");
    const result = match([person("Ari", "other@example.com", "Ari")], [source()]);
    expect(result.byKey).toEqual({});
    expect(result.source.unmatched).toHaveLength(1);
  });
  it("blocks shared email, conflicting name and email, and duplicate source rows", () => {
    expect(match([person("A"), person("B")], [source()]).byKey).toEqual({});
    expect(match([person("A", "aria@example.com", "Another Person"), person("B", "b@example.com")], [source()]).byKey).toEqual({});
    expect(match([person("A")], [source(), source({ sourceRow: 3, terminated: false })]).byKey).toEqual({});
  });
  it("keeps multiple accounts of the same person together", () => {
    const p = person("Ari"); p.accounts.push({ ...p.accounts[0], wiseTeacherId: "online" });
    expect(match([p], [source()]).source.matchedPeople).toBe(1);
  });
  it("does not inherit confirmations from object property names", () => {
    expect(match([person("constructor", "unmatched@example.com", "Unmatched Person")], [source()]).byKey.constructor).toBeUndefined();
    expect(match([person("__proto__")], [source()]).source.matchedPeople).toBe(1);
  });
  it("reports unmatched confirmed names but does not infer termination from unstruck rows", () => {
    const result = match([person("Ari")], [source({ terminated: false }), source({ sourceRow: 3, fullName: "Bodhi Jones", wiseName: "Bodhi Jones", emails: [] })]);
    expect(result.byKey).toEqual({});
    expect(result.source.unmatched.map((r) => r.sourceName)).toEqual(["Bodhi Jones"]);
  });
  it("keeps dated evidence on stale/error feeds and exposes health, never pretends it is fresh", () => {
    expect(match([person("Ari")], [source()], "2026-09-01T00:00:00Z").source.status).toBe("stale");
    const failed = match([person("Ari")], [source()], NOW.toISOString(), "Error (no SQLSTATE)");
    expect(failed.source.status).toBe("error");
    expect(failed.byKey.Ari.checkedAt).toBe(NOW.toISOString());
    expect(match([], [], null).source.status).toBe("not_synced");
  });
});
