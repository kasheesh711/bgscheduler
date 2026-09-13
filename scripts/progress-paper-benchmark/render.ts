import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { renderFormattedPaper, renderMarkingScheme, PAPER_RENDERER_VERSION } from "../../src/lib/progress-tests/workspace/paper-renderer";
import { paperCoverageWarnings, normalizeFormattedPaper } from "../../src/lib/progress-tests/workspace/model";
import { root as baseRoot, createFixtures, pdfPages } from "./fixtures";
import { scorePaper } from "./score";

async function inspect(bytes: Buffer, directory: string) {
  const { pdf, task } = await pdfPages(bytes); const pages = []; let text = '';
  try { for (let n=1;n<=pdf.numPages;n++) { const page = await pdf.getPage(n); const vp = page.getViewport({scale: .8}); const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({canvas:canvas as never,canvasContext:canvas.getContext('2d') as never,viewport:vp}).promise;
    await writeFile(`${directory}/page-${n}.png`, canvas.toBuffer('image/png'), {mode:0o600});
    const content = await page.getTextContent(); const items = content.items.filter(i => 'str' in i); const pageText = items.map(i => 'str' in i ? i.str : '').join(' '); text += `\nPAGE ${n}\n${pageText}`;
    const outside = items.filter(i => 'transform' in i && (i.transform[4] < -2 || i.transform[4] > 597 || i.transform[5] < -2 || i.transform[5] > 844));
    pages.push({page:n,textLength:pageText.length,outside:outside.length}); page.cleanup();
  } await writeFile(`${directory}/text.txt`,text,{mode:0o600});return {pages:pdf.numPages,checks:pages}; } finally { await task.destroy(); }
}
async function main() {
 const root = process.argv.includes('--codex') ? `${baseRoot}/codex-app-images-1600` : process.argv.includes('--images') ? `${baseRoot}/images-1600` : baseRoot;
 const fixtures=await createFixtures(); await mkdir(`${root}/renders`,{recursive:true});
 for (;;) {
  const runs=(await readdir(`${root}/runs`)).filter(f=>f.endsWith('.json')&&!f.endsWith('.response.json')).sort();
  for (const file of runs) {
   const id=file.slice(0,-5); const dir=`${root}/renders/${id}`;
   try { const existing=JSON.parse(await readFile(`${dir}/result.json`,'utf8')); if(existing.evaluationVersion===3)continue; } catch {}
   const run=JSON.parse(await readFile(`${root}/runs/${file}`,'utf8')); if(!run.apiSuccess)continue;
   await mkdir(dir,{recursive:true});const fixture=fixtures.find(f=>f.id===run.fixture)!;
   const paper=normalizeFormattedPaper(run.paper,fixture.pageCount,!!fixture.key);
   paper.warnings=[...new Set([...paper.warnings,...paper.questions.filter(q=>!q.maxMarks).map(q=>`Question ${q.number}: marks not supplied.`),...paperCoverageWarnings(paper,fixture.pageCount)])];
   const quality=scorePaper(paper,run.fixture,fixture.pageCount);const started=Date.now();let result:Record<string,unknown>={id,evaluationVersion:3,rendererVersion:PAPER_RENDERER_VERSION,quality,warnings:paper.warnings,questionCount:paper.questions.length};
   try {
    const pdf=await renderFormattedPaper(paper,fixture.source); const key=await renderMarkingScheme(paper);
    await writeFile(`${dir}/paper.pdf`,pdf,{mode:0o600});await writeFile(`${dir}/key.pdf`,key,{mode:0o600});
    const renderMs=Date.now()-started;
    await mkdir(`${dir}/paper`,{recursive:true});await mkdir(`${dir}/key`,{recursive:true});
    const paperInspection=await inspect(pdf,`${dir}/paper`),keyInspection=await inspect(key,`${dir}/key`);
    result={...result,success:true,renderMs,paperPages:(await PDFDocument.load(pdf)).getPageCount(),keyPages:(await PDFDocument.load(key)).getPageCount(),paperInspection,keyInspection};
   } catch(error) {result={...result,success:false,renderMs:Date.now()-started,error:error instanceof Error?error.message:'Render failed'};}
   await writeFile(`${dir}/result.json`,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({id,render:result.success,quality:quality.score,failures:quality.failures.map(c=>c.name),error:result.error}));
  }
  if(!process.argv.includes('--watch'))break;
  await new Promise(resolve=>setTimeout(resolve,4000));
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
