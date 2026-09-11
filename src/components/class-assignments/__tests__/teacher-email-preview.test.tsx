import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TeacherEmailPreview } from "../teacher-email-preview";

describe("TeacherEmailPreview", () => {
  it("isolates the exact delivery HTML, with no script or same-origin sandbox privilege", () => {
    const html = '<html><body><h1>A &amp; B</h1></body></html>';
    const output = renderToStaticMarkup(<TeacherEmailPreview subject="Teaching schedule" html={html} text="A & B" />);
    expect(output).toContain('srcDoc="&lt;html&gt;&lt;body&gt;&lt;h1&gt;A &amp;amp; B&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;"');
    expect(output).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(output).not.toContain("allow-scripts");
    expect(output).not.toContain("allow-same-origin");
    expect(output).toContain("Subject: ");
    expect(output).toContain("Plain text");
  });
});
