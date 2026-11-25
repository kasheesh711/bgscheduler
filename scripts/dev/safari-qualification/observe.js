// Read the actual canvas backing pixels, and only capture a page whose heading is in view.
(() => {
  const region = () => document.querySelector('[role="region"][aria-label="Marked paper of Cedar sample"]');
  function go(number) {
    const box = region();
    const canvas = box?.querySelectorAll("canvas")[number - 1];
    if (!canvas) return false;
    box.scrollIntoView({block:"start"});
    box.scrollTop += canvas.getBoundingClientRect().top - box.getBoundingClientRect().top - 9;
    return true;
  }
  function inspect(number) {
    const box = region(), canvas = box?.querySelectorAll("canvas")[number - 1];
    const clip = box?.getBoundingClientRect(), rect = canvas?.getBoundingClientRect();
    const pixel = canvas?.width && canvas?.height ? [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data] : null;
    const headingInView = !!rect && rect.top >= Math.max(clip.top, 0)-3 &&
      rect.top+Math.min(65,rect.height*.14) <= Math.min(clip.bottom,innerHeight);
    const hasInk = !!pixel && [20,94,54].every((v,i)=>Math.abs(v-pixel[i])<=6) && pixel[3]===255;
    return {page:number, label:canvas?.getAttribute("aria-label") ?? null, viewerPages:box?.querySelectorAll("canvas").length ?? 0,
      documentReady:document.readyState, viewerBusy:box?.getAttribute("aria-busy") ?? null,
      outerWidth, innerWidth, innerHeight, viewportScale:visualViewport.scale, devicePixelRatio,
      displayedWidth:rect?.width ?? 0, displayedHeight:rect?.height ?? 0, pixelWidth:canvas?.width ?? 0, pixelHeight:canvas?.height ?? 0,
      headingTop:rect?.top ?? null, viewerTop:clip?.top ?? null, viewerBottom:clip?.bottom ?? null,
      scrollTop:box?.scrollTop ?? null, sampleRGBA:pixel, headingInView, hasInk};
  }
  function read(number, image = false) {
    const box = region();
    const canvas = box?.querySelectorAll("canvas")[number - 1];
    const info = inspect(number);
    if (!canvas || !info.headingInView || !info.hasInk) return null;
    if (image) {
      const crop=document.createElement("canvas");crop.width=canvas.width;crop.height=Math.min(canvas.height,Math.ceil(canvas.height*.36));
      crop.getContext("2d").drawImage(canvas,0,0);
      info.png=crop.toDataURL("image/png").split(",")[1];
      crop.width=crop.height=0;
    }
    return info;
  }
  window.pdfQualification = {go,read,inspect};
  if (!new URLSearchParams(location.search).has("native")) return;
  let moved = "", last = "";
  setInterval(() => {
    const number = Number(location.hash.slice(1)) || 22;
    if (moved !== location.hash) go(number);
    const status = read(number);
    if (!status) return;
    moved = location.hash;
    const signature = JSON.stringify(status);
    if (signature === last) return;
    last = signature;
    fetch("/qualification-sample",{method:"POST",body:JSON.stringify(read(number,true))}).catch(()=>{last="";});
  }, 150);
})();
