import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESUME_TYPES } from "@/lib/hiring/model";
import { CandidateInspector, checkResume, ResumeBody } from "../candidate-inspector";
import { CandidateTable } from "../candidate-table";
import type { HiringCandidate } from "../dashboard";
import { NO_FILTER } from "../dashboard";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const ID = "00000000-0000-4000-8000-000000000001";
const LINK_WARNING = "A link in a résumé can open another site. Do not sign in on a page that opens from a résumé.";
const body = (patch = {}) =>
  renderToStaticMarkup(
    <ResumeBody id={ID} name="Invented" state="available" type={RESUME_TYPES.pdf} months={12} check={{ status: "ready" }} {...patch} />,
  );

afterEach(() => vi.unstubAllGlobals());

describe("ResumeBody", () => {
  it("shows a PDF in an iframe from the guarded route, never a storage address", () => {
    const html = body();
    expect(html).toContain("<iframe");
    expect(html).toContain(`src="/api/hiring/resume/${ID}"`);
    expect(html).not.toContain("blob.vercel");
    expect(html).toContain("Download");
    expect(html).toContain(LINK_WARNING);
  });
  it("shows Download for a Word file, with no iframe and no link warning", () => {
    const html = body({ type: RESUME_TYPES.docx });
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain(LINK_WARNING);
    expect(html).toContain("Download");
    expect(html).toContain(`href="/api/hiring/resume/${ID}"`);
  });
  it("says there is no file yet", () => {
    const html = body({ state: "none" });
    expect(html).toContain("No original file");
    expect(html).not.toContain(LINK_WARNING);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("href=");
  });
  it("the panel shows that the file was deleted", () => {
    const html = body({ state: "deleted" });
    expect(html).toContain("Original résumé deleted after 12 months");
    expect(html).not.toContain("<iframe");
    expect(body({ state: "deleted", months: 1 })).toContain("after 1 month ");
  });
  it("says the file is gone when the route finds nothing, and opens no iframe", () => {
    const html = body({ check: { status: "failed", message: "The original résumé file is gone." } });
    expect(html).toContain("file is gone");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<iframe");
  });
  it("shows a loading line while the route is checked", () => {
    const html = body({ check: { status: "checking" } });
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<iframe");
  });
});

describe("the candidate panel", () => {
  const panel = (extra: Record<string, unknown>, open = false) =>
    renderToStaticMarkup(
      <CandidateInspector
        candidate={
          {
            id: ID,
            name: "Invented",
            email: "invented@example.com",
            stage: "new",
            subjects: [],
            sourceIds: [],
            paperPassedSubjects: [],
            previouslyContacted: false,
            profileScore: null,
            profileAssessment: null,
            preScreen: null,
            preScreenAssessment: null,
            universityAssessment: null,
            ...extra,
          } as unknown as HiringCandidate
        }
        seekJobId="94844236"
        weights={{ degree: 20, subject: 20, curriculum: 20, teaching: 20, english: 20, prestige: 0 }}
        busy={false}
        error=""
        notice=""
        command={async () => true}
        onClose={() => {}}
        resumeOpen={open}
        retentionMonths={12}
      />,
    );
  it("keeps the viewer closed and loads no file until asked", () => {
    const html = panel({ resumeState: "available", resumeType: RESUME_TYPES.pdf });
    expect(html).toContain("Original résumé");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Opening the file");
  });
  it("opens the viewer from the row's Résumé button, with the text still under its own heading", () => {
    const html = panel({ resumeState: "available", resumeType: RESUME_TYPES.pdf }, true);
    expect(html).toMatch(/<details[^>]* open/);
    expect(html).toContain("Opening the file");
    expect(html).toContain("Extracted profile and résumé");
  });
  it("shows No source text only for a person with none, beside a plain review note", () => {
    const note = "Added from the tracker. No SEEK application is linked yet.";
    const none = panel({ hasSourceText: false, reviewNote: note });
    expect(none).toContain("No source text");
    expect(none).toContain(note);
    expect(panel({ hasSourceText: true, reviewNote: note })).not.toContain("No source text");
  });
  it("names a deleted file or a missing file without being opened", () => {
    expect(panel({ resumeState: "deleted" })).toContain("Original résumé (deleted)");
    expect(panel({ resumeState: "none" })).toContain("Original résumé (no file yet)");
    expect(panel({ resumeState: "deleted" }, true)).toContain("Original résumé deleted after 12 months");
  });
});

describe("checkResume", () => {
  const stubFetch = (response: Response | Error) =>
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }));
  it("passes when the route has the file, and drops the body", async () => {
    const cancel = vi.fn();
    stubFetch({ ok: true, body: { cancel } } as unknown as Response);
    expect(await checkResume(`/api/hiring/resume/${ID}`)).toEqual({ status: "ready" });
    expect(cancel).toHaveBeenCalled();
  });
  it("asks for a new sign-in when the route redirects to the login page", async () => {
    const cancel = vi.fn();
    stubFetch({ ok: true, redirected: true, body: { cancel } } as unknown as Response);
    expect(await checkResume(`/api/hiring/resume/${ID}`)).toEqual({ status: "failed", message: "Sign in again to open this file." });
    expect(cancel).toHaveBeenCalled();
  });
  it("gives the route's message when the file is gone", async () => {
    stubFetch(Response.json({ error: "The original résumé file is gone." }, { status: 404 }));
    expect(await checkResume(`/api/hiring/resume/${ID}`)).toEqual({ status: "failed", message: "The original résumé file is gone." });
  });
  it("gives a plain message when the network fails", async () => {
    stubFetch(new Error("network"));
    expect((await checkResume(`/api/hiring/resume/${ID}`)).status).toBe("failed");
  });
});

describe("CandidateTable", () => {
  it("has a Résumé button on the row, which opens the panel with the viewer open", () => {
    const candidate = {
      id: ID,
      name: "Invented Person",
      email: "invented@example.com",
      stage: "new",
      subjects: [],
      profileScore: null,
      preScreenScore: null,
      profileAssessment: null,
      universityAssessment: null,
      previouslyContacted: false,
      workRightsAnswer: null,
      workRightsAccepted: false,
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    } as unknown as HiringCandidate;
    const html = renderToStaticMarkup(
      <CandidateTable
        candidates={[candidate]}
        insights={{ total: 1, ready: 0, byStage: {}, stopped: 0 } as never}
        ready={new Set()}
        extras={new Map()}
        holds={new Map()}
        clashes={new Set()}
        weights={{ prestige: 10 } as never}
        threshold={50}
        filter={NO_FILTER}
        setFilter={() => {}}
        selected={null}
        onSelect={() => {}}
        onOpenResume={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Résumé for Invented Person"');
    expect(html).toContain(">Résumé</button>");
  });
});
