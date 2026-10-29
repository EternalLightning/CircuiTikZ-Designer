const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('../.qa-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const corpus = process.env.QA_IMPORT_CORPUS || path.resolve(root, '..', '..', 'SJTUCircuitsCamp');
if (!fs.existsSync(corpus)) throw new Error(`Import test corpus not found: ${corpus}. Set QA_IMPORT_CORPUS to the source directory.`);
const out = path.join(root, 'qa-results');
fs.mkdirSync(out, { recursive: true });
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e =>
    e.isDirectory() ? (/^(\.git|temp|node_modules)$/.test(e.name) ? [] : walk(path.join(dir,e.name))) :
    e.name.endsWith('.tex') ? [path.join(dir,e.name)] : []);
}
const diagrams = [];
for (const file of walk(corpus)) {
  const source = fs.readFileSync(file,'utf8').replace(/(?<!\\)%[^\n]*/g,'');
  let ordinal = 0;
  for (const m of source.matchAll(/\\begin\{(circuitikz|tikzpicture)\}[\s\S]*?\\end\{\1\}/g)) {
    diagrams.push({file:path.relative(corpus,file), ordinal:++ordinal, source:m[0]});
  }
}
const features = [/(?:op|en) amp/,/transformer/,/controlled|cV|cI/,/\\foreach/,/\$\(/,/arc\b/,/bend left|bend right/,/sinusoidal|sV|sI/,/to\[L/,/to\[C/,/to\[R/,/\\coordinate/,/american/,/european/,/node\[.*ground/,/rotate=/,/scale=/,/\\begin\{scope\}/,/xshift|yshift/,/to\[open/];
const selected = [];
// Cover actual chapter sources and each course/exam family before filling by syntax.
for(const group of [...new Set(diagrams.map(d=>d.file.split(path.sep)[0]))]) {
 const d=diagrams.find(d=>d.file.startsWith(group+path.sep) && !path.basename(d.file).startsWith('_'));
 if(d) selected.push(d);
}
for(const chapter of ['ch02.tex','ch03.tex','ch05.tex','ch06.tex','ch09.tex']) {
 const d=diagrams.find(d=>d.file.includes('chapters') && d.file.endsWith(chapter));
 if(d && !selected.includes(d)) selected.push(d);
}
for (const feature of features) {
  const d = diagrams.find(d=>feature.test(d.source) && !selected.includes(d));
  if(d) selected.push(d);
}
for(const file of [...new Set(diagrams.map(d=>d.file))]) {
  if(selected.length>=35) break;
  if(!selected.some(d=>d.file===file)) selected.push(diagrams.find(d=>d.file===file));
}
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
const server=http.createServer((req,res)=>{
  const file=path.join(root,'dist',decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
  if(!file.startsWith(path.join(root,'dist')) || !fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/www.googletagmanager.com/**',r=>r.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.mainController?.isInitDone,{timeout:60000});
  async function run(source,snap=true){
   return await page.evaluate(({source,snap})=>{
    const main=window.mainController;
    document.getElementById('importModal').dispatchEvent(new Event('hidden.bs.modal'));
    document.getElementById('importTikzContent').value=source;
    document.getElementById('importCheckGrid').checked=snap;
    document.getElementById('importCheckRemove').checked=true;
    document.getElementById('importTikzButton').click();
    return {status:document.getElementById('importStatus').textContent,
     components:main.circuitComponents.map(c=>c.toJson()),
     pins:main.circuitComponents.filter(c=>c.toJson().points || c.toJson().type==='node').map(c=>c.snappingPoints.map(p=>({x:p.x,y:p.y}))),
     finite:main.circuitComponents.every(c=>[c.position.x,c.position.y,c.bbox.x,c.bbox.y,c.bbox.width,c.bbox.height].every(Number.isFinite))};
   },{source,snap});
  }
  const basic=String.raw`\begin{circuitikz}\draw (0.13,0.13) to[R,l=$R$] (2.13,0.13) -- (2.13,2.13) -- (0.13,2.13);\node[ground] at (0.13,0.13) {};\end{circuitikz}`;
  const before=await run(basic,false), after=await run(basic,true);
  const spacing=96/2.54/4;
  assert(after.components.length===3 && after.finite);
  assert.notDeepEqual(before.components,after.components);
  for(const c of after.components) for(const p of c.points||[]) for(const k of ['x','y']) assert(Math.abs(p[k]/spacing-Math.round(p[k]/spacing))<1e-4);
  assert.deepEqual(after.components[0].points[0],after.components[2].position);
  await page.evaluate(()=>document.getElementById('undoButton').click());
  assert.deepEqual(await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson())),before.components);
  await page.evaluate(()=>document.getElementById('redoButton').click());
  assert.deepEqual(await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson())),after.components);
  const translated=await run(String.raw`\begin{circuitikz}\begin{scope}[xshift=8cm,yshift=-2cm]\draw (0,0) to[R] (2,0);\end{scope}\end{circuitikz}`,false);
  assert(Math.abs(translated.components[0].points[0].x-8*96/2.54)<0.001);
  assert(Math.abs(translated.components[0].points[0].y-2*96/2.54)<0.001);
  const scaled=await run(String.raw`\begin{circuitikz}[scale=2,transform shape]\draw (0,0) to[R] (2,0);\end{circuitikz}`,false);
  assert(Math.abs(scaled.components[0].points[1].x-4*96/2.54)<0.001);
  assert.deepEqual(scaled.components[0].scale,{x:2,y:2});
  const ellipse=await run(String.raw`\begin{circuitikz}\draw (0,0) ellipse (2cm and 1cm);\end{circuitikz}`,false);
  assert.equal(ellipse.components[0].type,'ellipse');
  assert(Math.abs(ellipse.components[0].size.x-ellipse.components[0].size.y-2*96/2.54)<0.001);
  const chained=await run(String.raw`\begin{circuitikz}\node[gyrator](N1) at (2.5,1.5){} node[anchor=south] at (N1.text){$r$};\end{circuitikz}`,false);
  assert.equal(chained.components.length,2);
  assert.equal(chained.status,'');
  const arc=await run(String.raw`\begin{circuitikz}\draw (1,0) arc (0:360:1);\end{circuitikz}`,false);
  assert.equal(arc.components[0].type,'wire');
  assert.equal(arc.components[0].points.length,73);
  assert.deepEqual(arc.components[0].points[0],arc.components[0].points.at(-1));
  const multi=await run(String.raw`\begin{circuitikz}[european resistors]\draw (0,0) to[R] (2,0);\end{circuitikz}\begin{circuitikz}[american resistors]\draw (0,0) to[R] (2,0);\end{circuitikz}`,false);
  assert.equal(multi.components[0].id,'european resistor');
  assert.equal(multi.components[1].id,'american resistor');
  await run(basic,true);
  await page.evaluate(async()=>{
   const shown=new Promise(resolve=>document.getElementById('exportModal').addEventListener('shown.bs.modal',resolve,{once:true}));
   document.getElementById('exportCircuiTikZButton').click();await shown;
  });
  const exported=await page.locator('#exportedContent').inputValue();
  assert(exported.includes('transform shape') && exported.includes('to['));
  const roundtrip=await run(exported,false);
  assert.equal(roundtrip.components.length,after.components.length);
  await page.evaluate(async()=>{
   const hidden=new Promise(resolve=>document.getElementById('exportModal').addEventListener('hidden.bs.modal',resolve,{once:true}));
   document.querySelector('#exportModal .btn-close').click();await hidden;
  });
  await page.waitForFunction(()=>!document.getElementById('exportModal').classList.contains('show'));
  await page.waitForFunction(()=>!document.querySelector('.modal-backdrop'));
  await page.evaluate(()=>{window.mainController.circuitComponents.forEach(c=>{c.isSelected=false;c.viewSelected(false)});window.mainController.canvasController.fitView()});
  const inView=await page.evaluate(()=>{
   const m=window.mainController,v=m.canvasController.canvas.viewbox();
   return m.circuitComponents.every(c=>{const b=c.visualization.rbox(m.canvasController.canvas);return b.x>=v.x && b.y>=v.y && b.x2<=v.x2 && b.y2<=v.y2});
  });
  assert(inView,'Fit view must contain all imported components');
  await page.screenshot({path:path.join(out,'grid-basic.png')});
  // Move a real endpoint handle with the mouse and verify one-step Undo/Redo.
  await page.evaluate(()=>window.mainController.circuitComponents[0].isSelected=true);
  const handle=await page.evaluate(()=>{
   const c=window.mainController.circuitComponents[0];c.resizable(true);
   const b=c.resizableSVGs[1].node.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};
  });
  const preDrag=await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson()));
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+50,handle.y-40,{steps:6});await page.mouse.up();
  const postDrag=await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson()));
  assert.notDeepEqual(preDrag,postDrag,'Endpoint mouse drag should change geometry');
  await page.evaluate(()=>document.getElementById('undoButton').click());
  assert.deepEqual(await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson())),preDrag);
  await page.evaluate(()=>document.getElementById('redoButton').click());
  assert.deepEqual(await page.evaluate(()=>window.mainController.circuitComponents.map(c=>c.toJson())),postDrag);
  const results=[];
  for(const d of selected){
   const original=await run(d.source,false), snapped=await run(d.source,true);
   assert(original.components.length>0,`${d.file} #${d.ordinal}: no components`);
   assert(snapped.components.length===original.components.length,`${d.file}: component count changed`);
   assert(snapped.finite,`${d.file}: non-finite geometry`);
   // Every pair of coincident path endpoints must remain coincident.
   const a=original.components.flatMap(c=>c.points||[]), b=snapped.components.flatMap(c=>c.points||[]);
   let connections=0;
   for(let i=0;i<a.length;i++) for(let j=0;j<i;j++) if(Math.hypot(a[i].x-a[j].x,a[i].y-a[j].y)<1e-4){
    connections++; assert(Math.hypot(b[i].x-b[j].x,b[i].y-b[j].y)<1e-4,`${d.file}: broken junction`);
   }
   const pa=original.pins.flat(),pb=snapped.pins.flat();
   let pinConnections=0;
   for(let i=0;i<pa.length;i++) for(let j=0;j<i;j++) if(Math.hypot(pa[i].x-pa[j].x,pa[i].y-pa[j].y)<1e-4){
    pinConnections++; assert(Math.hypot(pb[i].x-pb[j].x,pb[i].y-pb[j].y)<1e-4,`${d.file}: broken pin connection ${JSON.stringify({i,j,a:pa[i],b:pa[j],afterA:pb[i],afterB:pb[j]})}`);
   }
   const result={file:d.file,ordinal:d.ordinal,count:snapped.components.length,connections,pinConnections,status:snapped.status};
   results.push(result); console.log(JSON.stringify(result));
   if(/(?:op|en) amp|transformer/.test(d.source)){
    await page.evaluate(()=>{window.mainController.circuitComponents.forEach(c=>{c.isSelected=false;c.viewSelected(false)});window.mainController.canvasController.fitView()});
    await page.screenshot({path:path.join(out,/(?:op|en) amp/.test(d.source)?'op-amp.png':'transformer.png')});
   }
  }
  // Exercise the visible import dialog as well as the bulk handler calls above.
  await page.evaluate(()=>document.getElementById('importModal').dispatchEvent(new Event('hidden.bs.modal')));
  const importShown=page.evaluate(()=>new Promise(resolve=>document.getElementById('importModal').addEventListener('shown.bs.modal',resolve,{once:true})));
  await page.locator('#importButton').click();
  await importShown;
  await page.locator('#importTikzContent').waitFor({state:'visible'});
  await page.locator('#importExampleButton').click();
  await page.locator('#importCheckGrid').check();
  await page.locator('#importTikzButton').click();
  await page.locator('#importModal').waitFor({state:'hidden'});
  await page.locator('#exportSVGButton').click();
  await page.waitForFunction(()=>document.getElementById('exportedContent').value.includes('<svg'));
  const svg=await page.locator('#exportedContent').inputValue();
  assert(svg.includes('</svg>'));
  const checks=['grid on/off','shared endpoints and electrical pins','Undo/Redo import','scope translation','numeric scale with transform shape','ellipse radii','chained node text anchor','360 degree arc','independent picture styles','TikZ export/reimport','fit view bounds','mouse endpoint drag Undo/Redo','visible import dialog','SVG export'];
  fs.writeFileSync(path.join(out,'imports.json'),JSON.stringify({totalDiagrams:diagrams.length,checks,results,errors},null,2));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(`PASS: ${results.length} diagrams; ${diagrams.length} discovered; grid and connectivity assertions passed.`);
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
