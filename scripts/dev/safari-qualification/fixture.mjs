// This server uses the candidate's real paper-check screen and PDF worker.
// Its only document is an invented 45-page paper with visible page numbers.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = process.cwd();
const folder = path.dirname(fileURLToPath(import.meta.url));
const entry = `
import { createRoot } from "react-dom/client";
import { BookingShell } from "@/components/hiring/booking";
import { PaperCheck } from "@/components/hiring/paper-check";
const view = { id: "fixture-paper", name: "Cedar sample", subject: "Mathematics", head: "Sample reviewer",
  open: true, done: null, aiPercent: 70, passMark: 70, mock: null, comment: "", updatedAt: "2026-11-26",
  questions: [{id:"1",level:"Sample",max:10,marks:7,reason:"Synthetic example."}] };
createRoot(document.getElementById("root")).render(<BookingShell kind="paper-check"><PaperCheck view={view} token="sample" /></BookingShell>);
`;
const base = "359c97fd3c143e326068203ff83fcf7fb9d311eb";
const baseSource = execFileSync("git",["show",base+":src/components/hiring/pdf-pages.tsx"],{encoding:"utf8"});
async function buildScreen(baseline) {
  return build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "paper.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: "out", platform: "browser", format: "iife", target: "es2022",
  jsx: "automatic", tsconfig: "tsconfig.json", minify: true, logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{name:"local-framework", setup(b) {
    if (baseline) b.onLoad({filter:/[\/]src[\/]components[\/]hiring[\/]pdf-pages\.tsx$/},
      args => ({contents:baseSource,loader:"tsx",resolveDir:path.dirname(args.path)}));
    b.onResolve({filter:/^next\/(navigation|link)$|^next-auth\/react$/}, a=>({path:a.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"}, a=>({resolveDir:root,contents:
      a.path==="next/link" ? "export default function Link(){return null}" :
      a.path==="next-auth/react" ? "export const signIn=()=>{};" :
      "export const useRouter=()=>({refresh(){}});export const useSearchParams=()=>new URLSearchParams();"
    }));
  }}],
});
}
const bundle=await buildScreen(false);
const baseline=await buildScreen(true);
const baseJS=baseline.outputFiles.find(f=>f.path.endsWith(".js")).contents;
const js = bundle.outputFiles.find(f => f.path.endsWith(".js")).contents;
const moduleCss = bundle.outputFiles.find(f => f.path.endsWith(".css")).text;
const from = path.join(root, "src/app/globals.css");
const globalCss = (await postcss([tailwind({base:root})]).process(readFileSync(from,"utf8"),{from})).css;
const worker = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const routes = new Map([
  ["/static",["text/html",'<html><head><title>Numbered PDF verification - static</title></head><body style="margin:40px;background:white;color:black;font:40px Arial"><h1>Cedar 91</h1><p>Static HTML reading card</p><script src="/observe.js"></script></body></html>']],
  ...["base","candidate"].map(kind=>["/"+kind,["text/html",`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Numbered PDF verification - ${kind}</title><link rel="stylesheet" href="/screen.css"></head><body><div id="root"></div><script src="/${kind}.js"></script><script src="/observe.js"></script></body></html>`]]),
  ["/base.js", ["text/javascript",baseJS]],
  ["/candidate.js", ["text/javascript",js]],
  ["/screen.css", ["text/css",globalCss+"\n"+moduleCss]],
  ["/observe.js", ["text/javascript",readFileSync(path.join(folder,"observe.js"))]],
  ["/api/hiring/paper-check/sample/paper", ["application/pdf",gunzipSync(readFileSync(path.join(folder,"numbered-paper.pdf.gz")))]],
  ["/api/hiring/paper-check/sample/runtime/worker-legacy.mjs", ["text/javascript",readFileSync(worker)]],
]);
const nativeSamples = new Map();
let navigation=null;
const endpoint = "/qualification-sample";
const server = createServer((request,response)=>{
  const url = new URL(request.url,"http://127.0.0.1:4809");
  response.setHeader("Cache-Control","no-store");
  response.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; form-action 'none'; base-uri 'none'");
  if (url.pathname === "/native-navigation") {
    if (request.method === "GET") {
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(navigation));return;
    }
    if (request.method === "POST") {
      const current=url.searchParams.get("current"), next=url.searchParams.get("next");
      if (!/^regular[0-9]+$/.test(current ?? "") || !/^\/(?:static|candidate)\?run=regular[0-9]+#(?:1|22(?:-(?:resize|zoom))?|40|91)$/.test(next ?? "")) {response.writeHead(400);response.end();return;}
      navigation={current,next};response.writeHead(204);response.end();return;
    }
    response.writeHead(405);response.end();return;
  }
  if ([endpoint,"/document-loaded"].includes(url.pathname) && request.method === "POST") {
    let body = "";
    request.on("data",part=>{if(body.length+part.length>2_000_000){request.destroy();return;}body+=part;});
    request.on("end",()=>{try{
      const sample=JSON.parse(body);
      if (!["static","base","candidate"].includes(sample.kind) || !/^[a-z0-9-]{1,50}$/.test(sample.run)) throw new Error("Invalid sample");
      nativeSamples.set(url.pathname+"/"+sample.kind+"/"+sample.run,sample); response.writeHead(204);
    }catch{response.writeHead(400);}response.end();});
    return;
  }
  if ([endpoint,"/document-loaded"].includes(url.pathname) && request.method === "GET") {
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(nativeSamples.get(url.pathname+"/"+url.searchParams.get("kind")+"/"+url.searchParams.get("run")) ?? null));return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {response.writeHead(405);response.end();return;}
  let item = routes.get(url.pathname);
  const font = /^\/api\/hiring\/paper-check\/sample\/runtime\/([\w-]+\.(?:pfb|ttf))$/.exec(url.pathname);
  if (!item && font) {
    try {item=["application/octet-stream",readFileSync(path.join(root,"node_modules/pdfjs-dist/standard_fonts",font[1]))];} catch {}
  }
  if (!item) {response.writeHead(404);response.end();return;}
  response.writeHead(200,{"Content-Type":item[0]});response.end(request.method==="HEAD"?undefined:item[1]);
});
server.listen(4809,"127.0.0.1");
