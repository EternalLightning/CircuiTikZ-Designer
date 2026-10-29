const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function({call, page, sessionId, out, wrapper, compile}) {
 const checks = [];
 const check = name => {checks.push(name);};
 async function imported(source,snapToGrid=false) {
  const doc=(await call('designer_get_document',{sessionId})).data;
  const r=await call('designer_import_tikz',{sessionId,expectedRevision:doc.revision,source,replace:true,snapToGrid});
  assert(!r.error,r.message);return r.data;
 }
 async function exported(){return (await call('designer_export',{sessionId,format:'tikz'})).data.content;}
 const environment = body => '\\begin{circuitikz}\n'+body+'\n\\end{circuitikz}';
 let doc=await imported(environment(String.raw`\draw (0,0)--(1,0) (3,2)--(4,2);`));
 assert.equal(doc.components.length,2);
 assert(doc.components.every(c=>c.save.points[0].y===c.save.points[1].y));
 check('Disconnected subpaths remain separate wires');
 doc=await imported(environment(String.raw`\draw (0,0)--(1,0)--(1,1)--cycle (3,0)--(4,0)--(4,1)--cycle;`));
 assert.equal(doc.components.length,2);
 for(const c of doc.components)assert.deepEqual(c.save.points[0],c.save.points.at(-1));
 check('Each cycle closes its own subpath and parsing continues');

 for(const symbol of ['R','european voltage source'])for(const key of ['i^>','i_>','i>^','i>_','i^<','i_<','i<^','i<_']) {
  doc=await imported(environment(`\\draw (0,0) to[${symbol},${key}=$I$] (3,0);`));
  const c=doc.components[0].save.current;
  assert.equal(c.backwards??false,key.includes('<'));
  assert.equal(c.below??false,key.includes('_'));
  assert.equal(c.start,key.indexOf('>')===1 || key.indexOf('<')===1);
  const text=await exported();assert(text.includes(key+'=$I$'),text);
  const roundtrip=await imported(text);assert.deepEqual(roundtrip.components[0].save.current,c);
  check(symbol+' '+key+' direction/position/export/reimport');
 }

 const matrix=[];
 for(const convention of ['old','noold','RP','EF'])for(const invert of [false,true]) {
  doc=await imported(environment(`\\draw (0,0) to[american voltage source,voltage dir=${convention}${invert?',invert':''}] (3,0);`));
  const expected=(['old','RP'].includes(convention)?-1:1)*(invert?-1:1);
  const actual=await page.evaluate(()=>Math.sign(window.mainController.circuitComponents[0].scaleState.x));
  assert.equal(actual,expected,'Internal source sign convention');
  assert.equal(doc.components[0].save.voltage.convention,convention);
  const text=await exported();assert.equal(/, invert(?:,|\])/.test(text),invert,text);
  await imported(text);
  assert.equal(await page.evaluate(()=>Math.sign(window.mainController.circuitComponents[0].scaleState.x)),expected);
  check('American source '+convention+' invert='+invert+' internal signs/save/export/reimport');
 }
 let row=0;
 for(const symbol of ['R','european voltage source'])for(const convention of ['old','noold','RP','EF'])for(const direction of ['>','<'])for(const vertical of [false,true]) {
  const body=`\\draw (0,0) to[${symbol},voltage dir=${convention},v^${direction}=$U$,voltage=american] ${vertical?'(0,3)':'(3,0)'};`;
  await imported(environment(body));
  const sign=await page.evaluate(()=>{
   const m=window.mainController,c=m.circuitComponents[0],paths=Array.from(c.voltageArrowRendering.find('path'));
   const plus=paths.find(p=>p.attr('d')==='M0 4.5 H9 M4.5 0V9');
   const minus=paths.find(p=>p.attr('d')==='M0 4.5 H9');
   if(!plus||!minus)return null;
   const a=plus.rbox(m.canvasController.canvas),b=minus.rbox(m.canvasController.canvas),p=c.getReferencePoints();
   return (a.cx-b.cx)*(p[1].x-p[0].x)+(a.cy-b.cy)*(p[1].y-p[0].y);
  });
  assert(sign!==null && Number.isFinite(sign),'Missing voltage signs');
  const reversed=direction==='<';
  const conventionReverses=symbol==='R'?['old','RP'].includes(convention):['RP','EF'].includes(convention);
  assert.equal(sign>0,reversed!==conventionReverses,body+' sign projection='+sign);
  const text=await exported();assert(text.includes('voltage dir='+convention));
  check(symbol+' '+convention+' v'+direction+' '+(vertical?'vertical':'horizontal')+' actual SVG polarity');
  if(!vertical){
   const y=-row*2.2;
   matrix.push(`\\node[anchor=east] at (-0.5,${y}) {${symbol==='R'?'R':'V'} ${convention} ${direction==='>'?'forward':'backward'}};`);
   matrix.push(`\\draw (0,${y}) to[${symbol},voltage dir=${convention},v^${direction}=$U$,voltage=american] (3,${y});`);
   row++;
  }
 }

 const graph=environment(String.raw`\node[circle,draw,inner sep=1.6pt] (a) at (0.137,0.263) {$1$};
\node[circle,draw,inner sep=1.6pt] (b) at (2.337,2.263) {$2$};\draw (a)--(b);`);
 const graphBefore=await imported(graph,false),graphAfter=await imported(graph,true);
 assert.deepEqual(graphAfter.saveFile.components.map(c=>c.points??c.position),graphBefore.saveFile.components.map(c=>c.points??c.position));
 check('Clipped circular contacts stay attached with grid alignment');
 const curve=environment(String.raw`\draw (0.13,0.23) .. controls (0.7,2.1) and (2.2,2.7) .. (3.13,0.73);`);
 const curveBefore=await imported(curve,false),curveAfter=await imported(curve,true);
 assert.equal(curveAfter.components[0].save.type,'bezier');
 assert.equal(curveAfter.components[0].save.points.length,4);
 assert.deepEqual(curveAfter.components[0].save.points,curveBefore.components[0].save.points);
 check('Native cubic controls survive grid import unchanged');
 const exportedCurve=await exported();
 const curveRoundtrip=await imported(exportedCurve,true);
 assert.equal(curveRoundtrip.components[0].save.type,'bezier');
 assert.equal(curveRoundtrip.components[0].save.points.length,curveAfter.components[0].save.points.length);
 curveRoundtrip.components[0].save.points.forEach((p,i)=>{
  const previous=curveAfter.components[0].save.points[i];
  assert(Math.abs(p.x-previous.x)<.03 && Math.abs(p.y-previous.y)<.03,'Curve export precision');
 });
 check('Exported cubic controls retain geometry on grid reimport');
 doc=await imported(environment(String.raw`\fill (0,0) circle (1.2pt);`));
 assert((await exported()).includes('inner sep=0pt'));
 assert(doc.components[0].save.size.x<4);
 check('Small filled dots keep explicit zero node padding');
 doc=await imported(environment(String.raw`\draw (0,0) to[R,i_>=$I$,current/distance=0,v^>=$U$,voltage/distance from node=0,voltage/bump b=0] (3,0);`));
 assert.equal(doc.components[0].save.current.dist,0);assert.equal(doc.components[0].save.voltage.dist,0);assert.equal(doc.components[0].save.voltage.bump,0);
 check('Zero current/voltage distances and zero voltage bump survive import');
 doc=await imported(String.raw`\usepackage[europeanresistors,americaninductor]{circuitikz}
\newcommand{\s}{0.9}\begin{circuitikz}[scale=\s,transform shape]\draw (0,0) to[R] (3,0) to[L] (3,2);\end{circuitikz}`);
 assert.equal(doc.components[0].save.id,'european resistor');
 assert.equal(doc.components[1].save.id,'american inductor');
 assert(Math.abs(doc.components[0].save.points[1].x-2.7*96/2.54)<.001);
 check('Supplied numeric macro and singular package styles are applied');
 for(const anchor of ['west','east','north','south','north east','south west']) {
  doc=await imported(environment(`\\node[anchor=${anchor}] at (1,2) {Long natural width label};`));
  assert.equal(doc.components[0].save.type,'simpleText');
  const text=await exported();assert(!text.includes('text width'));assert(text.includes('anchor='+anchor));
  const roundtrip=await imported(text);assert.equal(roundtrip.components[0].save.anchor,anchor);
  check('Natural-width '+anchor+' label preserves anchor without forced wrapping');
 }
 const matrixSource=environment(matrix.join('\n'));
 await imported(matrixSource);
 const matrixDir=path.join(out,'voltage-matrix');fs.mkdirSync(matrixDir,{recursive:true});
 fs.writeFileSync(path.join(matrixDir,'original.tex'),wrapper(matrixSource));
 fs.writeFileSync(path.join(matrixDir,'export.tex'),wrapper(await exported()));
 const preview=await call('designer_preview',{sessionId,maxDimension:2048,showGrid:false});
 fs.writeFileSync(path.join(matrixDir,'preview.png'),Buffer.from(preview.response.content.find(c=>c.type==='image').data,'base64'));
 const originalCompile=compile(matrixDir,'original'),exportCompile=compile(matrixDir,'export');
 assert(originalCompile.ok&&exportCompile.ok,'Voltage matrix must compile');
 check('16-case voltage matrix original and exported LaTeX compile');
 fs.writeFileSync(path.join(out,'semantics.json'),JSON.stringify({passed:checks.length,checks,originalCompile,exportCompile},null,2));
 console.log('PASS:',checks.length,'visual semantics checks');
 return checks;
};
