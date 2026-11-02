import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { baseConfigSchema, configSchema, type HiringConfig } from "@/lib/hiring/model";
import type { HeadDayState } from "@/lib/hiring/rules";
import type { LimitUsage } from "@/lib/hiring/limits";
import type { Week } from "@/lib/tutor-attendance/model";
import type { HiringData } from "../dashboard";
import { OperationsRail, WorkerBanner } from "../operations-rail";
import { LimitMeters } from "../pipeline-charts";
import { SetupPanel } from "../setup-panel";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const win = { start: "10:00", end: "16:00" };
const MON_FRI: Week = [null, win, win, win, win, win, null];
const RESIDENT = "I am a long term / permanent resident with eligibility for a work permit";
const peat = { canonicalKey: "Peat", email: "peat@example.com", subjects: ["Mathematics" as const, "Physics" as const] };
const gift = { canonicalKey: "Gift", email: "gift@example.com", subjects: ["Biology" as const] };
const make = (extra: Record<string, unknown> = {}): HiringConfig =>
  configSchema.parse({ interviewers: [peat, gift], seenWorkRights: [RESIDENT], ...extra });
const heads: Record<string, HeadDayState> = {
  Peat: { state: "enrolled", week: MON_FRI, from: "2026-09-01" },
  Gift: { state: "fallback", week: null, from: null },
};
const usage = (extra: Partial<LimitUsage> = {}): LimitUsage => ({
  perDay: 0,
  perWeek: 0,
  waiting: 0,
  unbooked: 0,
  bySubject: {},
  ...extra,
});
const tutors = [
  { canonicalKey: "Peat", name: "Peat", email: "peat@example.com", lineReady: true },
  { canonicalKey: "Gift", name: "Gift", email: "gift@example.com", lineReady: true },
];
const dataFor = (config: HiringConfig, extra: Record<string, unknown> = {}) =>
  ({
    config,
    revision: 4,
    workerAt: null,
    workerSummary: null,
    workerError: null,
    writeGate: true,
    candidates: [],
    bookings: [],
    outbox: [],
    audit: [],
    tutors,
    heads,
    holds: {},
    headMocks: { Peat: 1 },
    usage: { preScreen: usage(), onsite: usage() },
    configProblems: [],
    visitClashes: { candidateIds: [], stale: false },
    library: [],
    markingSpend: { usd: 0, complete: true },
    google: { connected: true, email: "x@example.com", lastError: null },
    ...extra,
  }) as unknown as HiringData;
const panel = (
  config: HiringConfig,
  extra: Record<string, unknown> = {},
  saved = config,
  more: { dayDrafts?: Record<string, boolean[]>; error?: string; notice?: string } = {},
) =>
  renderToStaticMarkup(
    <SetupPanel
      data={dataFor(saved, extra)}
      config={config}
      revision={4}
      setConfig={() => {}}
      busy={false}
      connect={() => {}}
      command={async () => true}
      dayDrafts={more.dayDrafts ?? {}}
      setDayDrafts={() => {}}
      error={more.error ?? ""}
      notice={more.notice ?? ""}
    />,
  );
const value = (html: string, label: string) =>
  new RegExp(`${label}[^<]*<input[^>]*value="([^"]*)"`).exec(html)?.[1];

