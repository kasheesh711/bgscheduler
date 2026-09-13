import { readFile,mkdir,writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { PDFDocument,StandardFonts } from "pdf-lib";
import { parsePaper,gradeWork,generateReport } from "../src/lib/progress-tests/workspace/ai";
import { validateMarks,type Review } from "../src/lib/progress-tests/workspace/model";
async function pdf(lines:string[]){const d=await PDFDocument.create();const p=d.addPage([595,842]);const font=await d.embedFont(StandardFonts.Helvetica);lines.forEach((l,i)=>p.drawText(l,{x:42,y:780-32*i,size:13,font}));return Buffer.from(await d.save());}
async function main(){
 Object.assign(process.env,parse(await readFile(".env.local")));
 const paperBytes=await pdf(["Technical sample algebra test (not a student record)","Q1. Solve 3x + 4 = 19. [3 marks]","Q2. Expand 2(x + 3). [2 marks]"]);
 const keyBytes=await pdf(["Tutor marking key","Q1: subtract 4 (1), divide by 3 (1), x = 5 (1)","Q2: 2x (1), +6 (1)"]);
 const parsed=await parsePaper([{name:"Sample paper.pdf",bytes:paperBytes},{name:"Sample key.pdf",bytes:keyBytes}]);
 if(parsed.data.questions.length!==2)throw new Error("AI omitted a question");
 const work=await pdf(["Sample responses","Q1: 3x = 15, x = 5","Q2: 2x + 3"]);
 const graded=await gradeWork(parsed.data,{name:"Sample responses.pdf",bytes:work});
 const totals=validateMarks(parsed.data,graded.data.marks);
 if(totals.earned!==4 || totals.possible!==5)throw new Error("Unexpected sample marks; tutor review needed");
 const review:Review={marks:graded.data.marks.map(m=>({...m,needsReview:false})),report:{summary:"",strengths:[],focusAreas:[],nextSteps:[],contextLimitations:""},feedback:[],priorReviewIds:[],model:graded.model,promptVersion:graded.promptVersion,submissionId:"sample",paperVersionId:"sample"};
 const report=await generateReport(parsed.data,review,[],[]);
 if(!report.data.contextLimitations.includes("No verified feedback"))throw new Error("Missing-feedback limitation omitted");
 await mkdir("output/progress-tests-verification",{recursive:true});await writeFile("output/progress-tests-verification/ai-verification.json",JSON.stringify({verifiedAt:new Date(),model:graded.model,totals,parsed,graded,report},null,2),{mode:0o600});
 console.log("Live AI verified: paper/key extraction, rubric partial credit 4/5, separate report and explicit missing-feedback limitation.");
}
main().catch(e=>{console.error(e instanceof Error?e.message:"AI verification failed");process.exitCode=1;});
