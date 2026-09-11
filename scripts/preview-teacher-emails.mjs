import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const output = path.join(root, "output/teacher-emails");
await mkdir(path.join(output, "assets"), { recursive: true });
await build({ entryPoints: ["src/lib/teacher-emails/fixtures.ts"], bundle: true, platform: "node", format: "esm", outfile: path.join(output, "fixtures.mjs") });
const { teacherEmailFixtures } = await import(pathToFileURL(path.join(output, "fixtures.mjs")).href);
const placeholderLogo = "https://email-preview.invalid/logo.png";
const fixtures = teacherEmailFixtures(placeholderLogo);
await copyFile(path.join(root, "public/brand/email/v3/logo-horizontal.png"), path.join(output, "assets/logo.png"));
const logoData = `data:image/png;base64,${(await readFile(path.join(output, "assets/logo.png"))).toString("base64")}`;
for (const fixture of fixtures) {
  await writeFile(path.join(output, `${fixture.id}.html`), fixture.content.html.replaceAll(placeholderLogo, "assets/logo.png"));
  await writeFile(path.join(output, `${fixture.id}.txt`), fixture.content.text);
  fixture.content.html = fixture.content.html.replaceAll(placeholderLogo, logoData);
}
await writeFile(path.join(output, "manifest.json"), JSON.stringify(fixtures.map(({ id, name, content }) => ({ id, name, subject: content.subject })), null, 2));
const data = JSON.stringify(fixtures).replaceAll("<", "\\u003c");
await writeFile(path.join(output, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BeGifted · Teacher email previews</title>
<style>*{box-sizing:border-box}body{margin:0;background:#EDF1F6;color:#16203A;font:15px/1.5 Arial,Helvetica,sans-serif}header{padding:24px 32px;background:#16203A;color:white;border-top:5px solid #FF7518}h1{margin:0 0 8px;font-size:28px}header p{margin:0;color:#DFE5EC}main{max-width:1120px;margin:auto;padding:24px}label{font-weight:700}select,button{font:inherit;padding:10px 12px;border:1px solid #5A6678;border-radius:4px;background:white;color:#16203A}select{max-width:100%}button[aria-pressed=true]{background:#126DCE;color:white;border-color:#126DCE}.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}#subject{overflow-wrap:anywhere}.stage{padding:20px 0;border:1px solid #C8D1DC;background:#DFE5EC}iframe{display:block;width:100%;height:900px;max-width:640px;margin:auto;border:0;background:white}pre{max-width:640px;margin:auto;padding:24px;background:white;color:#16203A;white-space:pre-wrap;overflow-wrap:anywhere}body.dark{background:#16203A;color:white}body.dark .stage{background:#283142}a{color:#126DCE}body.dark a{color:#9DC2EE}@media(max-width:480px){main{padding:12px}header{padding:20px}h1{font-size:24px}}</style></head>
<body><header><h1>Teacher email previews</h1><p>BeGifted v3 · Synthetic examples · No messages are sent</p></header><main>
<label for="template">Message</label> <select id="template"></select>
<p id="subject"></p><div class="controls"><button id="html" aria-pressed="true">Email</button><button id="text" aria-pressed="false">Plain text</button><button data-width="320" aria-pressed="false">320px</button><button data-width="375" aria-pressed="false">375px</button><button data-width="640" aria-pressed="true">Desktop</button><button id="images" aria-pressed="false">Images off</button><button id="theme" aria-pressed="false">Dark surround</button></div>
<div class="stage"><iframe title="Teacher email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe><pre hidden></pre></div>
<p id="downloads"></p><p>These are browser previews. Actual Gmail, Outlook and Apple Mail rendering has not been tested. The email uses a light content surface in both surround modes.</p>
</main><script>const fixtures=${data};const select=document.querySelector('select'),frame=document.querySelector('iframe'),plain=document.querySelector('pre');let textMode=false,imagesOff=false;fixtures.forEach((f,i)=>select.add(new Option(f.name,i)));function render(){const f=fixtures[Number(select.value)];document.getElementById('subject').textContent='Subject: '+f.content.subject;frame.srcdoc=imagesOff?f.content.html.replace('</head>','<style>img{display:none!important}</style></head>'):f.content.html;frame.hidden=textMode;frame.style.display=textMode?'none':'block';plain.hidden=!textMode;plain.textContent=f.content.text;document.getElementById('html').setAttribute('aria-pressed',String(!textMode));document.getElementById('text').setAttribute('aria-pressed',String(textMode));const links=document.getElementById('downloads');links.replaceChildren();for(const ext of ['html','txt']){const a=document.createElement('a');a.href=f.id+'.'+ext;a.textContent='Open '+ext.toUpperCase();a.target='_blank';a.rel='noopener';links.append(a,document.createTextNode(' · '));}}select.onchange=render;document.getElementById('html').onclick=()=>{textMode=false;render()};document.getElementById('text').onclick=()=>{textMode=true;render()};document.getElementById('images').onclick=event=>{imagesOff=!imagesOff;event.currentTarget.setAttribute('aria-pressed',String(imagesOff));render()};document.getElementById('theme').onclick=event=>{document.body.classList.toggle('dark');event.currentTarget.setAttribute('aria-pressed',String(document.body.classList.contains('dark')))};document.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{frame.style.maxWidth=button.dataset.width+'px';document.querySelectorAll('[data-width]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)))});render();</script></body></html>`);
console.log(`Teacher email gallery: ${path.join(output, "index.html")}\n${fixtures.length} templates; no database or email credentials used.`);