// These tests render markup. They do not click: the repo has no DOM testing library, so the click paths
// (typing a number, the Up and Down buttons, a tick box, Save days) are covered through the pure helpers in
// rules.test.ts and the server tests, not by an event.
describe("Rules and setup", () => {
  it("shows each limit with its current value, and the save button", () => {
    const config = make({
      preScreenLimits: { perDay: 6, perWeek: 16, waiting: 17, perSubject: 4 },
      onsiteLimits: { perWeek: 5, unbooked: 3, perHeadPerWeek: 4, perSubject: 3 },
      preScreenFollowUp: { remindDays: 2, expireDays: 8 },
      onsiteFollowUp: { remindDays: 4, expireDays: 9 },
      preScreenThreshold: 55,
    });
    const html = panel(config);
    const pre = html.slice(html.indexOf("Pre-screen email rules"), html.indexOf("Onsite invitation rules"));
    const onsite = html.slice(html.indexOf("Onsite invitation rules"), html.indexOf("Pre-screen score weights"));
    expect([
      value(pre, "Maximum sent each day"),
      value(pre, "Maximum sent each week"),
      value(pre, "Maximum waiting for reply"),
      value(pre, "Maximum open per subject"),
      value(pre, "Send reminder after \\(days\\)"),
      value(pre, "Mark no reply after \\(days\\)"),
    ]).toEqual(["6", "16", "17", "4", "2", "8"]);
    expect([
      value(onsite, "Pre-screen pass score"),
      value(onsite, "Maximum invited each week"),
      value(onsite, "Maximum invited, not booked"),
      value(onsite, "Maximum mocks per head each week"),
      value(onsite, "Maximum open per subject"),
      value(onsite, "Send reminder after \\(days\\)"),
      value(onsite, "Expire the link after \\(days\\)"),
    ]).toEqual(["55", "5", "3", "4", "3", "4", "9"]);
    expect(html).toContain("Save rules and setup");
    expect(html).toMatch(/<button[^>]*class="[^"]*primary[^"]*"(?![^>]*disabled)/);
  });

  it("explains that a cancel or no-show frees the open places but not the weekly count", () => {
    const html = panel(make());
    expect(html).toContain(
      "Cancel and no-show free the open places. They do not free the weekly count, because the email has already gone. To send more this week, raise the number.",
    );
    expect(html).toContain("The booking link lasts 30 days");
  });

  it("refuses to save when pre-screen weights do not total 100", () => {
    const config = make();
    const bad = { ...config, preScreenWeights: { ...config.preScreenWeights, degree: 11 } };
    const html = panel(bad);
    expect(html).toContain("Total 101 of 100");
    expect(html).toContain("Pre-screen weights total 101");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save rules and setup/);
    expect(panel(config)).toContain("Total 100 of 100");
  });

  it("refuses to save a rule the server would refuse, and says why", () => {
    const html = panel({ ...make(), visitStartMinute: 900, visitEndMinute: 600 });
    expect(html).toContain("Visits must end after they start.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save rules and setup/);
  });

  it("shows a stored rule problem the server found, so Kevin can repair it", () => {
    const html = panel(make(), { configProblems: ["The reminder must come before the link ends."] });
    expect(html).toContain("The saved rules have a problem");
    expect(html).toContain("The reminder must come before the link ends.");
  });

  it("lists subjects in priority order, with Up and Down, and a not-hiring subject unticked", () => {
    const config = make({
      subjectPriority: [
        { subject: "Physics", hiring: true },
        { subject: "Mathematics", hiring: false },
      ],
    });
    const html = panel(config);
    const list = html.slice(html.indexOf("Subject priority"));
    expect(list.indexOf("Physics")).toBeLessThan(list.indexOf("Mathematics"));
    expect(list).toContain('aria-label="Move Physics up"');
    expect(list).toContain('aria-label="Move Mathematics down"');
    // The top row cannot go up.
    expect(list).toMatch(/aria-label="Move Physics up"[^>]*disabled|disabled[^>]*aria-label="Move Physics up"/);
    expect(list).toMatch(/<input[^>]*checked[^>]*aria-label="Hiring Physics"|<input[^>]*aria-label="Hiring Physics"[^>]*checked/);
    const maths = /<input[^>]*aria-label="Hiring Mathematics"[^>]*>/.exec(list)![0];
    expect(maths).not.toContain("checked");
    // Subjects missing from the list show at the end as not hiring.
    expect(list).toContain("Hiring Biology");
  });

  it("lists a new SEEK work-rights answer unticked, and the accepted one ticked", () => {
    const html = panel(make());
    const rights = html.slice(html.indexOf("Accepted SEEK work-rights answers"), html.indexOf("Subject priority"));
    const accepted = /<input[^>]*>\s*<span>I have permanent work rights with no restrictions/.exec(rights)![0];
    expect(accepted).toContain("checked");
    const resident = /<input[^>]*>\s*<span>I am a long term/.exec(rights)![0];
    expect(resident).not.toContain("checked");
    expect(rights).toContain("A new answer from SEEK appears here, not accepted, until you tick it.");
  });

  it("shows the empty pass score as a blocker for automatic invitations, not for the form", () => {
    const empty = panel(make());
    const onsite = empty.slice(empty.indexOf("Onsite invitation rules"), empty.indexOf("Pre-screen score weights"));
    const pre = empty.slice(empty.indexOf("Pre-screen email rules"), empty.indexOf("Onsite invitation rules"));
    expect(onsite).toContain("No pass score is set. Automatic onsite invitations cannot run until you set one.");
    expect(pre).not.toContain("No pass score");
    expect(pre).toContain("The pre-screen form is not affected.");
    const set = panel(make({ preScreenThreshold: 60 }));
    expect(set).not.toContain("No pass score is set");
  });

  it("shows the hard stops as fixed and the weights as editable", () => {
    const html = panel(make());
    expect(html).toContain("Completed bachelor");
    expect(html).toContain("A weekend day and a weekday after 15:00");
    const weights = html.slice(html.indexOf("Pre-screen score weights"), html.indexOf("Hard stops"));
    expect(value(weights, "University prestige")).toBe("10");
    expect(value(weights, "Written answers")).toBe("15");
  });

  it("shows head days with a visible Tutor Attendance warning, and the enrolled head marked", () => {
    const html = panel(make());
    const section = html.slice(html.indexOf("Head office days"));
    expect(section).toContain("This also changes Tutor Attendance.");
    expect(section).toContain("Peat");
    expect(section).toContain("Tutor Attendance schedule");
    expect(section).toContain("Hiring settings only");
    // Peat has Monday to Friday ticked.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) expect(section).toContain(`aria-label="Peat ${day}"`);
    expect(section.match(/aria-label="Peat \w{3}"[^>]*checked|checked[^>]*aria-label="Peat \w{3}"/g)).toHaveLength(5);
  });

  it("warns for a head with no saved hours, and not for one with hours", () => {
    const html = panel(make());
    const section = html.slice(html.indexOf("Head office days"));
    expect(section.match(/No saved hours: this head gets no visit times\./g)).toHaveLength(1);
    expect(section.indexOf("No saved hours")).toBeGreaterThan(section.indexOf("Gift"));
    expect(section.slice(0, section.indexOf("Gift"))).not.toContain("No saved hours");
  });

  it("says an ended attendance enrolment cannot be changed here", () => {
    const html = panel(make(), { heads: { ...heads, Peat: { state: "ended", week: MON_FRI, from: "2026-09-01" } } });
    expect(html).toContain("Tutor Attendance enrollment has ended");
  });

  it("shows when a saved change starts", () => {
    const html = panel(make(), { heads: { ...heads, Peat: { state: "enrolled", week: MON_FRI, from: "2999-01-01" } } });
    expect(html).toContain("starts 1 Jan 2999");
  });

  it("says plainly that switching on Automation or Messages starts sending, only when it is a new switch-on", () => {
    const saved = make();
    const draft = { ...saved, enabled: true, deliveryEnabled: true };
    const html = panel({ ...draft, preScreenThreshold: 60 }, {}, saved);
    expect(html).toContain("Saving starts sending");
    expect(html).toContain("5 pre-screen forms a day");
    expect(html).toContain("Save and start sending");
    const calm = panel(saved);
    expect(calm).not.toContain("Saving starts sending");
    expect(calm).toContain("Save rules and setup");
    // Already on: no notice.
    expect(panel(draft, {}, draft)).not.toContain("Saving starts sending");
  });

  it("shows a repairable list when the saved priority has a subject twice", () => {
    // A stored config loads without the cross-field rules, so the panel can get one like this.
    const config = baseConfigSchema.parse({
      interviewers: [peat, gift],
      subjectPriority: [
        { subject: "Physics", hiring: true },
        { subject: "Mathematics", hiring: true },
        { subject: "Physics", hiring: false },
      ],
    });
    const html = panel(config);
    expect(html.match(/aria-label="Hiring Physics"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Hiring Mathematics"/g)).toHaveLength(1);
  });

  it("names the heads whose days are not saved in the sticky bar, and shows nothing when all are saved", () => {
    const html = panel(make(), {}, make(), { dayDrafts: { Peat: [true, false, true, true, true], Gift: [true, true, true, true, true] } });
    const bar = html.slice(0, html.indexOf("Screening rules"));
    expect(bar).toContain("Head days not saved: Gift, Peat");
    expect(bar).toMatch(/role="alert"|role="status"/);
    expect(panel(make())).not.toContain("Head days not saved");
    // A tick set back to the saved value is not unsaved.
    expect(panel(make(), {}, make(), { dayDrafts: { Peat: [true, true, true, true, true] } })).not.toContain("Head days not saved");
  });

  it("shows the saved and error messages in the sticky bar, at every width", () => {
    const html = panel(make(), {}, make(), { notice: "Saved.", error: "Settings changed. Refresh this page." });
    const bar = html.slice(0, html.indexOf("Screening rules"));
    expect(bar).toMatch(/role="status"[^>]*>Saved\./);
    expect(bar).toMatch(/role="alert"[^>]*>Settings changed\. Refresh this page\./);
    const quiet = panel(make()).slice(0, html.indexOf("Screening rules"));
    expect(quiet).not.toContain("Saved.");
  });

  it("does not say Saving starts sending when only one switch is on, and does not promise onsite invitations without a pass score", () => {
    const saved = make();
    const oneOn = panel({ ...saved, enabled: true }, {}, saved);
    expect(oneOn).not.toContain("Saving starts sending");
    expect(oneOn).toContain("Messages is off, so nothing is sent yet.");
    expect(oneOn).toContain("Save and start sending");
    const noScore = panel({ ...saved, enabled: true, deliveryEnabled: true }, {}, saved);
    expect(noScore).toContain("Saving starts sending");
    expect(noScore).not.toContain("onsite invitations a week.");
    expect(noScore).toContain("No onsite invitation is sent until you set a pass score.");
  });

  it("keeps the existing sections", () => {
    const html = panel(make());
    for (const text of ["Screening rules", "Automation", "Connections", "Mock interviewers", "University prestige rules and reference data"])
      expect(html).toContain(text);
  });

  it("describes the profile gate as the code applies it", () => {
    const html = panel(make());
    expect(html).toContain("waits at New");
    expect(html).toContain("no supported subject, no email or earlier contact go to review");
    expect(html).not.toContain("must meet the rule");
  });
});

describe("LimitMeters", () => {
  it("renders limit meters from dashboard usage, with a full one marked", () => {
    const config = make();
    const html = renderToStaticMarkup(
      <LimitMeters
        config={config}
        tutors={tutors}
        headMocks={{ Peat: 2 }}
        usage={{
          preScreen: usage({ perDay: 5, perWeek: 12, waiting: 9, bySubject: { Mathematics: 2 } }),
          onsite: usage({ perWeek: 2, unbooked: 1, bySubject: { Mathematics: 1 } }),
        }}
      />,
    );
    expect(html).toContain("Pre-screen emails");
    expect(html).toContain("Onsite invitations");
    for (const label of ["Sent today", "Sent this week", "Waiting for reply", "Mathematics open", "Invited this week", "Not booked", "Peat this week"])
      expect(html).toContain(label);
    expect(html).toMatch(/Sent today[\s\S]*?>5<[\s\S]*?of 5</);
    expect(html).toMatch(/Peat this week[\s\S]*?>2<[\s\S]*?of 2</);
    // A full meter says so in words, not only in colour.
    expect(html.match(/data-full="true"/g)).toHaveLength(2);
    expect(html.match(/>Full</g)).toHaveLength(2);
    expect(html).toMatch(/style="width:100%"/);
  });

  it("reads Over by N, not 17 of 12, when use is above a lowered limit, and still shows Full", () => {
    const config = make({ preScreenLimits: { perDay: 12, perWeek: 15, waiting: 15, perSubject: 3 } });
    const html = renderToStaticMarkup(
      <LimitMeters
        config={config}
        tutors={tutors}
        headMocks={{}}
        usage={{ preScreen: usage({ perDay: 17 }), onsite: usage() }}
      />,
    );
    expect(html).toContain("Over by 5");
    expect(html).not.toMatch(/>17</);
    expect(html).not.toContain("of 12");
    expect(html.match(/>Full</g)).toHaveLength(1);
    // At the limit exactly it still reads as a count.
    const at = renderToStaticMarkup(
      <LimitMeters config={config} tutors={tutors} headMocks={{}} usage={{ preScreen: usage({ perDay: 12 }), onsite: usage() }} />,
    );
    expect(at).not.toContain("Over by");
    expect(at).toMatch(/Sent today[\s\S]*?>12<[\s\S]*?of 12</);
  });

  it("says automatic onsite invitations are blocked with no pass score, and paused when switches are off", () => {
    const blocked = renderToStaticMarkup(
      <LimitMeters config={make()} tutors={tutors} headMocks={{}} usage={{ preScreen: usage(), onsite: usage() }} />,
    );
    expect(blocked).toContain("No pass score: automatic onsite invitations cannot run.");
    expect(blocked).toContain("Automation or messages are paused, so nothing is sent.");
    const ready = renderToStaticMarkup(
      <LimitMeters
        config={make({ preScreenThreshold: 60, enabled: true, deliveryEnabled: true })}
        tutors={tutors}
        headMocks={{}}
        usage={{ preScreen: usage(), onsite: usage() }}
      />,
    );
    expect(ready).not.toContain("No pass score");
    expect(ready).not.toContain("are paused");
  });
});

describe("worker warning", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  const banner = (enabled: boolean, workerAt: string | null) =>
    renderToStaticMarkup(<WorkerBanner enabled={enabled} workerAt={workerAt} now={now} />);
  it("warns when automation is on and the last worker run is over 60 minutes old", () => {
    const html = banner(true, "2026-11-02T06:00:00.000Z");
    expect(html).toContain("Automation is on, but the worker last ran 4 hours ago");
    expect(html).toContain('role="alert"');
    expect(banner(true, null)).toContain("has not run yet");
  });
  it("is quiet for a recent run or when automation is paused", () => {
    expect(banner(true, "2026-11-02T09:30:00.000Z")).toBe("");
    expect(banner(false, "2026-10-01T00:00:00.000Z")).toBe("");
  });
  it("marks the last worker run in the rail when it is late, so the number is not read as fine", () => {
    const rail = (enabled: boolean, workerAt: string) =>
      renderToStaticMarkup(
        <OperationsRail
          data={dataFor(make({ enabled }), { workerAt })}
          insights={{ messages: { sent: 0, waiting: 0, problems: 0 }, upcomingByInterviewer: { Peat: 0, Gift: 0 } } as never}
          busy={false}
          connect={() => {}}
          onSelect={() => {}}
          now={now}
        />,
      );
    expect(rail(true, "2026-11-02T06:00:00.000Z")).toMatch(/Last worker run<\/span><span class="[^"]*warnWord[^"]*">/);
    expect(rail(true, "2026-11-02T09:30:00.000Z")).not.toMatch(/Last worker run<\/span><span class="[^"]*warnWord/);
    expect(rail(false, "2026-10-01T00:00:00.000Z")).not.toMatch(/Last worker run<\/span><span class="[^"]*warnWord/);
  });
  it("shows failed résumé uploads and candidates with no stored file, by count only", () => {
    const rail = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(
        <OperationsRail
          data={dataFor(make(), extra)}
          insights={{ messages: { sent: 0, waiting: 0, problems: 0 }, upcomingByInterviewer: { Peat: 0, Gift: 0 } } as never}
          busy={false}
          connect={() => {}}
          onSelect={() => {}}
          now={now}
        />,
      );
    const summary = (resumeUploadsFailed?: number) => ({ workerSummary: { scanned: 1, imported: 0, remaining: 0, folders: [], resumeUploadsFailed } });
    expect(rail(summary(3))).toContain("3 résumé uploads failed");
    expect(rail(summary(1))).toContain("1 résumé upload failed");
    // A clean run, and a summary saved before this field existed.
    expect(rail(summary(0))).not.toContain("failed");
    expect(rail(summary())).not.toContain("failed");
    const candidates = [
      { id: "a", name: "Hidden Person", resumeState: "none" },
      { id: "b", name: "Other Person", resumeState: "none" },
      { id: "c", name: "Stored Person", resumeState: "available" },
      { id: "d", name: "Deleted Person", resumeState: "deleted" },
    ];
    const html = rail({ candidates });
    expect(html).toContain("2 with no file");
    expect(html).not.toContain("Hidden Person");
    expect(rail({ candidates: candidates.slice(2) })).toContain("All stored");
  });
});
describe("résumé retention setting", () => {
  it("warns beside the field that a lower number can delete many files for good", () => {
    expect(panel(make())).toContain(
      "Files past this age are deleted for good at the next nightly run. Lowering this number can delete many files.",
    );
  });
});
