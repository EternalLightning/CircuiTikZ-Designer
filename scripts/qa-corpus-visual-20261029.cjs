// Real MCP -> isolated Edge -> preview/export -> local LaTeX comparison evidence.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');
const {chromium} = require('../.qa-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const corpus = process.env.QA_IMPORT_CORPUS || 'E:/Projects/SJTUCircuitsCamp';
const out = path.resolve(root, process.env.QA_OUTPUT_DIR || 'qa-results/corpus-visual-20261025');
const load = file => import(pathToFileURL(path.join(root,'mcp',file)).href);
const samples = [
 ['01-source','mooc/chapters/ch01.tex',0],
 ['02-controlled','mooc/chapters/ch03.tex',1],
 ['03-bridge','mooc/chapters/ch06.tex',0],
 ['04-graph','mooc/chapters/ch02.tex',0],
 ['05-curves','mooc/chapters/ch05.tex',0],
 ['06-opamp','2021-2022-2-final_term(honor)/questions/obj-09.tex',0],
 ['07-mutual','2021-2022-2-final_term(honor)/questions/obj-16.tex',0],
 ['08-transformer','2025-2026-2-mid_term/mid_exam.tex','SrcTop'],
 ['09-opamp-context','2021-2022-2-final_term(honor)/questions/obj-09.tex',0],
 ['10-mutual-context','2021-2022-2-final_term(honor)/questions/obj-16.tex',0],
 ['11-cubic-graph','mooc/chapters/ch05.tex','(-0.8,3.6)'],
 ['12-current-source','mooc/chapters/ch01.tex',1],
 ['13-shifted','mooc/chapters/ch04.tex','xshift=6.4cm'],
];
function wrapper(source,exam=false) {
 return String.raw`\documentclass[11pt,border=5pt]{standalone}
\usepackage{amsmath,amssymb}
` + (exam ? String.raw`\usepackage[europeanresistors,americanvoltages,europeancurrents,americaninductor]{circuitikz}` : String.raw`\usepackage{circuitikz}`) + String.raw`
\usetikzlibrary{calc,positioning,arrows.meta,decorations.markings,shapes.geometric,bending,fit,arrows}
\tikzset{arr/.style={postaction=decorate,decoration={markings,mark=at position #1 with {\arrow{Stealth}}}}}
\newcommand{\examcircuitikzscale}{0.9}
\begin{document}
` + source + '\n\\end{document}\n';
}
function compile(dir,name) {
 const p = spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','-no-shell-escape',name+'.tex'],{cwd:dir,encoding:'utf8',timeout:60000,windowsHide:true});
 fs.writeFileSync(path.join(dir,name+'.stdout.txt'),p.stdout+'\n'+p.stderr);
 if(p.status !== 0) return {ok:false,status:p.status,error:p.error?.message,tail:(p.stdout||'').slice(-1800)};
 const render = spawnSync('pdftoppm',['-scale-to','1600','-singlefile','-png',name+'.pdf',name],{cwd:dir,encoding:'utf8',timeout:30000,windowsHide:true});
 return {ok:render.status===0,pdfBytes:fs.statSync(path.join(dir,name+'.pdf')).size,renderError:render.stderr};
}
const server = http.createServer((req,res)=>{
 const base=path.join(root,'dist');
 const file=path.resolve(base,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
 if(!file.startsWith(base+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
 res.end(fs.readFileSync(file));
});
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const appUrl=`http://127.0.0.1:${server.address().port}/`;
 const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const client=new Client({name:'corpus-visual-qa',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/server.mjs')],env:{...process.env,MCP_BRIDGE_PORT:'0',MCP_APP_URL:appUrl},stderr:'pipe'});
 transport.stderr.on('data',()=>{});
 let browser;
 const startedAt=new Date().toISOString();
 const results={date:startedAt.slice(0,10),startedAt,corpus,transport:'Official MCP SDK stdio child process',browserErrors:[],samples:[]};
 try {
  console.log('MCP connecting'); await client.connect(transport); console.log('MCP connected');
  async function call(name,args={}) {
   const r=await client.callTool({name,arguments:args});
   const message=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
   return {error:!!r.isError,message,data:!r.isError&&name!=='designer_preview'?JSON.parse(message):null,response:r};
  }
  const status=(await call('designer_status')).data;
  console.log('Browser launching'); browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  page.on('pageerror',e=>{results.browserErrors.push(e.message);console.log('Browser error:',e.message);});
  await page.route('**/fonts.googleapis.com/**',r=>r.abort());
  await page.route('**/www.googletagmanager.com/**',r=>r.abort());
  console.log('Page loading'); await page.goto(status.connectUrl,{waitUntil:'commit',timeout:60000}); console.log('Page committed');
  await page.waitForFunction(()=>document.getElementById('mcpButton')?.textContent.includes('已连接'),{timeout:60000});
  console.log('Page connected'); const sessionId=(await call('designer_status')).data.sessions[0].sessionId;
  results.semantics = await require('./qa-visual-semantics.cjs')({call,page,sessionId,out,wrapper,compile});
  for(const [id,file,index] of samples.filter(([id]) => ['08-transformer','09-opamp-context','10-mutual-context','12-current-source'].includes(id))){
   const raw=fs.readFileSync(path.join(corpus,file),'utf8');
   const blocks=[...raw.matchAll(/\\begin\{(circuitikz|tikzpicture)\}[\s\S]*?\\end\{\1\}/g)];
   const match=typeof index==='number'?blocks[index]:blocks.find(m=>m[0].includes(index));
   if(!match)throw Error('Sample not found: '+id);
   const context = id.endsWith('-context') ? String.raw`\usepackage[europeanresistors,americanvoltages,europeancurrents,americaninductor]{circuitikz}
\newcommand{\examcircuitikzscale}{0.9}
` : '';
   const source=context+match[0],dir=path.join(out,id);
   fs.mkdirSync(dir,{recursive:true});
   const row={id,file,ordinal:blocks.indexOf(match)+1,line:raw.slice(0,match.index).split('\n').length,sourceSha256:require('node:crypto').createHash('sha256').update(source).digest('hex'),modes:{}};
   fs.writeFileSync(path.join(dir,'input.tikz'),source);
   fs.writeFileSync(path.join(dir,'original.tex'),wrapper(match[0],!file.startsWith('mooc/')));
   row.originalCompile=compile(dir,'original');
   for(const snap of [false,true]){
    const mode=snap?'snapped':'preserved';
    const doc=(await call('designer_get_document',{sessionId})).data;
    const args={sessionId,expectedRevision:doc.revision,source,replace:true,snapToGrid:snap};
    let imported=await call('designer_import_tikz',args);
    const strictError=imported.error?imported.message:null;
    if(imported.error){ const latest=(await call('designer_get_document',{sessionId})).data; imported=await call('designer_import_tikz',{...args,expectedRevision:latest.revision,allowWarnings:true}); }
    if(imported.error)throw Error(imported.message);
    const assert=require('node:assert/strict');
    assert.equal(strictError,null,id+': strict import');
    const saved=await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson()));
    for(const c of saved.filter(c=>['short','open'].includes(c.type))) assert(typeof c.scale==='undefined' || (typeof c.scale==='number' && c.scale>0),id+': numeric scale');
    if(id==='10-mutual-context') assert(saved.some(c=>c.type==='bezier' && c.points.length===4),'mutual cubic curve');
    if(id==='08-transformer') assert(saved.some(c=>c.type==='simpleText' && c.text.includes('1:3')), 'natural width filled ratio label');
    fs.writeFileSync(path.join(dir,mode+'.document.json'),JSON.stringify(imported.data,null,2));
    const preview=await call('designer_preview',{sessionId,maxDimension:1600,showGrid:false});
    if(preview.error)throw Error(preview.message);
    fs.writeFileSync(path.join(dir,mode+'.png'),Buffer.from(preview.response.content.find(c=>c.type==='image').data,'base64'));
    const exported=(await call('designer_export',{sessionId,format:'tikz'})).data;
    require('node:assert/strict')(!exported.content.includes('length=0.00cm'),'nonzero circuit symbol dimensions');
    fs.writeFileSync(path.join(dir,mode+'.tikz'),exported.content);
    fs.writeFileSync(path.join(dir,mode+'-export.tex'),wrapper(exported.content));
    const svg=(await call('designer_export',{sessionId,format:'svg'})).data;
    fs.writeFileSync(path.join(dir,mode+'.svg'),svg.content);
    await call('designer_fit_view',{sessionId});
    await page.screenshot({path:path.join(dir,mode+'-browser.png')});
    row.modes[mode]={strictError,components:imported.data.components.length,warnings:imported.data.warnings,gridAlignment:imported.data.gridAlignment,preview:JSON.parse(preview.message),exportCompile:compile(dir,mode+'-export')};
    console.log(id,mode,'components='+row.modes[mode].components,'strict='+!strictError,'original='+row.originalCompile.ok,'export='+row.modes[mode].exportCompile.ok);
   }
   results.samples.push(row);
   fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  }
 } finally {
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  await browser?.close(); await client.close(); await new Promise(r=>server.close(r));
 }
 console.log('Evidence:',out);
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
