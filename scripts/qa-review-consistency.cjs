// Real MCP imports and local XeLaTeX render comparisons, with source files read-only.
const fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const crypto=require('node:crypto'), {pathToFileURL}=require('node:url'), {spawnSync}=require('node:child_process');
const {chromium}=require('../.qa-tools/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const corpus='E:/Projects/Thesis/电机学/review';
const out=path.resolve(root,process.env.QA_OUTPUT_DIR||'qa-results/review-consistency-20261029-final');
const preamble=String.raw`\usepackage{ctex,amsmath,amssymb}
\usepackage[european resistors]{circuitikz}
\usetikzlibrary{arrows.meta,calc,positioning,angles,quotes,decorations.markings,shapes.geometric,bending,fit,arrows,backgrounds}
\definecolor{amzchaptercolor}{HTML}{0984e3}
\newcommand{\jj}{\mathrm{j}}
`;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const files=['figures','contents'].flatMap(folder=>fs.readdirSync(path.join(corpus,folder)).filter(f=>f.endsWith('.tex')).map(f=>folder+'/'+f)).sort();
const samples=[], templates=[], manifest=[];
for(const file of files){
 const raw=fs.readFileSync(path.join(corpus,file),'utf8'); manifest.push({file,sha256:sha(raw)});
 let ordinal=0;
 for(const m of raw.matchAll(/\\begin\{(tikzpicture|circuitikz)\}[\s\S]*?\\end\{\1\}/g)){
  const row={file,ordinal:++ordinal,line:raw.slice(0,m.index).split('\n').length,source:m[0]};
  if(file==='figures/assignment_phasors.tex'){templates.push(row);continue;}
  // Standalone figure files may define libraries/styles before the environment.
  if(file.startsWith('figures/')) row.source=raw;
  row.id=String(samples.length+1).padStart(2,'0')+'-'+path.basename(file,'.tex')+'-'+ordinal;
  samples.push(row);
 }
}
function compile(dir,name,source){
 if(source.startsWith(preamble)) source=source.slice(preamble.length);
 const at=source.search(/\\begin\{(?:tikzpicture|circuitikz)\}/);
 const prefix=at>0?source.slice(0,at):'',body=at>0?source.slice(at):source;
 const tex='\\documentclass[11pt,border=5pt]{standalone}\n'+preamble+prefix+'\\begin{document}\n'+body+'\n\\end{document}\n';
 fs.writeFileSync(path.join(dir,name+'.tex'),tex);
 const r=spawnSync('xelatex',['-interaction=nonstopmode','-halt-on-error','-no-shell-escape',name+'.tex'],{cwd:dir,encoding:'utf8',timeout:90000,windowsHide:true});
 fs.writeFileSync(path.join(dir,name+'.stdout.txt'),(r.stdout||'')+'\n'+(r.stderr||''));
 if(r.status!==0)return {ok:false,status:r.status,error:r.error?.message,tail:(r.stdout||'').slice(-1600)};
 const render=spawnSync('pdftoppm',['-scale-to','1400','-singlefile','-png',name+'.pdf',name],{cwd:dir,encoding:'utf8',timeout:30000,windowsHide:true});
 return {ok:render.status===0,pdfBytes:fs.statSync(path.join(dir,name+'.pdf')).size,error:render.stderr};
}
const load=f=>import(pathToFileURL(path.join(root,'mcp',f)).href);
const server=http.createServer((req,res)=>{
 const base=path.join(root,'dist'),file=path.resolve(base,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
 if(!file.startsWith(base+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 if(fs.existsSync(path.join(out,'results.json')))throw Error('Preserve existing evidence: choose a fresh output directory.');
 fs.mkdirSync(out,{recursive:true});
 const results={corpus,preamble,startedAt:new Date().toISOString(),sourceFiles:manifest,templates:templates.map(({source,...r})=>r),samples:[],browserErrors:[]};
 const persist=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));persist();
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const client=new Client({name:'review-consistency-audit',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/server.mjs')],env:{...process.env,MCP_BRIDGE_PORT:'0',MCP_APP_URL:`http://127.0.0.1:${server.address().port}/`},stderr:'pipe'});
 transport.stderr.on('data',()=>{});
 let browser;
 try{
  await client.connect(transport);
  async function call(name,args={}){
   const response=await client.callTool({name,arguments:args},undefined,{timeout:120000});
   const message=response.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
   return {error:!!response.isError,message,response,data:!response.isError&&name!=='designer_preview'?JSON.parse(message):null};
  }
  const initial=(await call('designer_status')).data;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>results.browserErrors.push(e.message));
  await page.route('**/www.googletagmanager.com/**',r=>r.abort());
  await page.route('**/fonts.googleapis.com/**',r=>r.abort());
  await page.goto(initial.connectUrl,{waitUntil:'commit',timeout:60000});
  await page.waitForFunction(()=>document.getElementById('mcpButton')?.textContent.includes('已连接'),null,{timeout:90000});
  const sessionId=(await call('designer_status')).data.sessions[0].sessionId;
  console.log(`Found ${samples.length} concrete pictures, ${templates.length} parameterized templates in ${files.length} files`);
  for(const sample of samples.filter(s=>!process.env.QA_REVIEW_FILTER || s.file.includes(process.env.QA_REVIEW_FILTER))){
   const {source,...row}=sample,dir=path.join(out,row.id);fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'input.tikz'),source);
   try{
    const before=(await call('designer_get_document',{sessionId,includeComponents:false,includeSaveFile:false})).data;
    const args={sessionId,expectedRevision:before.revision,source,preamble,replace:true,snapToGrid:false};
    let imported=await call('designer_import_tikz',args);row.strictAccepted=!imported.error;row.strictError=imported.error?imported.message:null;
    if(imported.error){const current=(await call('designer_get_document',{sessionId,includeComponents:false,includeSaveFile:false})).data;imported=await call('designer_import_tikz',{...args,expectedRevision:current.revision,allowWarnings:true});}
    row.imported=!imported.error;
    if(imported.error){row.error=imported.message;}
    else{
     row.warnings=imported.data.warnings||[];row.componentCount=imported.data.componentCount;
     fs.writeFileSync(path.join(dir,'document.json'),JSON.stringify(imported.data,null,2));
     const preview=await call('designer_preview',{sessionId,showGrid:false,maxDimension:1400});
     if(preview.error)row.previewError=preview.message;
     else fs.writeFileSync(path.join(dir,'preview.png'),Buffer.from(preview.response.content.find(c=>c.type==='image').data,'base64'));
     const exp=await call('designer_export',{sessionId,format:'tikz'});
     if(exp.error)row.exportError=exp.message;
     else{fs.writeFileSync(path.join(dir,'export.tikz'),exp.data.content);row.exportCompile=compile(dir,'export',exp.data.content);}
    }
    row.originalCompile=compile(dir,'original',source);
   }catch(e){row.error=e.message;}
   results.samples.push(row);persist();
   console.log(`${row.id}: strict=${row.strictAccepted} objects=${row.componentCount} original=${row.originalCompile?.ok} export=${row.exportCompile?.ok} warnings=${JSON.stringify(row.warnings||[])}`);
  }
  results.sourcesUnchanged=manifest.every(r=>sha(fs.readFileSync(path.join(corpus,r.file),'utf8'))===r.sha256);
  results.completedAt=new Date().toISOString();persist();
 }finally{persist();await browser?.close();await client.close();await new Promise(r=>server.close(r));}
 console.log('Evidence:',out);
})().catch(e=>{console.error(e.message.replace(/#mcpToken=[^\s"]+/g,'#mcpToken=[redacted]'));server.close();process.exitCode=1;});
