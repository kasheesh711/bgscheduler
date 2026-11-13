import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintPaper } from "../assessment-screen";

const library = [
  { id: "11111111-1111-4111-8111-111111111111", kind: "question_paper", subject: "Economics", name: "Econs QP.pdf", createdAt: new Date() },
  { id: "22222222-2222-4222-8222-222222222222", kind: "mark_scheme", subject: "Economics", name: "Econs MS.pdf", createdAt: new Date() },
  { id: "33333333-3333-4333-8333-333333333333", kind: "mark_scheme", subject: "Physics", name: "Physics MS.pdf", createdAt: new Date() },
] as never;

describe("PrintPaper", () => {
  it("links to the question paper of the subject, never the mark scheme", () => {
    const html = renderToStaticMarkup(<PrintPaper library={library} subject="Economics" />);
    expect(html).toContain('href="/api/hiring/file/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("Print paper");
    expect(html).not.toContain("22222222");
  });
  it("says so when the library has no question paper for the subject", () => {
    const html = renderToStaticMarkup(<PrintPaper library={library} subject="Physics" />);
    expect(html).toContain("No paper to print");
    expect(html).not.toContain("href");
  });
});
