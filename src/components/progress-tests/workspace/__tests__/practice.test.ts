import {describe,it,expect,vi} from "vitest";
import {createPractice,practiceCommand,practiceDocument} from "../practice-data";
import {commandSchema} from "@/lib/progress-tests/workspace/commands";
describe("isolated guided practice",()=>{
 it("lets tutors change marks and preview them without a network request",()=>{
  const fetch=vi.spyOn(globalThis,"fetch");const state=createPractice(5);const review=state.assessment.reviews[0].data;
  const next=practiceCommand(state,{action:"save-review",id:"demo-assessment",expectedRevision:0,marks:review.marks.map(m=>({...m,marks:0})),report:review.report});
  expect(decodeURIComponent(practiceDocument(next,"demo-graded"))).toContain("0 / 3");expect(state.assessment.reviews[0].data.marks[0].marks).toBe(3);expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
 });
 it("rejects live-only actions and makes sample record IDs invalid on real APIs",()=>{
  expect(()=>practiceCommand(createPractice(),{action:"activate"})).toThrow();
  expect(commandSchema.safeParse({action:"approve",id:"demo-assessment",expectedRevision:0,confirmed:true}).success).toBe(false);
 });
 it("preserves original responses in sample graded previews and escapes supplied prose",()=>{
  const state=createPractice(5);state.assessment.reviews[0].data.report.summary="<script>alert(1)</script>";
  expect(decodeURIComponent(practiceDocument(state,"demo-report"))).toContain("&lt;script&gt;");expect(decodeURIComponent(practiceDocument(state,"demo-graded"))).toContain("2x + 3");
 });
});
