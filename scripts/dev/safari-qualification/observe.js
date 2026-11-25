// Read page geometry and the source ink. Native Safari screenshots verify the visible number.
(() => {
  const region = () => document.querySelector('[role="region"][aria-label="Marked paper of Cedar sample"]');
  function go(number) {
    const box = region();
    const canvas = box?.querySelectorAll("canvas")[number - 1];
    if (!canvas) return false;
    box.scrollIntoView({block:"start"});
    // Position the requested heading below both the scroll container and the browser viewport edge.
    const visibleTop = Math.max(0,box.getBoundingClientRect().top);
    box.scrollTop += canvas.getBoundingClientRect().top - visibleTop - 32;
    return true;
  }
  function inspect(number) {
    const box = region(), canvas = box?.querySelectorAll("canvas")[number - 1];
    const clip = box?.getBoundingClientRect(), rect = canvas?.getBoundingClientRect();
    const pixel = canvas?.width && canvas?.height ? [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data] : null;
    // Both synthetic page orientations place the Cedar heading 44–84 PDF points from the top.
    const sheetWidth = number === 22 ? 842 : 595;
    const pointScale = rect ? rect.width/sheetWidth : 0;
    const headingInView = !!rect && rect.top+44*pointScale >= Math.max(clip.top,0) &&
      rect.top+84*pointScale <= Math.min(clip.bottom,innerHeight);
    const hasInk = !!pixel && [20,94,54].every((v,i)=>Math.abs(v-pixel[i])<=6) && pixel[3]===255;
    return {page:number, label:canvas?.getAttribute("aria-label") ?? null, viewerPages:box?.querySelectorAll("canvas").length ?? 0,
      documentReady:document.readyState, viewerBusy:box?.getAttribute("aria-busy") ?? null,
      outerWidth, innerWidth, innerHeight, viewportScale:visualViewport.scale, devicePixelRatio,
      displayedWidth:rect?.width ?? 0, displayedHeight:rect?.height ?? 0, pixelWidth:canvas?.width ?? 0, pixelHeight:canvas?.height ?? 0,
      headingLeft:rect?.left ?? null, headingTop:rect?.top ?? null, viewerTop:clip?.top ?? null, viewerBottom:clip?.bottom ?? null,
      scrollTop:box?.scrollTop ?? null, sampleRGBA:pixel, headingInView, hasInk};
  }
  function read(number) {
    const info = inspect(number);
    return info.viewerBusy === "false" && info.headingInView && info.hasInk ? info : null;
  }
  window.pdfQualification = {go,read,inspect};
  const run = new URLSearchParams(location.search).get("run");
  if (!run) return;
  const kind = location.pathname.slice(1);
  const mode = /^regular[0-9]+$/.test(run) ? "regular" : /^driver[0-9]+$/.test(run) ? "driver" : "";
  if (mode) document.title="Numbered PDF verification - "+kind+" "+mode;
  const documentId=String(performance.timeOrigin);
  function sendLoad() {
    const nav=performance.getEntriesByType("navigation")[0];
    const loaded={kind,run,documentId,position:location.hash,readyState:document.readyState,
      loadEventEndMs:nav?.loadEventEnd ?? null, observedAtMs:performance.now()};
    fetch("/document-loaded",{method:"POST",body:JSON.stringify(loaded)}).catch(()=>{});
  }
  if (document.readyState==="complete") setTimeout(sendLoad,0);
  else window.addEventListener("load",()=>setTimeout(sendLoad,0),{once:true});

  // Leave the opening page untouched until the coordinator starts the ten-second assertion.
  // Its navigation beacon reads only the document lifecycle, never a PDF page or canvas.
  let startupReleased=kind!=="candidate" || run!=="regular1";
  if (/^regular[0-9]+$/.test(run)) {
    setInterval(async()=>{
      try {
        const next=await (await fetch("/native-navigation")).json();
        if (next?.current===run) {
          if (next.next==="/candidate?run=regular1#22") startupReleased=true;
          if (location.pathname+location.search+location.hash!==next.next) location.assign(next.next);
        }
      } catch {}
    },250);
  }
  let moved = "", last = "";
  setInterval(() => {
    if (!startupReleased) return;
    const number = kind === "static" ? 91 : Number(location.hash.slice(1).split("-")[0]) || 1;
    if (kind !== "static" && moved !== location.hash) go(number);
    const state = kind === "static"
      ? {hasText:document.querySelector("h1")?.textContent === "Cedar 91", innerWidth, outerWidth, viewportScale:visualViewport.scale}
      : inspect(number);
    if (kind === "static" || (state.headingInView && state.hasInk && state.viewerBusy === "false")) moved=location.hash;
    const status = {kind,run,documentId,position:location.hash,page:number,...state};
    const signature = JSON.stringify(status);
    if (signature===last) return;
    last=signature;
    fetch("/qualification-sample",{method:"POST",body:signature}).catch(()=>{last="";});
  },200);
})();
