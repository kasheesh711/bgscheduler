import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeSubject, PrintPaper } from "../assessment-screen";

const library = [
  { id: "11111111-1111-4111-8111-111111111111", kind: "question_paper", subject: "Economics", name: "Econs QP.pdf", createdAt: new Date() },
  { id: "22222222-2222-4222-8222-222222222222", kind: "mark_scheme", subject: "Economics", name: "Econs MS.pdf", createdAt: new Date() },
  { id: "33333333-3333-4333-8333-333333333333", kind: "mark_scheme", subject: "Physics", name: "Physics MS.pdf", createdAt: new Date() },
] as never;

describe("PrintPaper", () => {
  const candidateId = "44444444-4444-4444-8444-444444444444";
  it("opens the candidate's print file (cover, then paper) for the day", () => {
    const html = renderToStaticMarkup(<PrintPaper library={library} subject="Economics" candidateId={candidateId} date="2026-11-26" />);
    expect(html).toContain(`href="/api/hiring/print-pack?date=2026-11-26&amp;candidate=${candidateId}"`);
    expect(html).toContain("Print paper");
  });
  it("says so when the library has no question paper for the subject", () => {
    const html = renderToStaticMarkup(<PrintPaper library={library} subject="Physics" candidateId="x" date="2026-11-26" />);
    expect(html).toContain("No paper to print");
    expect(html).not.toContain("href");
  });
});

describe("ChangeSubject", () => {
  const paper = { id: "p", subject: "Economics", updatedAt: new Date() } as never;
  const html = (taken: string[]) => renderToStaticMarkup(<ChangeSubject paper={paper} taken={taken} command={async () => true} reload={async () => undefined} busy={false} />);
  it("offers every other subject, and says it removes the result when the first choice already has one", () => {
    expect(html([])).toContain("Change to Mathematics");
    expect(html([])).not.toContain("<option>Economics</option>");
    expect(html(["Mathematics"])).toContain("Remove this Economics result");
  });
});
