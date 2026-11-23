"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { DEMO_BRIEF_PATH, DEMO_STEPS, demoBrief, demoState, markDemoPaper, resetDemo, setDemoStep, subscribeDemo } from "@/lib/hiring/demo";
import { BookingShell } from "./booking";
import { InterviewerBrief } from "./brief";
import css from "./demo-bar.module.css";

export type DemoView = (typeof DEMO_STEPS)[number]["view"];

/** The demo state, kept in step with the store in demo.ts. */
export const useDemoState = () => useSyncExternalStore(subscribeDemo, demoState, demoState);

/**
 * The presenter's bar in demo mode: where the made-up candidate is, what to say, what to select, and Back / Next.
 * A file link opens a demo PDF, and the head's candidate page opens over the screen, because both are links that
 * `demoFetch` cannot answer.
 */
export function DemoBar({ onStep, briefOpen, setBriefOpen }: { onStep: (view: DemoView) => void; briefOpen: boolean; setBriefOpen: (open: boolean) => void }) {
  const state = useDemoState();
  const step = DEMO_STEPS[state.step];
  const last = state.step === DEMO_STEPS.length - 1;
  // The screen follows the step: a button on a screen can move the step too (Good call, Yes, Approve).
  const shown = useRef(-1);
  useEffect(() => {
    if (shown.current === state.step) return;
    shown.current = state.step;
    onStep(step.view);
    if (state.step !== 5) setBriefOpen(false);
  }, [state.step, step.view, onStep, setBriefOpen]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      // An upload would send a real file to storage, so the button only marks the demo paper.
      if (event.target instanceof Element && event.target.closest("label")?.querySelector('input[type="file"]')) {
        event.preventDefault();
        markDemoPaper();
        return;
      }
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const href = link?.getAttribute("href") ?? "";
      if (href.startsWith(DEMO_BRIEF_PATH)) {
        event.preventDefault();
        setBriefOpen(true);
      } else if (href.startsWith("/api/hiring/")) {
        event.preventDefault();
        // The same answer a request would get: the packet page for the packet link, a demo PDF for a file.
        const tab = window.open("", "_blank");
        void window.fetch(new URL(href, window.location.origin).href).then((response) => response.blob()).then((file) => tab?.location.replace(URL.createObjectURL(file))).catch(() => tab?.close());
      }
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [setBriefOpen]);
  return (
    <>
      <aside className={css.bar} aria-label="Demo mode">
        <div className={css.top}>
          <p className={css.flag}><strong>Demo</strong> Made-up candidate. Nothing is saved or sent.</p>
          <div className={css.tools}>
            <button type="button" onClick={resetDemo}>Restart</button>
            <a href="/hiring">Exit demo</a>
          </div>
        </div>
        <ol className={css.steps}>
          {DEMO_STEPS.map((item, index) => (
            <li key={item.key}>
              <button type="button" aria-current={index === state.step ? "step" : undefined} data-done={index < state.step ? "" : undefined} onClick={() => setDemoStep(index)}>
                <span aria-hidden="true">{index + 1}</span>
                {item.title}
              </button>
            </li>
          ))}
        </ol>
        <div className={css.now} role="status">
          <div>
            <p className={css.who}>{step.who}</p>
            {state.closed ? (
              <p>The demo candidate was {state.closed}. Select Restart, or choose a step.</p>
            ) : (
              <>
                <p>{step.say}</p>
                <p className={css.act}>{state.step === 6 && state.packet ? "This is Gift’s screen now. Read the packet, then select Approve and send offer." : step.act}</p>
              </>
            )}
          </div>
          <div className={css.moves}>
            <button type="button" disabled={state.step === 0} onClick={() => setDemoStep(state.step - 1)}>Back</button>
            <button type="button" data-primary="" disabled={last} onClick={() => setDemoStep(state.step + 1)}>Next</button>
          </div>
        </div>
      </aside>
      {briefOpen && (
        <div className={css.brief} role="dialog" aria-modal="true" aria-label="The head’s candidate page">
          <p className={css.briefNote}>
            <span><strong>Demo</strong> This is the page the head opens from LINE.</span>
            <button type="button" onClick={() => setBriefOpen(false)}>Back to Hiring</button>
          </p>
          <BookingShell kind="brief">
            <InterviewerBrief brief={demoBrief()} resumeUrl="/api/hiring/brief/demo/resume" rubricUrl="/api/hiring/brief/demo/rubric" decisionUrl="/api/hiring/brief/demo/decision" />
          </BookingShell>
        </div>
      )}
    </>
  );
}
