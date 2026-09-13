"use client";
import { useEffect,useRef,useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft,ArrowRight,BookOpen,CheckCheck,HelpCircle,X } from "lucide-react";
import { API,Button,readApi,WorkspaceTransportContext } from "./shared";
import { PaperEditor } from "./paper-editor";
import { AssessmentEditor } from "./assessment-editor";
import { createPractice,practiceCommand,practiceDocument,type PracticeState } from "./practice-data";
import css from "./workspace.module.css";

type Progress={guideVersion:number;status:"new"|"started"|"skipped"|"completed";step:number;revision:number};
const steps=[
  {title:"Know when to prepare",text:"After six completed classes, your reminder arrives. Discuss the topics in class 7 and give your test within class 8. Every student, course and tutor has a separate counter."},
  {title:"Prepare your paper and rubric",text:"Try the sample paper and marking key. Format or edit the questions, save your draft, build its preview and mark the reviewed version ready. The marking key stays private."},
  {title:"Tell the student what to revise",text:"Choose your reviewed paper, edit the topic list and confirm that you informed the student. Save preparation after the class-7 discussion."},
  {title:"Submit the completed work",text:"Select the actual class, add the sample student work and try reordering its pages. Every page is retained. A late class-9 test leaves the next test due in class 16."},
  {title:"Check the marks",text:"Try changing a mark and its explanation. Compare the second answer with the rubric, clear the review flag after checking it, and save reviewed marks. You make the final grading decision."},
  {title:"Explain the student's progress",text:"Draft and edit the sample report. The same tutor's class feedback adds context and recommendations, but does not change the numerical marks. Missing feedback is stated explicitly."},
  {title:"Preview, approve and publish",text:"Open both previews and confirm you have reviewed every page. Try Approve and publish. In the real workspace this adds two native PDFs to Wise Content → Progress Tests; sources and keys stay private."},
  {title:"Find results and corrections",text:"History keeps approved documents, earlier versions and their publication status. Corrections create a new reviewed version. If Wise is slow, the job continues after you leave."},
  {title:"Admin oversight",text:"Filter by tutor to review overdue work, unresolved identities and publication failures. Pause publishing when needed; counters, drafts and approvals continue to be preserved."},
];
export function PracticeGuide({admin,theme}:{admin:boolean;theme:string}) {
  const [progress,setProgress]=useState<Progress|null>(null);
  const [open,setOpen]=useState(false);const [practising,setPractising]=useState(false);
  const [step,setStep]=useState(0);const [error,setError]=useState("");const [saving,setSaving]=useState(false);
  const [sample,setSample]=useState<PracticeState>(()=>createPractice());const sampleRef=useRef(sample);sampleRef.current=sample;
  const [paused,setPaused]=useState(false);
  useEffect(()=>{let active=true;readApi<Progress>(`${API}/guide`).then(p=>{if(active){setProgress(p);setStep(p.step);setOpen(p.status==="new");}}).catch(()=>undefined);return()=>{active=false;};},[]);
  const persist=async(status:Progress["status"],at:number)=>{
    setSaving(true);
    try {
      const current=progress??await readApi<Progress>(`${API}/guide`);
      const saved=await readApi<Progress>(`${API}/guide`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,step:at,expectedRevision:current.revision})});setProgress(saved);
    }catch{setError("Your guide position could not be saved. You can continue practising or reopen Help later.");const p=await readApi<Progress>(`${API}/guide`).catch(()=>null);if(p)setProgress(p);}
    finally{setSaving(false);}
  };
  const start=(from:number)=>{setStep(from);setSample(createPractice(from,admin));setPractising(true);setError("");void persist("started",from);};
  const move=(next:number)=>{
    const baseline=createPractice(next,admin);const previous=sampleRef.current;
    // Keep edits during this visit; only initialize the stage being demonstrated.
    baseline.paper=previous.paper;
    if(previous.assessment.preparation.topics)baseline.assessment.preparation=previous.assessment.preparation;
    if(next>=4 && previous.assessment.currentSubmissionId)baseline.assessment.submissions=previous.assessment.submissions;
    if(next>=5 && previous.assessment.reviews.length && !previous.assessment.reviews[0].data.marks.some(m=>m.needsReview)){
      baseline.assessment.reviews[0].data.marks=previous.assessment.reviews[0].data.marks;
      if(previous.assessment.reviews[0].data.report.summary)baseline.assessment.reviews[0].data.report=previous.assessment.reviews[0].data.report;
    }
    setSample(baseline);setStep(next);setError("");void persist("started",next);
  };
  const close=()=>{setOpen(false);void persist(practising?"started":"skipped",step);};
  const current=steps[step],last=admin?8:7;
  return <>
    <Button variant="quiet" onClick={()=>{setOpen(true);setPractising(false);setError("");}}><HelpCircle size={16}/>Help / Practise</Button>
    <Dialog.Root open={open} onOpenChange={value=>{if(!value)close();}}>
      <Dialog.Portal><Dialog.Backdrop className={css.guideBackdrop}/><Dialog.Popup className={`${css.workspace} ${css.guideDialog}`} data-begifted-surface="ops" data-theme={theme}>
        <header className={css.guideHeader}><div><span className={css.badge}>{practising?"Practice — sample data":"Welcome to Progress Tests"}</span><Dialog.Title>{practising?current.title:"Try your first progress test"}</Dialog.Title><Dialog.Description>{practising?current.text:"Learn the workflow with a sample student. Practise at your own pace, then return to your work whenever you are ready."}</Dialog.Description></div><Button aria-label="Close guide" variant="quiet" onClick={close}><X size={20}/></Button></header>
        {error&&<p className={css.error} role="alert">{error}</p>}
        {!practising?<div className={css.guideWelcome}>
          <div className={css.heroAside}>{[{n:6,text:"Prepare your own test"},{n:7,text:"Discuss the topics"},{n:8,text:"Assess in class"}].map(x=><div className={css.milestone} key={x.n}><span>Class {x.n}</span><strong>{x.text}</strong></div>)}</div>
          <ol>{steps.slice(0,8).map(s=><li key={s.title}>{s.title}</li>)}</ol>
          <p className={css.hint}>Only approved graded tests and progress reports are published. Group courses are not part of this release.</p>
          <div className={css.actions}><Button variant="primary" disabled={saving} onClick={()=>start(progress?.status==="started"?progress.step:0)}><BookOpen size={16}/>{progress?.status==="started"?"Resume practice":"Start practice"}</Button>{progress?.status==="started"&&<Button disabled={saving} onClick={()=>start(0)}>Start again</Button>}<Button variant="quiet" onClick={close}>Skip for now</Button></div>
        </div>:<>
          <nav className={css.guideSteps} aria-label="Guide steps">{steps.slice(0,last+1).map((s,i)=><button key={s.title} aria-label={`${i+1}. ${s.title}`} aria-current={step===i?"step":undefined} onClick={()=>move(i)} disabled={saving}>{i+1}<span>{s.title}</span></button>)}</nav>
          <div className={css.guideBody} data-step={step}>
            {sample.notice&&<p className={css.notice} role="status">{sample.notice}</p>}
            <WorkspaceTransportContext.Provider value={{command:async c=>{const next=practiceCommand(sampleRef.current,c);sampleRef.current=next;setSample(next);return{id:c.action==="save-paper"?next.paper.id:next.assessment.id};},fileUrl:id=>practiceDocument(sampleRef.current,id),sampleUpload:purpose=>[{id:purpose==="work"?"demo-work":purpose==="key"?"demo-key":"demo-source",name:`Sample ${purpose}.pdf`,mime:"application/pdf",pageCount:2}]}}>
              {step===0?<section className={css.panel}><h3>Alex · sample student</h3><p>Mathematics · with Sample tutor</p><div className={css.resultScore}>6 / 8 classes</div><div className={css.meter} aria-label="6 of 8 classes completed">{Array.from({length:8},(_,i)=><span key={i} data-filled={i<6}/>)}</div><p>Your preparation reminder is here. Next: choose the paper and topics.</p><Button variant="primary" onClick={()=>move(1)}>Prepare this sample test<ArrowRight size={16}/></Button></section>
              :step===1?<PaperEditor key={`paper:${sample.paper.revision}`} data={sample.paper} overview={sample.overview} onBack={()=>move(0)} onSaved={async()=>{}} onError={setError}/>
              :step===8?<section className={css.panel}><h3>Sample admin queue</h3><p>Alex · Mathematics · publication needs review</p><p>Reason: Wise confirmed one file. The second is awaiting reconciliation.</p><Button onClick={()=>setPaused(!paused)}>{paused?"Resume sample publishing":"Pause sample publishing"}</Button><p role="status">{paused?"Sample publishing paused. Counters and approved records are preserved.":"Sample publishing active. No real setting was changed."}</p></section>
              :<AssessmentEditor key={`assessment:${step}:${sample.assessment.revision}`} data={sample.assessment} overview={sample.overview} onBack={()=>move(Math.max(0,step-1))} onSaved={async()=>{}} onError={setError}/>}
            </WorkspaceTransportContext.Provider>
          </div>
          <footer className={css.guideFooter}><Button disabled={saving||step===0} onClick={()=>move(step-1)}><ArrowLeft size={15}/>Back</Button><span aria-live="polite">Step {step+1} of {last+1}</span>{step<last?<Button variant="primary" disabled={saving} onClick={()=>move(step+1)}>Next<ArrowRight size={15}/></Button>:<Button variant="primary" disabled={saving} onClick={async()=>{await persist("completed",step);setOpen(false);setPractising(false);}}><CheckCheck size={16}/>Finish practice</Button>}</footer>
        </>}
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
  </>;
}
