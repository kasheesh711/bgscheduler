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
  function read(number, image = false) {
    const box = region();
    const canvas = box?.querySelectorAll("canvas")[number - 1];
    if (!canvas?.width || !canvas.height) return null;
    const rect = canvas.getBoundingClientRect(), clip = box.getBoundingClientRect();
    if (rect.top < Math.max(clip.top,0)-3 || rect.top+Math.min(65,rect.height*.14)>Math.min(clip.bottom,innerHeight)) return null;
    const pixel = [...canvas.getContext("2d").getImageData(10,10,1,1).data];
    if (![20,94,54].every((v,i)=>Math.abs(v-pixel[i])<=6) || pixel[3]!==255) return null;
    const info = {page:number,label:canvas.getAttribute("aria-label"),viewerPages:box.querySelectorAll("canvas").length,
      outerWidth, innerWidth, innerHeight, viewportScale:visualViewport.scale, devicePixelRatio,
      displayedWidth:rect.width, displayedHeight:rect.height, pixelWidth:canvas.width, pixelHeight:canvas.height,
      headingTop:rect.top, scrollTop:box.scrollTop};
    if (image) {
      const crop=document.createElement("canvas");crop.width=canvas.width;crop.height=Math.min(canvas.height,Math.ceil(canvas.height*.36));
      crop.getContext("2d").drawImage(canvas,0,0);
      info.png=crop.toDataURL("image/png").split(",")[1];
      crop.width=crop.height=0;
    }
    return info;
  }
  window.pdfQualification = {go,read};
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
