import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas,loadImage} from '@napi-rs/canvas';
const base='output/progress-tests-pdf/inspection';await mkdir(base,{recursive:true});
for(const file of process.argv.slice(2)) {
 const stem=path.basename(file,'.pdf');const directory=path.join(base,stem);await mkdir(directory,{recursive:true});
 const root=path.join(process.cwd(),'node_modules/pdfjs-dist');const task=getDocument({data:new Uint8Array(await readFile(file)),standardFontDataUrl:`${root}/standard_fonts/`,cMapUrl:`${root}/cmaps/`,cMapPacked:true,wasmUrl:`${root}/wasm/`});const pdf=await task.promise;const pages=[];let allText='';
 for(let n=1;n<=pdf.numPages;n++) {const page=await pdf.getPage(n);const viewport=page.getViewport({scale:1.25});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,annotationMode:0}).promise;const target=path.join(directory,`${n}.png`);await writeFile(target,canvas.toBuffer('image/png'));const text=(await page.getTextContent()).items.map(x=>x.str??'').join(' ');allText+=`\nPAGE ${n}\n${text}\n`;pages.push({n,path:target,textLength:text.length,width:viewport.width,height:viewport.height});page.cleanup();}
 for(let offset=0;offset<pages.length;offset+=6) {const sheet=createCanvas(1500,2120);const context=sheet.getContext('2d');context.fillStyle='#ddd';context.fillRect(0,0,sheet.width,sheet.height);for(let i=0;i<6&&offset+i<pages.length;i++){const p=pages[offset+i],img=await loadImage(p.path),x=(i%2)*750,y=Math.floor(i/2)*706;context.fillStyle='#16203a';context.font='15px sans-serif';context.fillText(`${stem} · page ${p.n}`,x+10,y+18);context.drawImage(img,x+10,y+28,480,678);}await writeFile(path.join(directory,`sheet-${offset/6+1}.png`),sheet.toBuffer('image/png'));}
 await writeFile(path.join(directory,'text.txt'),allText);console.log(JSON.stringify({file,pages:pdf.numPages,pageTextLengths:pages.map(p=>p.textLength)}));await task.destroy();
}
