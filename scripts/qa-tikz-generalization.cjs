const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function ({ call, page, sessionId, out, corpus, preamble }) {
  const checks = [], compilations = [];
  const check = name => { checks.push(name); console.log('PASS:', name); };
  const read = async () => (await call('designer_get_document', { sessionId })).data;
  async function imported(source, options = {}) {
    const doc = await read();
    const r = await call('designer_import_tikz', { sessionId, expectedRevision: doc.revision, source, preamble: '', replace: true, snapToGrid: false, ...options });
    assert(!r.error, r.message); return r.data;
  }
  async function exported(format = 'tikz') {
    const r = await call('designer_export', { sessionId, format }); assert(!r.error, r.message); return r.data;
  }
  async function operation(operations) {
    const doc = await read(), r = await call('designer_apply_operations', { sessionId, expectedRevision: doc.revision, operations });
    assert(!r.error, r.message); return r.data;
  }
  const picture = body => '\\begin{tikzpicture}' + body + '\\end{tikzpicture}';
  const raw = '% keep this comment\r\n' + picture(String.raw`\draw (0,0)--(1,0);`);
  let doc = await imported(raw);
  assert.equal((await exported('source')).content, raw);
  assert(doc.sourceStatus.matchesCanvas);
  const initial = doc.saveFile;
  await operation([{ op: 'move', ids: [doc.components[0].id], dx: 10, dy: 0, unit: 'px' }]);
  doc = await read(); assert(!doc.sourceStatus.matchesCanvas);
  assert.equal((await exported('source')).content, raw);
  let history = await call('designer_history', { sessionId, expectedRevision: doc.revision, action: 'undo' });
  assert(!history.error, history.message); assert.deepEqual(history.data.saveFile, initial);
  assert((await read()).sourceStatus.matchesCanvas);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), { timeout: 60000 });
  // A refresh creates a new session identity. The caller resolves it via status.
  sessionId = (await call('designer_status')).data.sessions[0].sessionId;
  assert.equal((await exported('source')).content, raw);
  check('Source bytes, edit status, undo and browser reload preserve the archive');

  const fullDocument = await read();
  const compact = (await call('designer_get_document', { sessionId, includeComponents: false, includeSaveFile: false })).data;
  assert.equal(compact.revision, fullDocument.revision); assert.equal(compact.componentCount, 1);
  assert.equal(compact.components, undefined); assert.equal(compact.saveFile, undefined);
  assert.deepEqual(compact.sourceStatus, fullDocument.sourceStatus);
  const staleExport = await call('designer_export', { sessionId, expectedRevision: 'stale', format: 'tikz' });
  assert(staleExport.error && staleExport.message.includes('Revision conflict'));
  const staleCompile = await call('designer_compile', { sessionId, expectedRevision: 'stale', includePreview: false });
  assert(staleCompile.error && staleCompile.message.includes('Revision conflict'));
  check('Compact document reads preserve revision and source status; stale exports and compilations are refused');
  const catalogue = (await call('designer_list_symbols', { sessionId, limit: 1 })).data;
  const generic = catalogue.shapeExamples.filter(example => ['arc','bezier','plot'].includes(example.type));
  assert.equal(generic.length, 3);
  await operation(generic.map(component => ({ op: 'create', component })));
  assert.equal((await read()).componentCount, 4);
  check('MCP catalogue supplies usable native arc, Bezier and formula-curve examples');

  doc = await imported(picture(String.raw`\begin{scope}[shift={(2,1)},rotate=90]\draw (0,0)--(1,0);\end{scope}`));
  const points = doc.components[0].save.points;
  assert(Math.abs(points[0].x / (96 / 2.54) - 2) < .001 && Math.abs(points[0].y / (96 / 2.54) + 1) < .001);
  assert(Math.abs(points[1].x / (96 / 2.54) - 2) < .001 && Math.abs(points[1].y / (96 / 2.54) + 2) < .001);
  check('Scope translation and rotation compose in TikZ coordinates');

  doc = await imported(String.raw`\begin{tikzpicture}[>=Stealth,font=\small]\node[blue,above right] at (0,0) {自然宽度标签};\end{tikzpicture}`);
  assert.equal(doc.components[0].save.type, 'simpleText');
  assert.equal(doc.components[0].save.color, '#0000ff');
  assert.equal(doc.components[0].save.fontSize, 'small');
  check('Global arrow defaults do not turn colored text into wrapped rectangles');
  doc = await imported(picture(String.raw`\draw (0,0)--(4,0) node[midway,above] {M};\draw (0,0) .. controls (1,2) and (2,2) .. (3,0) node[midway,above] {B};\draw (1,0) arc (0:90:1) node[midway,above] {A};`));
  const label = text => doc.components.find(c => c.save.text === text).save.position;
  assert(Math.abs(label('M').x / (96 / 2.54) - 2) < .001);
  assert(Math.abs(label('B').x / (96 / 2.54) - 1.5) < .001 && Math.abs(label('B').y / (96 / 2.54) + 1.5) < .001);
  assert(Math.abs(label('A').x / (96 / 2.54) - Math.SQRT1_2) < .001);
  check('Explicit midpoint labels use the line, cubic or circular path geometry');

  doc = await imported(picture(String.raw`\draw[->] (1,0) arc (0:90:1);\draw[->] (3,0) arc (0:-90:1);\draw[->] (0,3) to[bend left=45] (2,3);\draw[->] (0,5) to[bend right=45] (2,5);`));
  assert.deepEqual(doc.components.map(c => c.save.bend ?? 45), [-45, 45, 45, -45]);
  const arcMidpoints = await page.evaluate(() => window.mainController.circuitComponents.map(c => {
    const p = c.quadraticPoint(.5).point; return { x: p.x / (96 / 2.54), y: p.y / (96 / 2.54) };
  }));
  assert(Math.abs(arcMidpoints[0].x - Math.SQRT1_2) < .001 && Math.abs(arcMidpoints[0].y + Math.SQRT1_2) < .001);
  assert(Math.abs(arcMidpoints[1].x - 2 - Math.SQRT1_2) < .001 && Math.abs(arcMidpoints[1].y - Math.SQRT1_2) < .001);
  assert(arcMidpoints[2].y < -3 && arcMidpoints[3].y > -5);
  const arcExport = (await exported()).content;
  assert.equal((arcExport.match(/bend right=45/g) || []).length, 2);
  assert.equal((arcExport.match(/bend left=45/g) || []).length, 2);
  for (const representation of ['canvas', 'source']) {
    const outputPath = path.join(out, 'arc-direction-' + representation + '.pdf');
    const result = await call('designer_compile', { sessionId, representation, includePreview: true, outputPath });
    assert(!result.error, result.message);
    compilations.push({ file: 'circular and bent arc directions', representation, success: result.data.success, outputPath });
    const png = result.response.content.find(c => c.type === 'image');
    fs.writeFileSync(path.join(out, 'arc-direction-' + representation + '.png'), Buffer.from(png.data, 'base64'));
  }
  doc = await imported(arcExport);
  assert.deepEqual(doc.components.map(c => c.save.bend ?? 45), [-45, 45, 45, -45]);
  check('Clockwise, counterclockwise and bent arcs retain their side in the canvas, export and reimport');


  doc = await imported(picture(String.raw`\draw (0,0) .. controls (1,2) and (2,2) .. (3,0);`));
  const controls = doc.components[0].save.points.slice(2), bezierId = doc.components[0].id;
  await operation([{ op: 'set_endpoints', ids: [bezierId], end: { x: 4, y: 0 }, unit: 'cm' }]);
  doc = await read(); assert.deepEqual(doc.components[0].save.points.slice(2), controls);
  assert(Math.abs(doc.components[0].save.points[1].x / (96 / 2.54) - 4) < .001);
  assert((await exported()).content.includes('controls'));
  check('Bezier endpoint edits preserve separate native controls');

  doc = await imported(picture(String.raw`\draw[red,domain=0:180,samples=100] plot ({\x/45},{2.4*sin(\x)});`));
  assert.equal(doc.components[0].save.type, 'plot');
  await operation([{ op: 'move', ids: [doc.components[0].id], dx: 1, dy: 2, unit: 'cm' }, { op: 'rotate', ids: [doc.components[0].id], angle: 20 }]);
  const moved = (await read()).components[0].save.points;
  const plotExport = (await exported()).content;
  assert(plotExport.includes('plot') && plotExport.includes('sin('));
  doc = await imported(plotExport);
  assert.equal(doc.components[0].save.points.length, moved.length);
  doc.components[0].save.points.forEach((p, i) => assert(Math.hypot(p.x - moved[i].x, p.y - moved[i].y) < .03));
  await operation([{ op: 'set_properties', ids: [doc.components[0].id], values: { 'plot:1': '1.2*sin(\\x)' } }]);
  assert((await exported()).content.includes('1.2*sin('));
  check('Formula curves retain expressions through movement, rotation, reimport and property edits');

  const opaque = picture(String.raw`\pic {custom figure};`);
  doc = await imported(opaque, { mode: 'source' });
  assert.equal(doc.components.length, 0); assert(doc.sourceStatus.sourceOnly);
  assert.equal((await exported('source')).content, opaque);
  assert((await call('designer_export', { sessionId, format: 'tikz' })).error);
  check('Unsupported documents remain intact in explicit source mode');
  await imported(picture(String.raw`\clip (0,0) circle (1);\fill[blue] (-2,-2) rectangle (2,2);`), { mode: 'source' });
  const sourceCompile = await call('designer_compile', { sessionId, representation: 'source', engine: 'xelatex', includePreview: true, outputPath: path.join(out, 'source-mode.pdf') });
  assert(!sourceCompile.error, sourceCompile.message);
  assert(sourceCompile.response.content.some(c => c.type === 'image'));
  check('Source-mode documents compile through the real TeX engine');

  const template = path.join(corpus, 'assignment_phasors.tex');
  if (fs.existsSync(template)) {
    for (const [i, values] of [[7.9150935, 38.5985106, 1, 1.225374], [16, 52.8698976, 1, 1.6], [18.9373682, 42.011286, .956521739, 1.45875885]].entries()) {
      doc = await imported(fs.readFileSync(template, 'utf8') + '\n\\assignmentphasor' + values.map(v => '{' + v + '}').join(''), { preamble });
      assert(doc.components.length > 10);
      assert(!JSON.stringify(doc.saveFile.components).includes('#1'));
      for (const representation of ['canvas', 'source']) {
        const outputPath = path.join(out, `template-${i + 1}-${representation}.pdf`);
        const compiled = await call('designer_compile', { sessionId, representation, includePreview: false, outputPath });
        assert(!compiled.error, compiled.message);
        compilations.push({ file: `assignment_phasors invocation ${i + 1}`, representation, success: compiled.data.success, outputPath });
      }
      check('Parameterized phasor invocation ' + (i + 1));
    }
  }

  // Each editable export must really compile; archive compilation is checked on
  // representative sources to distinguish source rendering from model rendering.
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  for (const sample of manifest.samples) {
    const source = fs.readFileSync(path.join(out, sample.id, 'input.tikz'), 'utf8');
    await imported(source, { allowWarnings: true }); // Warnings were recorded during the audit, including the disclosed ex approximation.
    const representations = /power_angle|winding_connection_table|synchronous_phasor/.test(sample.file) ? ['canvas', 'source'] : ['canvas'];
    for (const representation of representations) {
      const dir = path.join(out, sample.id, 'compiled'); fs.mkdirSync(dir, { recursive: true });
      const outputPath = path.join(dir, representation + '.pdf');
      const result = await call('designer_compile', { sessionId, representation, engine: 'xelatex', includePreview: representations.length === 2, outputPath });
      let data; try { data = result.data || JSON.parse(result.message); } catch { data = { diagnostics: result.message }; }
      const row = { file: sample.file, representation, success: !result.error && data.success, diagnostics: data.diagnostics, outputPath };
      compilations.push(row);
      const png = result.response?.content.find(c => c.type === 'image');
      if (png) fs.writeFileSync(path.join(dir, representation + '.png'), Buffer.from(png.data, 'base64'));
      fs.writeFileSync(path.join(out, 'compile-results.json'), JSON.stringify(compilations, null, 2));
      console.log(`COMPILE ${sample.file} ${representation}: ${row.success}`);
    }
  }
  assert(compilations.every(c => c.success), JSON.stringify(compilations.filter(c => !c.success)));
  check('Every editable corpus export compiles; representative archives compile independently');

  await imported(picture(String.raw`\foreach \k in {1,...,200}{\draw (0,\k)--(2,\k);}\draw[domain=0:180,samples=500] plot ({\x/45},{sin(\x)});`));
  const timings = { full: [], compact: [] }, payload = {};
  for (let i=0; i<6; i++) for (const mode of (i%2 ? ['compact','full'] : ['full','compact'])) {
    const start = performance.now();
    const result = await call('designer_get_document', { sessionId, ...(mode==='compact' ? { includeComponents:false, includeSaveFile:false } : {}) });
    assert(!result.error,result.message);
    timings[mode].push(performance.now()-start); payload[mode] = Buffer.byteLength(JSON.stringify(result.data));
    assert.equal(result.data.componentCount,201);
  }
  assert(payload.compact < payload.full/10);
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const performanceReport = { method:'Real MCP SDK stdio and isolated Edge, 200 wires plus a 500-sample curve; six alternating reads per mode.',
    fullBytes:payload.full, compactBytes:payload.compact, fullMedianMs:median(timings.full), compactMedianMs:median(timings.compact), timings };
  fs.writeFileSync(path.join(out,'mcp-read-performance.json'),JSON.stringify(performanceReport,null,2));
  check('Compact MCP reads reduce actual large-document payloads without changing the component count');
  return { checks, compilations };
};
