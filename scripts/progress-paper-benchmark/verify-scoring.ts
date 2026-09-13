import assert from "node:assert/strict";
import { canonicalMath, hasRenderedPartMarks } from "./score";
import type { Paper } from "../../src/lib/progress-tests/workspace/model";

// Punctuation must not create false failures, while mathematical changes must.
for (const punctuation of [".", ",", ";"]) {
  assert.equal(canonicalMath(`3x+4=19${punctuation}`), canonicalMath("3x+4=19"));
}
assert.equal(canonicalMath("x=1.5."), canonicalMath("x=1.5"));
assert.equal(canonicalMath("\\dfrac{x}{3}"), canonicalMath("\\frac{x}{3}"));
assert.notEqual(canonicalMath("x=1.5"), canonicalMath("x=15"));
assert.notEqual(canonicalMath("\\frac{x}{3}"), canonicalMath("x^3"));
assert.notEqual(canonicalMath("\\frac{x}{3}"), canonicalMath("\\frac{x}{4}"));
assert.notEqual(canonicalMath("3x+4=19"), canonicalMath("3x+4=18"));
assert.notEqual(canonicalMath("\\left( x \\right."), "INVALID");
const question: Paper["questions"][number] = { id: "q24", number: "24", text: "(a) x² (2 marks) (b) x+y (2 marks) (c) xy/z (4 marks)", maxMarks: 8, rubric: "2, 2, 4 marks", topic: "Algebra", sourcePage: 10, needsVisual: false };
assert.equal(hasRenderedPartMarks(question, "a", 2), true);
assert.equal(hasRenderedPartMarks(question, "c", 4), true);
assert.equal(hasRenderedPartMarks(question, "c", 2), false);
assert.equal(hasRenderedPartMarks({ ...question, blocks: [{ kind: "text", text: "(a) x² (b) x+y (c) xy/z" }] }, "a", 2), false);
assert.equal(hasRenderedPartMarks({ ...question, blocks: [{ kind: "math", latex: "\\text{(a)}\\quad x^2\\qquad (2)", display: true }, { kind: "text", text: "(b) x+y (4 marks)" }] }, "a", 2), true);
assert.equal(hasRenderedPartMarks({ ...question, blocks: [{ kind: "text", text: "(a) x² (b) x+y (2 marks)" }] }, "a", 2), false);
console.log("Scorer regression checks passed.");
