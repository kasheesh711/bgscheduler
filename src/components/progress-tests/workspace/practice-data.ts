import type { AssessmentDetail,Overview,PaperDetail } from "@/lib/progress-tests/workspace/data";
import { emptyReport,validateMarks,type Paper,type Review } from "@/lib/progress-tests/workspace/model";
import type { Command } from "@/lib/progress-tests/workspace/commands";
import type { Serialized } from "./shared";
const date="2026-09-01T08:00:00.000Z";
const paper:Paper={title:"Sample algebra topic test",instructions:"Answer both questions and show your working.",warnings:[],questions:[
  {id:"q1",text:"Solve 3x + 4 = 19.",topic:"Linear equations",maxMarks:3,rubric:"1 for subtracting 4, 1 for dividing by 3, 1 for x = 5.",sourcePage:1,needsVisual:false},
  {id:"q2",text:"Expand 2(x + 3).",topic:"Expanding brackets",maxMarks:2,rubric:"1 for 2x and 1 for +6.",sourcePage:2,needsVisual:false},
]};
const feedback=[{id:"demo-feedback",sessionId:"demo-session-6",date,text:"Topics: solving equations. Performance: explains inverse operations clearly. Improvement: multiply every term when expanding brackets. Homework: five expansion questions."}];
export type PracticeState={overview:Serialized<Overview>;paper:Serialized<PaperDetail>;assessment:Serialized<AssessmentDetail>;notice:string};
export function createPractice(step=0,admin=false):PracticeState {
  const ready=step>=2,submitted=step>=4,reviewed=step>=5,published=step>=7;
  const version={id:"demo-paper-version",paperId:"demo-paper",revision:1,sourceFileId:"demo-source",keyFileId:"demo-key",paper,approved:ready,createdBy:"sample@begifted.test",model:null,createdAt:date};
  const review:Review={marks:paper.questions.map((q,i)=>({questionId:q.id,marks:i===0?3:1,explanation:i===0?"Correct inverse operations and final answer.":"The student multiplied x by 2 but did not multiply 3 by 2.",answerReference:`Sample page ${i+1}, question ${i+1}`,needsReview:!reviewed&&i===1})),report:reviewed?{summary:"Alex solves linear equations confidently and is developing accuracy with brackets.",strengths:["Uses inverse operations clearly"],focusAreas:["Distribute the multiplier to every term"],nextSteps:["Practise five bracket expansions and check by substitution"],contextLimitations:"Sample feedback is provided for this practice exercise."}:emptyReport(),feedback,priorReviewIds:[],model:"Sample — no AI request",promptVersion:"practice-v1",submissionId:"demo-submission",paperVersionId:version.id};
  const series={id:"demo-series",ownerKey:"demo-tutor",wiseClassId:"demo-course",wiseStudentId:"demo-student",studentName:"Alex · sample student",courseName:"Mathematics · sample course",tutorName:"Sample tutor",classType:"ONE_TO_ONE",count:step>=3?8:6,sessionIds:Array.from({length:8},(_,i)=>`demo-session-${i+1}`),upcomingSessions:[],updatedAt:date};
  const assessment={id:"demo-assessment",seriesId:series.id,cycle:1,revision:0,preparation:{paperVersionId:ready?version.id:null,topics:ready?"Linear equations and expanding brackets":"",studentInformed:step>=3},notifiedAt:date,notificationError:null,currentSubmissionId:submitted?"demo-submission":null,currentReviewId:submitted?"demo-review":null,approvedReviewId:published?"demo-review":null,publicationStatus:published?"published":"not_ready",publicationError:null,updatedAt:date,series,stage:published?"approved":submitted?"tutor_review":step>=3?"awaiting_submission":ready?"ready":"prepare",position:series.count,nextAction:"Prepare test and inform student",dueClass:8,discussionClass:7,overdue:false,
    submissions:submitted?[{id:"demo-submission",assessmentId:"demo-assessment",data:{fileIds:["demo-work"],sessionId:"demo-session-8",submittedAt:date,pageOrder:[{fileId:"demo-work",page:1},{fileId:"demo-work",page:2}]},createdBy:"sample@begifted.test",createdAt:date}]:[],
    reviews:submitted?[{id:"demo-review",assessmentId:"demo-assessment",data:review,approved:published,createdBy:"sample@begifted.test",createdAt:date}]:[],
    sessions:series.sessionIds.map((id,i)=>({id,date,ordinal:i+1})),feedback,versions:[{version:{...version,approved:true},title:paper.title}],artifacts:step>=6?[{id:"demo-graded-artifact",reviewId:"demo-review",kind:"graded",fileId:"demo-graded"},{id:"demo-report-artifact",reviewId:"demo-review",kind:"report",fileId:"demo-report"}]:[],publications:published?[{id:"demo-publication",reviewId:"demo-review",version:1,status:"published",sectionId:"demo-section",remoteIds:["demo-graded","demo-report"],error:null,createdAt:date,updatedAt:date}]:[],publicationFiles:published?(["graded","report"] as const).map(kind=>({id:`demo-file-${kind}`,publicationId:"demo-publication",kind,fileId:`demo-${kind}`,name:`Sample ${kind}.pdf`,sha256:"sample",status:"verified",resourceId:`demo-${kind}`,wiseFileId:`demo-${kind}`,attempts:1,error:null,verifiedAt:date,updatedAt:date})):[],
  } as Serialized<AssessmentDetail>;
  const paperDetail={id:"demo-paper",ownerKey:"demo-tutor",title:paper.title,revision:1,createdAt:date,versions:[version]};
  const overview={user:{email:"sample@begifted.test",name:"Sample tutor",role:admin?"admin":"teacher"},activatedAt:date,publication:{ready:true,configured:true,paused:false,revision:0,missing:[],reason:"Practice publication"},capabilities:{uploads:true,ai:true},assessments:[assessment],papers:[paperDetail],jobs:[],tutors:[{key:"demo-tutor",name:"Sample tutor"}],unresolved:[],sourceIssues:[],legacy:[]} as Serialized<Overview>;
  return {overview,paper:paperDetail,assessment,notice:""};
}
export function practiceCommand(state:PracticeState,c:Command):PracticeState {
  const n=structuredClone(state);const a=n.assessment;n.notice="Practice saved. No real records were changed.";
  switch(c.action){
    case "save-paper":n.paper.revision++;n.paper.title=c.paper.title;n.paper.versions=[{...n.paper.versions[0],revision:n.paper.revision,paper:c.paper,sourceFileId:c.sourceFileId,keyFileId:c.keyFileId,approved:c.approved}];break;
    case "process-paper":n.paper.revision++;n.paper.versions[0].revision=n.paper.revision;n.notice="Sample formatted questions are ready for review.";break;
    case "preview-paper":n.overview.jobs=[{id:"demo-job",kind:"render-paper",targetId:n.paper.id,expectedRevision:n.paper.revision,status:"completed",error:null,result:{fileId:"demo-paper-pdf"},createdAt:date}];break;
    case "prepare":a.preparation={paperVersionId:c.paperVersionId,topics:c.topics,studentInformed:c.studentInformed};a.stage="ready";a.revision++;break;
    case "submit":a.currentSubmissionId="demo-submission";a.submissions=createPractice(4).assessment.submissions;a.stage="tutor_review";a.revision++;break;
    case "grade":a.reviews=createPractice(4).assessment.reviews;a.currentReviewId="demo-review";a.revision++;n.notice="Sample grading is ready. Review the flagged second answer.";break;
    case "save-review":validateMarks(paper,c.marks);a.reviews=[{...createPractice(4).assessment.reviews[0],data:{...createPractice(4).assessment.reviews[0].data,marks:c.marks,report:c.report}}];a.currentReviewId="demo-review";a.revision++;break;
    case "report":a.reviews[0].data.report=createPractice(5).assessment.reviews[0].data.report;a.revision++;break;
    case "preview-review":a.artifacts=createPractice(6).assessment.artifacts;break;
    case "approve":validateMarks(paper,a.reviews[0].data.marks,true);a.reviews[0].approved=true;a.approvedReviewId=a.currentReviewId;a.publicationStatus="published";a.publications=createPractice(7).assessment.publications;a.publicationFiles=createPractice(7).assessment.publicationFiles;a.stage="approved";a.revision++;n.notice="Practice complete: both sample PDFs are shown as published. Nothing was uploaded to Wise.";break;
    case "publish":n.notice="Sample publication reconciled. Nothing was uploaded to Wise.";break;
    default:throw new Error("This operation is unavailable in practice mode.");
  }
  return n;
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function practiceDocument(state:PracticeState,id:string){
  const review=state.assessment.reviews[0]?.data;
  const body=id.includes("work")?"<h2>Sample handwritten responses — transcribed for practice</h2><p>Page 1: 3x + 4 = 19 → 3x = 15 → x = 5.</p><p>Page 2: 2(x + 3) = 2x + 3.</p>":id.includes("report")?`<h2>Progress report</h2><p>${escape(review?.report.summary||"Sample report preview")}</p><h3>Next steps</h3><p>${escape(review?.report.nextSteps.join(" · ")||"")}</p>`:`<h2>${escape(state.paper.versions[0].paper.title)}</h2>${state.paper.versions[0].paper.questions.map((q,i)=>`<section><h3>Question ${i+1} · ${q.maxMarks} marks</h3><p>${escape(q.text)}</p>${id.includes("graded")?`<p>Sample response: ${i===0?"3x = 15; x = 5":"2x + 3"}</p><p>${review?.marks[i]?.marks??0} / ${q.maxMarks} · ${escape(review?.marks[i]?.explanation??"")}</p>`:id.includes("key")?`<p>${escape(q.rubric)}</p>`:""}</section>`).join("")}`;
  return "data:text/html;charset=utf-8,"+encodeURIComponent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sample document preview</title><style>body{margin:0;background:#eef1f6;color:#16203a;font:16px/1.65 system-ui}main{background:white;max-width:650px;margin:20px auto;padding:38px}header{border-bottom:4px solid #ff7518;padding-bottom:12px;color:#126dce}section{border-top:1px solid #dde2e9;margin-top:24px}small{color:#5a6678}</style><main><header><strong>BeGifted · Practice — sample data</strong></header>${body}<footer><small>Practice preview only. No student records or real files are used.</small></footer></main></html>`);
}
