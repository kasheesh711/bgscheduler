import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";
import { convertDocx, renderPaper, renderReview } from "../src/lib/progress-tests/workspace/documents";
import type { Paper, Review } from "../src/lib/progress-tests/workspace/model";

async function main() {
  const output="output/progress-tests-verification";
  await mkdir(output,{recursive:true});
  const source=await PDFDocument.create();const font=await source.embedFont(StandardFonts.Helvetica);
  const page=source.addPage([595.28,841.89]);page.drawText("Original diagram and student responses",{x:40,y:780,size:18,font});
  page.drawCircle({x:290,y:540,size:100,borderWidth:2,borderColor:rgb(.07,.43,.8),color:rgb(.94,.97,1)});
  page.drawLine({start:{x:190,y:540},end:{x:390,y:540},thickness:2,color:rgb(.1,.13,.22)});
  page.drawText("diameter = 10 cm",{x:230,y:565,size:14,font});
  page.drawText("Student response: radius = 5 cm; area = 25 pi cm squared",{x:40,y:320,size:13,font});
  page.drawText("RESPONSE END — all source content retained",{x:40,y:40,size:12,font});
  const original=Buffer.from(await source.save());
  const paper:Paper={title:"Mathematics · Progress Test",instructions:"Answer every question. Show your working. You may use a calculator. อ่านคำสั่งและแสดงวิธีทำ",warnings:[],questions:Array.from({length:12},(_,i)=>({id:`q${i+1}`,text:i===0?"Using the original circle diagram, find its radius and calculate its area. ให้แสดงวิธีทำ":"Explain your method clearly, include units, and check the reasonableness of your answer. ".repeat(i===5?14:2),topic:i===0?"Circle geometry":"Mathematical reasoning",maxMarks:4,rubric:"Award 1 for identifying a suitable method, 2 for correct working and 1 for the final answer including units.",sourcePage:i===0?1:null,needsVisual:i===0}))};
  const review:Review={marks:paper.questions.map((q,i)=>({questionId:q.id,marks:i%2?3:4,explanation:"The method is appropriate and the main steps are correct. Check the final units before completing the answer.",answerReference:`Response page 1, answer ${i+1}`,needsReview:false})),report:{summary:"The student shows a sound understanding of the assessed topics and can explain the steps used to solve familiar problems. Their progress is strongest when they write down intermediate calculations. This review focuses on the evidence available in the submitted test.",strengths:["Selects an appropriate strategy for familiar geometry questions.","Uses intermediate steps to make mathematical reasoning clear."],focusAreas:["Check units and the final form of each answer.","Build confidence with unfamiliar multi-step problems."],nextSteps:["Practise three mixed geometry problems per lesson and explain the choice of method.","Use a final-check routine: method, calculation, units and reasonableness."],contextLimitations:"No verified class-feedback records were available for this fixture. Recommendations are limited to the reviewed test evidence."},feedback:[],priorReviewIds:[],model:null,promptVersion:"manual-fixture",submissionId:"fixture",paperVersionId:"fixture"};
  await writeFile(`${output}/source.pdf`,original);
  await writeFile(`${output}/blank-paper.pdf`,await renderPaper(paper,original));
  const reviewed=await renderReview(paper,review,"Sample Student นักเรียน","Year 9 Mathematics","Sample Tutor",1,[original],original);
  await writeFile(`${output}/graded-test.pdf`,reviewed.graded);await writeFile(`${output}/progress-report.pdf`,reviewed.report);
  const zip=new JSZip();zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Visual DOCX conversion — Test paper</w:t></w:r></w:p><w:p><w:r><w:t>Question 1. Explain how you would simplify the fraction 2/4.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Question 2. SOURCE DOCUMENT END.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/></w:sectPr></w:body></w:document>');
  const docx=await zip.generateAsync({type:"nodebuffer"});await writeFile(`${output}/typed-paper.docx`,docx);
  const converted=await convertDocx(docx);
  assert.equal((await PDFDocument.load(converted)).getPageCount(),2,"An explicit two-page DOCX must retain both pages without a trailing blank page");
  await writeFile(`${output}/docx-visual.pdf`,converted);
  console.log(`Document fixtures generated in ${output}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
