// This server uses the candidate's real paper-check screen and PDF worker.
// Its only document is an invented 45-page paper with visible page numbers.
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
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "paper.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: "out", platform: "browser", format: "iife", target: "es2022",
  jsx: "automatic", tsconfig: "tsconfig.json", minify: true, logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{name:"local-framework", setup(b) {
    b.onResolve({filter:/^next\/(navigation|link)$|^next-auth\/react$/}, a=>({path:a.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"}, a=>({resolveDir:root,contents:
      a.path==="next/link" ? "export default function Link(){return null}" :
      a.path==="next-auth/react" ? "export const signIn=()=>{};" :
      "export const useRouter=()=>({refresh(){}});export const useSearchParams=()=>new URLSearchParams();"
    }));
  }}],
});
const js = bundle.outputFiles.find(f => f.path.endsWith(".js")).contents;
const moduleCss = bundle.outputFiles.find(f => f.path.endsWith(".css")).text;
const from = path.join(root, "src/app/globals.css");
const globalCss = (await postcss([tailwind({base:root})]).process(readFileSync(from,"utf8"),{from})).css;
const worker = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const routes = new Map([
  ["/", ["text/html", '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Numbered PDF verification</title><link rel="stylesheet" href="/screen.css"></head><body><div id="root"></div><script src="/screen.js"></script><script src="/observe.js"></script></body></html>']],
  ["/screen.js", ["text/javascript",js]],
  ["/screen.css", ["text/css",globalCss+"\n"+moduleCss]],
  ["/observe.js", ["text/javascript",readFileSync(path.join(folder,"observe.js"))]],
  ["/api/hiring/paper-check/sample/paper", ["application/pdf",gunzipSync(readFileSync(path.join(folder,"numbered-paper.pdf.gz")))]],
  ["/api/hiring/paper-check/sample/runtime/worker-legacy.mjs", ["text/javascript",readFileSync(worker)]],
]);
let nativeSample = null;
const endpoint = "/qualification-sample";
const server = createServer((request,response)=>{
  const url = new URL(request.url,"http://127.0.0.1:4809");
  response.setHeader("Cache-Control","no-store");
  response.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; form-action 'none'; base-uri 'none'");
  if (url.pathname === endpoint && request.method === "POST") {
    let body = "";
    request.on("data",part=>{if(body.length+part.length>2_000_000){request.destroy();return;}body+=part;});
    request.on("end",()=>{try{nativeSample=JSON.parse(body);response.writeHead(204);}catch{response.writeHead(400);}response.end();});
    return;
  }
  if (url.pathname === endpoint && request.method === "GET") {
    response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(nativeSample));return;
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
