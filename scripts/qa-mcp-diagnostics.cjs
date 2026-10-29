const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
module.exports=async({call,read,page,sessionId,out,rawCall})=>{
 const checks=[],cm=96/2.54;
 const check=name=>{checks.push(name);console.log('PASS diagnostics:',name);};
 const near=(a,b)=>assert(Math.abs(a-b)<.003,`${a} != ${b}`);
 const reset=async body=>call('designer_import_tikz',{sessionId,expectedRevision:(await read()).revision,source:'\\begin{circuitikz}\n'+body+'\n\\end{circuitikz}',replace:true,snapToGrid:false});
 const apply=async(operations,extra={})=>call('designer_apply_operations',{sessionId,expectedRevision:(await read()).revision,operations,...extra});
 const layout=async(args={})=>call('designer_check_layout',{sessionId,...args});
 const rawApply=async(operations,extra={})=>{
  const response=await rawCall('designer_apply_operations',{sessionId,expectedRevision:(await read()).revision,operations,...extra});
  assert(!response.isError,JSON.stringify(response));return {response,result:JSON.parse(response.content.find(c=>c.type==='text').text)};
 };
 const connected=String.raw`\draw (0,0) to[R,l=$R_1$] (3,0);\draw (-1,0)--(0,0);\draw (3,0)--(4,0);`;
 let doc=await reset(connected),id=doc.components[0].id;
 let inspected=await layout();assert(inspected.coverage.complete,JSON.stringify(inspected));assert.equal(inspected.connections.total,2);assert.equal(inspected.overlaps.total,0);assert.equal(inspected.crossings.total,0);
 assert.equal((await read()).revision,doc.revision);await call('designer_check_layout',{sessionId,ids:['missing']},true);
 check('Normal component terminal contacts are connections, not overlaps; inspection is read-only');
 let moved=await apply([{op:'move',ids:[id],dx:0,dy:1,unit:'cm',connections:'follow_wires'}]);
 assert(moved.diagnostics.complete,JSON.stringify(moved.diagnostics));assert.deepEqual(moved.diagnostics.connections.counts,{preserved:2,removed:0,added:0});
 assert(moved.diagnostics.connections.preserved.every(c=>c.before.key===c.after.key&&c.before.point.y!==c.after.point.y));
 check('Moved connected parts retain relationship identity despite new coordinates');
 doc=await reset(connected);id=doc.components[0].id;
 const before=await read(),stored=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const m=window.mainController,r=m.db.transaction('tabs').objectStore('tabs').get(m.tabID);r.onsuccess=()=>resolve(r.result.data);r.onerror=()=>reject(r.error);}));
 const persisted=await stored();
 const dry=await rawApply([{op:'move',ids:[id],dx:0,dy:1,unit:'cm',connections:'detach'}],{dryRun:true});
 assert.equal(dry.result.diagnostics.connections.counts.removed,2);assert.equal(dry.result.preview.state,'proposed');assert.equal(dry.result.preview.baseRevision,before.revision);assert(!('revision' in dry.result.preview));assert(!('data' in dry.result.preview));
 const image=dry.response.content.find(c=>c.type==='image');assert(image&&image.mimeType==='image/png');
 fs.writeFileSync(path.join(out,'dry-run-preview.png'),Buffer.from(image.data,'base64'));
 fs.writeFileSync(path.join(out,'dry-run-report.json'),JSON.stringify(dry.result,null,2));
 assert.deepEqual((await read()).saveFile,before.saveFile);assert.equal((await read()).revision,before.revision);assert.deepEqual(await stored(),persisted);
 near(dry.result.proposed.components[0].positionCm.y,1);
 const actualPreview=await call('designer_preview',{sessionId,showGrid:false});assert.notEqual(actualPreview.content.find(c=>c.type==='image').data,image.data);
 check('Dry-run returns a proposed PNG, removed-contact overlay and diagnostics without live/persistent mutation');
 const detached=await apply([{op:'move',ids:[id],dx:0,dy:1,unit:'cm'}]);
 assert.deepEqual(detached.diagnostics.connections.counts,dry.result.diagnostics.connections.counts);
 check('Committed and dry-run connection changes agree');
 doc=await reset(connected+String.raw`\draw (100,0)--(101,0);`);
 const wide=await rawApply([{op:'delete',ids:[doc.components[0].id,doc.components[1].id]}],{dryRun:true});
 const frame=wide.result.preview;
 for(const removed of wide.result.diagnostics.connections.removed){const x=(removed.point.x-frame.viewBox.x)*frame.width/frame.viewBox.width,y=(removed.point.y-frame.viewBox.y)*frame.height/frame.viewBox.height;assert(x>=6&&x<=frame.width-6&&y>=6&&y<=frame.height-6,'Diagnostic circle must fit its raster frame');}
 check('Old disconnected locations remain visible with unclipped markers in wide scaled-down previews');
 doc=await reset(connected);
 const noImage=await rawApply([{op:'move',ids:[doc.components[0].id],dx:1,dy:0}],{dryRun:true,includePreview:false,analyze:false});
 assert(!noImage.response.content.some(c=>c.type==='image'));assert(!noImage.result.preview);assert(!noImage.result.diagnostics);
 check('Preview/analysis can be explicitly omitted');

 doc=await reset(String.raw`\draw (0,0)--(3,0);\draw (4,0)--(6,0);`);
 let result=await apply([{op:'move',ids:[doc.components[1].id],dx:-1,dy:0,unit:'cm'}]);assert.equal(result.diagnostics.connections.counts.added,1);assert.equal(result.diagnostics.overlaps.counts.added,0);
 check('New endpoint contact is added without a false positive wire overlap');
 doc=await reset(String.raw`\draw (0,0)--(3,0);\draw (4,0)--(6,0);`);
 result=await apply([{op:'move',ids:[doc.components[1].id],dx:-2,dy:0,unit:'cm'}]);
 assert(result.diagnostics.overlaps.added.some(item=>item.kind==='wire-overlap'));
 const wireHit=(await layout()).overlaps.items.find(item=>item.kind==='wire-overlap');assert(wireHit.segments.length);near(Math.abs(wireHit.segments[0][1].x-wireHit.segments[0][0].x),cm);
 result=await apply([{op:'move',ids:[doc.components[1].id],dx:0,dy:1,unit:'cm'}]);assert.equal(result.diagnostics.overlaps.counts.removed,1);
 check('Positive-length collinear wire overlap is reported with geometry, then reported resolved');
 doc=await reset(String.raw`\draw (-2,0)--(2,0);\draw (0,-2)--(0,2);`);
 inspected=await layout();assert.equal(inspected.connections.total,0);assert.equal(inspected.overlaps.total,0);assert.equal(inspected.crossings.total,1);
 const overlay=await call('designer_preview',{sessionId,showGrid:false,showDiagnostics:true});
 assert.equal(JSON.parse(overlay.content.find(c=>c.type==='text').text).diagnostics.crossings.total,1);
 check('Bare wire crossing stays ambiguous instead of being declared a connection or overlap');
 await reset(String.raw`\draw (-2,0)--(2,0);\draw (0,-2)--(0,2);\node[circ] at (0,0) {};`);
 inspected=await layout();assert.equal(inspected.crossings.total,0);assert.equal(inspected.overlaps.total,0);assert.equal(inspected.connections.total,2);
 check('An explicit junction dot yields pin-to-wire contacts without false dot overlap/crossing');
 await reset(String.raw`\draw (0,0) -| (2,2);\draw (2,0.5)--(2,1.5);`);
 assert((await layout()).overlaps.items.some(item=>item.kind==='wire-overlap'));
 check('Orthogonal wire implicit elbow geometry participates in overlap checks');

 doc=await reset(String.raw`\draw (0,0) to[R,l=$A$] (3,0);\draw (0,2) to[R,l=$B$] (3,2);`);
 inspected=await layout();assert.equal(inspected.overlaps.total,0);
 result=await apply([{op:'move',ids:[doc.components[1].id],dx:0,dy:-2,unit:'cm'}]);
 assert(result.diagnostics.overlaps.added.some(item=>item.kind==='component-bounds-overlap'));
 assert(result.diagnostics.overlaps.added.every(item=>item.confidence.includes('potential')));
 check('Coincident component bodies are identified by stable ids and marked as potential bounds overlap');
 doc=await reset(String.raw`\draw (0,0) to[R] (3,0);\draw (1.5,-1)--(1.5,1);`);
 inspected=await layout();assert(inspected.overlaps.items.some(item=>item.kind==='wire-component-overlap'));assert.equal(inspected.connections.total,0);
 const highlighted=await call('designer_preview',{sessionId,showGrid:false,showDiagnostics:true});
 fs.writeFileSync(path.join(out,'layout-overlap-preview.png'),Buffer.from(highlighted.content.find(c=>c.type==='image').data,'base64'));
 check('Wire through component body is a potential collision, not a pin connection');
 const limited=await layout({limit:1});assert.equal(limited.overlaps.items.length,1);assert(limited.overlaps.total>=1);
 assert((await layout({ids:[doc.components[0].id]})).overlaps.items.every(hit=>hit.ids.includes(doc.components[0].id)));
 check('Layout checks support explicit target scope and bounded detail counts');
 await reset(String.raw`\draw (0,0)--(4,0);\draw (1,0)--(5,0);\draw (2,0)--(6,0);`);
 const capped=await layout({limit:1});assert.equal(capped.overlaps.total,3);assert.equal(capped.overlaps.items.length,1);assert(capped.overlaps.truncated);
 check('Truncated detail lists retain full overlap totals');

 // Two parallel rotated bodies with overlapping axis-aligned boxes but disjoint
 // oriented boxes must not collide. Move perpendicular to the 45-degree path.
 await reset(String.raw`\draw (0,0) to[R] (3,3);\draw (-0.7,0.7) to[R] (2.3,3.7);`);
 assert.equal((await layout()).overlaps.total,0);
 check('Rotated-body separation avoids axis-aligned bounding-box false positives');
 await reset(String.raw`\draw (0,0) to[R] (3,0);\node at (1.5,0) {label overlapping the body};`);
 assert.equal((await layout()).overlaps.total,0);
 check('Pure label text is explicitly excluded from component body collision checks');

 doc=await reset(connected);id=doc.components[0].id;
 await page.evaluate(id=>{const node=window.mainController.circuitComponents.find(c=>c.automationId===id).componentVisualization.node;window.__qaBody=node;window.__qaBBox=node.getBBox;node.getBBox=()=>{throw new Error('Simulated unavailable body geometry');};},id);
 try{const incomplete=await layout();assert(!incomplete.coverage.complete);assert(incomplete.coverage.skippedBodyIds.includes(id));}
 finally{await page.evaluate(()=>{window.__qaBody.getBBox=window.__qaBBox;delete window.__qaBody;delete window.__qaBBox;});}
 check('Unavailable body geometry is disclosed as incomplete coverage');

 doc=await reset(connected);id=doc.components[0].id;const beforeFailure=await read();
 await page.evaluate(()=>{window.__qaOriginalImage=window.Image;window.Image=class extends window.__qaOriginalImage{set src(value){setTimeout(()=>this.onerror?.(new Event('error')),0);}get src(){return '';}};});
 try{const failure=await rawApply([{op:'move',ids:[id],dx:1,dy:0}],{dryRun:true});assert(failure.result.previewWarning);assert(!failure.response.content.some(c=>c.type==='image'));assert.deepEqual((await read()).saveFile,beforeFailure.saveFile);assert.equal((await read()).revision,beforeFailure.revision);}
 finally{await page.evaluate(()=>{window.Image=window.__qaOriginalImage;delete window.__qaOriginalImage;});}
 check('Proposed PNG decode failure returns a warning after restoring the original state');

 doc=await reset(connected);const budgetBefore=await read();
 const large=Array.from({length:450},(_,i)=>({type:'wire',points:[{x:i*10,y:500},{x:i*10+3,y:500}],directions:['--']}));
 const budget=await apply([{op:'create',component:{type:'group',components:large}}],{dryRun:true,includePreview:false});
 assert(!budget.diagnostics.complete);assert(!budget.diagnostics.connections);assert.match(budget.diagnostics.after.reason,/budget/i);assert.deepEqual((await read()).saveFile,budgetBefore.saveFile);
 check('Analysis budget exhaustion withholds added/removed conclusions instead of claiming absence');

 // Delay proposed image decoding and make a real UI-model edit during that wait.
 // The proposed state must already be restored when rendering starts.
 doc=await reset(connected);id=doc.components[0].id;
 await page.evaluate(()=>{
  window.__qaOriginalImage=window.Image;window.__qaImagePending=false;
  window.Image=class extends window.__qaOriginalImage {set src(value){window.__qaImagePending=true;setTimeout(()=>{super.src=value;},300);}get src(){return super.src;}};
 });
 try{
  const pending=rawCall('designer_apply_operations',{sessionId,expectedRevision:doc.revision,operations:[{op:'move',ids:[id],dx:0,dy:1,unit:'cm'}],dryRun:true});
  await page.waitForFunction(()=>window.__qaImagePending);
  const liveY=await page.evaluate(id=>{const c=window.mainController.circuitComponents.find(c=>c.automationId===id);const y=c.position.y;c.mathJaxLabel.updateValue('USER_EDIT_DURING_RENDER',true,true);return y;},id);
  near(liveY,0);const response=await pending;assert(!response.isError);
  assert.equal((await read()).components[0].save.label.value,'USER_EDIT_DURING_RENDER');
 } finally{await page.evaluate(()=>{window.Image=window.__qaOriginalImage;delete window.__qaOriginalImage;delete window.__qaImagePending;});}
 check('Proposed state is restored before async render; concurrent user edit is retained');
 fs.writeFileSync(path.join(out,'diagnostics-results.json'),JSON.stringify({passed:checks.length,checks},null,2));
 return {passed:checks.length,checks};
};
