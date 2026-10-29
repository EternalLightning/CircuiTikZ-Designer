const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {PassThrough} = require('node:stream');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.resolve(root, process.env.QA_OUTPUT_DIR || 'qa-results/mcp');
const fromMcp = file => import(pathToFileURL(path.join(root, 'mcp', file)).href);
let chromium;
try { ({chromium} = require('playwright')); }
catch { ({chromium} = require('../.qa-tools/node_modules/playwright')); }
const checks = [];
const check = name => { checks.push(name); console.log('PASS:', name); };
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.woff':'font/woff', '.woff2':'font/woff2'};
const dist = path.join(root, 'dist');
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  fs.mkdirSync(out, {recursive:true});
  if (!process.env.QA_APP_URL) await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const appUrl = process.env.QA_APP_URL || `http://127.0.0.1:${httpServer.address().port}/`;
  const {Client} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const client = new Client({name:'circuitikz-designer-qa', version:'1.0.0'});
  let mcpServer, bridge, transport, browser, context;
  const errors = [];
  const connectedInProcess = process.env.QA_MCP_IN_PROCESS === '1';
  if (connectedInProcess) {
    // Exercise the real SDK stdio server, JSON-RPC framing and schema validation,
    // without spawning a child when Windows sandbox pipe creation is unavailable.
    const {createBridge} = await fromMcp('bridge.mjs');
    const {createDesignerServer} = await fromMcp('server.mjs');
    const {StdioServerTransport} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
    const {ReadBuffer, serializeMessage} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js');
    bridge = await createBridge({port:0, appUrl});
    mcpServer = createDesignerServer(bridge);
    const input = new PassThrough(), output = new PassThrough(), buffer = new ReadBuffer();
    transport = {
      async start() { output.on('data', chunk => { buffer.append(chunk); let message; while ((message = buffer.readMessage()) !== null) this.onmessage?.(message); }); },
      async send(message) { input.write(serializeMessage(message)); },
      async close() { input.end(); output.end(); this.onclose?.(); },
    };
    await mcpServer.connect(new StdioServerTransport(input, output));
  } else {
    transport = new StdioClientTransport({command:process.execPath, args:[path.join(root, 'mcp', 'server.mjs')], env:{...process.env, MCP_BRIDGE_PORT:'0', MCP_APP_URL:appUrl}, stderr:'pipe'});
    transport.stderr.on('data', () => {}); // The server log contains a private connection token.
  }
  try {
    await client.connect(transport);
    const toolList = (await client.listTools()).tools;
    assert.equal(toolList.length, 16);
    for (const name of ['designer_find_components','designer_get_component','designer_get_connections','designer_select','designer_check_layout']) assert(toolList.some(tool=>tool.name===name));
    assert(toolList.every(tool => tool.inputSchema.type === 'object'));
    check('Official SDK MCP negotiation and tool schemas');
    async function call(name, args = {}, expectError = false) {
      const response = await client.callTool({name, arguments:args});
      const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (expectError) { assert(response.isError, `${name} should fail: ${text}`); return text; }
      assert(!response.isError, `${name}: ${text}`);
      return name === 'designer_preview' ? response : JSON.parse(text);
    }
    const initial = await call('designer_status');
    assert.equal(initial.sessions.length, 0);
    await call('designer_get_document', {sessionId:'missing'}, true);
    check('Disconnected status and explicit session routing');
    const connectUrl = new URL(initial.connectUrl);
    const token = new URLSearchParams(connectUrl.hash.slice(1)).get('mcpToken');
    const wsUrl = `ws://127.0.0.1:${connectUrl.searchParams.get('mcpPort')}/bridge`;
    const {WebSocket} = await fromMcp('node_modules/ws/wrapper.mjs');
    async function forbidden(origin, credential) {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl, ['circuitikz', credential], {origin});
        socket.on('open', () => { socket.close(); reject(new Error('Unauthorized bridge accepted')); });
        socket.on('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 403); response.resume(); socket.terminate(); resolve(); });
        socket.on('error', () => {});
      });
    }
    await forbidden(new URL(appUrl).origin, '0'.repeat(64));
    await forbidden('https://untrusted.example', token);
    check('Bridge rejects wrong tokens and foreign origins');
    browser = process.env.QA_CDP_URL ? await chromium.connectOverCDP(process.env.QA_CDP_URL) : await chromium.launch({channel:'msedge', headless:true});
    context = await browser.newContext({viewport:{width:1440, height:1000}});
    await context.route('**/www.googletagmanager.com/**', route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(initial.connectUrl, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), null, {timeout:60000});
    assert(!page.url().includes('mcpToken'));
    assert(!page.url().includes('mcpPort'));
    let sessions = (await call('designer_status')).sessions;
    assert.equal(sessions.length, 1);
    let sessionId = sessions[0].sessionId;
    const read = () => call('designer_get_document', {sessionId});
    let document = await read();
    assert.equal(document.components.length, 0);
    check('Real browser connects and removes credentials from URL');
    const empty = document.saveFile;
    for (const action of ['undo', 'redo', 'undo']) {
      document = await call('designer_history', {sessionId, expectedRevision:document.revision, action});
      assert.deepEqual(document.saveFile, empty);
      assert(!document.persistenceWarning);
    }
    const storedEmpty = await page.evaluate(() => new Promise((resolve, reject) => {
      const main = window.mainController;
      const request = main.db.transaction('tabs').objectStore('tabs').get(main.tabID);
      request.onsuccess = () => resolve(request.result?.data);
      request.onerror = () => reject(request.error);
    }));
    assert.deepEqual(storedEmpty.components, []);
    assert.equal(storedEmpty.version, empty.version);
    check('Undo/redo on a fresh empty canvas retains a valid persisted document');
    const emptyPreview = await call('designer_preview', {sessionId});
    assert(emptyPreview.content.some(item => item.type === 'image'));
    check('Empty canvas preview returns a PNG');
    const symbols = await call('designer_list_symbols', {sessionId, query:'resistor'});
    assert(symbols.total > 0 && symbols.symbols[0].example);
    const allSymbols = await call('designer_list_symbols', {sessionId, limit:100});
    assert(allSymbols.total >= 100 && allSymbols.symbols.length === 100);
    check('Searchable live component catalog with creation examples');
    const emptyGrid = await call('designer_check_grid', {sessionId});
    assert(emptyGrid.allAligned && emptyGrid.checkedPoints === 0);
    const gridSource = String.raw`\begin{circuitikz}
\draw (-0.137,0.263) to[R] (2.137,0.263) -- (2.137,-1.263) -- (-0.137,0.263);
\end{circuitikz}`;
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, source:gridSource, snapToGrid:false});
    const unsnapped = document.saveFile;
    assert(!document.gridAlignment.allAligned);
    const beforeGridCheck = document.revision;
    const gridReport = await call('designer_check_grid', {sessionId, limit:1});
    assert(!gridReport.allAligned && gridReport.misalignedPoints > 1 && gridReport.truncated);
    assert.equal(gridReport.issues.length, 1);
    assert(gridReport.issues[0].point.x < 0);
    for (const axis of ['x','y']) assert(Math.abs(gridReport.issues[0].point[axis] + gridReport.issues[0].delta[axis] - gridReport.issues[0].nearest[axis]) < 1e-8);
    assert.equal((await read()).revision, beforeGridCheck);
    assert.deepEqual((await read()).saveFile, unsnapped);
    await call('designer_check_grid', {sessionId, tolerancePx:-1}, true);
    check('Read-only grid check reports negative coordinates, deltas, totals and truncation');
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, source:gridSource, replace:true});
    assert(document.gridAlignment.allAligned);
    assert((await call('designer_check_grid', {sessionId})).allAligned);
    const snapped = document.saveFile;
    const paths = snapped.components.map(component => component.points);
    assert.deepEqual(paths[0][1], paths[1][0]);
    assert.equal(paths[1].length, 3);
    assert.deepEqual(paths[1].at(-1), paths[0][0]);
    assert.notDeepEqual(snapped.components.map(c => c.points), unsnapped.components.map(c => c.points));
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'undo'});
    assert.deepEqual(document.saveFile, unsnapped);
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'redo'});
    assert.deepEqual(document.saveFile, snapped);
    check('Import aligns to grid by default, retains shared endpoints and supports one-step undo/redo');
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, replace:true, source:String.raw`\begin{circuitikz}\node[op amp] at (0.137,0.263) {};\end{circuitikz}`});
    assert(!document.gridAlignment.allAligned);
    assert(document.gridAlignment.issues.some(issue => issue.kind === 'pin'));
    assert(document.components[0].pins.length > 1);
    const rigidSave = document.components[0].save;
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, replace:true, snapToGrid:false, source:String.raw`\begin{circuitikz}\node[op amp] at (0.137,0.263) {};\end{circuitikz}`});
    const rigidOriginal = document.components[0].save;
    delete rigidSave.automationId; delete rigidOriginal.automationId;
    assert.deepEqual(rigidSave, rigidOriginal);
    check('Rigid multi-pin geometry is preserved and remaining off-grid pins are reported');
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, replace:true, source:String.raw`\begin{circuitikz}\draw (0.001,0.001) -- (0.002,0.001);\end{circuitikz}`});
    const crowdedPoints = document.components[0].save.points;
    assert(crowdedPoints[0].x < crowdedPoints[1].x);
    assert(!document.gridAlignment.allAligned);
    check('Grid import does not collapse crowded endpoints and reports the constraint');
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'delete', ids:document.components.map(c => c.id)}]});
    const source = String.raw`\begin{circuitikz}
\draw (0,0) to[R,l=$R_1$] (3,0) to[C,l=$C_1$] (3,-2) -- (0,-2) to[V,l=$U$] (0,0);
\end{circuitikz}`;
    const oldRevision = document.revision;
    document = await call('designer_import_tikz', {sessionId, expectedRevision:document.revision, source});
    assert.equal(document.components.length, 4);
    assert(document.components.every(component => component.id && component.pins.length && component.pins.every(pin => Number.isFinite(pin.x) && Number.isFinite(pin.y) && (pin.name == null || typeof pin.name === 'string'))));
    assert(!document.persistenceWarning);
    const imported = document.saveFile;
    const originalIds = document.components.map(component => component.id);
    const resistorId = document.components[0].id;
    const staleError = await call('designer_apply_operations', {sessionId, expectedRevision:oldRevision, operations:[{op:'delete', ids:[resistorId]}]}, true);
    assert.match(staleError, /Revision conflict/);
    assert.deepEqual((await read()).saveFile, imported);
    check('Editable TikZ import, pin coordinates, persistence and revision conflict');
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[
      {op:'update', id:resistorId, patch:{label:{value:'R_2'}}},
      {op:'move', ids:[resistorId], dx:12, dy:0},
      {op:'create', component:{type:'simpleText', position:{x:50,y:-40}, text:'RC circuit $U_1$'}},
    ]});
    assert.equal(document.components.length, 5);
    assert.equal(document.components[0].id, resistorId);
    assert.equal(document.components[0].save.label.value, 'R_2');
    const edited = document.saveFile;
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'undo'});
    assert.deepEqual(document.saveFile, imported);
    assert.deepEqual(document.components.map(component => component.id), originalIds);
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'redo'});
    assert.deepEqual(document.saveFile, edited);
    check('Batch update, move and simple text; one-step undo/redo and stable ids');
    const rollbackRevision = document.revision;
    await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[
      {op:'move', ids:[resistorId], dx:50, dy:5},
      {op:'create', component:{type:'path', id:'missing-symbol', points:[{x:0,y:0},{x:100,y:0}]}},
    ]}, true);
    document = await read();
    assert.deepEqual(document.saveFile, edited);
    assert.equal(document.revision, rollbackRevision);
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'undo'});
    assert.deepEqual(document.saveFile, imported);
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'redo'});
    assert.deepEqual(document.saveFile, edited);
    check('Failed batch rolls back geometry and preserves undo history');
    const preview = await call('designer_preview', {sessionId, maxDimension:1000});
    const image = preview.content.find(item => item.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.subarray(1,4).toString(), 'PNG');
    assert(png.length > 1000);
    fs.writeFileSync(path.join(out, 'preview.png'), png);
    const previewInfo = JSON.parse(preview.content.find(item => item.type === 'text').text);
    assert.equal(previewInfo.grid.visible, true);
    assert(previewInfo.viewBox.x < 0 && previewInfo.viewBox.width > 0);
    const gridSettings = await page.evaluate(() => ({
      visible:window.mainController.canvasController.gridVisible,
      major:window.mainController.canvasController.majorGridSizecm,
      subdivisions:window.mainController.canvasController.majorGridSubdivisions,
    }));
    assert(Math.abs(previewInfo.grid.majorSpacingPx - gridSettings.major * 96 / 2.54) < 1e-6);
    assert(Math.abs(previewInfo.grid.minorSpacingPx - previewInfo.grid.majorSpacingPx / gridSettings.subdivisions) < 1e-6);
    const plainPreview = await call('designer_preview', {sessionId, maxDimension:1000, showGrid:false});
    assert.equal(JSON.parse(plainPreview.content.find(item => item.type === 'text').text).grid.visible, false);
    const gridPixels = await page.evaluate(async ({gridImage,plainImage,info}) => {
      const pixels = async data => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data;
        await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image,0,0);
        return context.getImageData(0,0,canvas.width,canvas.height).data;
      };
      const grid = await pixels(gridImage), plain = await pixels(plainImage);
      const box = info.viewBox, scale = Math.min(info.width / box.width, info.height / box.height);
      const offsetX = (info.width - box.width * scale) / 2, offsetY = (info.height - box.height * scale) / 2;
      const spacings = [info.grid.majorSpacingPx,info.grid.minorSpacingPx].filter(Boolean);
      let changedBackground = 0;
      for (let i = 0; i < plain.length; i += 4) {
        if (plain[i] === 0 && plain[i+1] === 0 && plain[i+2] === 0 && (grid[i] || grid[i+1] || grid[i+2])) throw new Error('Preview grid covered the circuit');
        if (plain[i] !== 255 || plain[i+1] !== 255 || plain[i+2] !== 255 || (grid[i] === 255 && grid[i+1] === 255 && grid[i+2] === 255)) continue;
        if (Math.min(grid[i],grid[i+1],grid[i+2]) < 215) throw new Error('Preview grid is too dark');
        const x = box.x + ((i/4)%info.width - offsetX) / scale;
        const y = box.y + (Math.floor(i/4/info.width) - offsetY) / scale;
        if (!spacings.some(step => Math.min(Math.abs(x-Math.round(x/step)*step),Math.abs(y-Math.round(y/step)*step))*scale <= 1.25)) throw new Error('Preview grid does not align with canvas coordinates');
        changedBackground++;
      }
      return changedBackground;
    }, {gridImage:image.data,plainImage:plainPreview.content.find(item => item.type === 'image').data,info:previewInfo});
    assert(gridPixels > 100);
    assert.equal(await page.evaluate(() => window.mainController.canvasController.gridVisible), gridSettings.visible);
    assert.equal((await read()).revision, document.revision);
    check('Default preview grid is faint, aligned with canvas coordinates, optional and read-only');
    const defaultExport = await call('designer_export', {sessionId});
    assert.equal(defaultExport.format, 'tikz');
    assert.equal(defaultExport.revision, document.revision);
    assert.equal(defaultExport.content, (await call('designer_export', {sessionId, format:'tikz'})).content);
    assert(defaultExport.content.includes('R_2'));
    assert.deepEqual((await read()).saveFile, edited);
    check('Export defaults to current TikZ code and leaves the document and revision intact');
    for (const format of ['tikz','svg','json']) {
      const result = await call('designer_export', {sessionId, format});
      assert.equal(result.revision, document.revision);
      if (format === 'tikz') assert(result.content.includes('R_2') && result.content.includes('tikzpicture'));
      if (format === 'svg') {
        assert(result.content.includes('<svg'));
        assert(await page.evaluate(source => !new DOMParser().parseFromString(source,'image/svg+xml').querySelector('parsererror'), result.content));
      }
      if (format === 'json') assert.deepEqual(JSON.parse(result.content), edited);
      fs.writeFileSync(path.join(out, `circuit.${format === 'tikz' ? 'tex' : format}`), result.content);
      const outputPath = path.join(out, 'tool-exports', `circuit.${format === 'tikz' ? 'tex' : format}`);
      const fileResult = await call('designer_export', {sessionId, format, outputPath, overwrite:true});
      assert.equal(fileResult.outputPath, outputPath);
      assert.equal(fileResult.revision, result.revision);
      assert.equal(fileResult.bytesWritten, Buffer.byteLength(result.content, 'utf8'));
      assert.equal(fileResult.encoding, 'utf-8');
      assert(!('content' in fileResult));
      assert.equal(fs.readFileSync(outputPath, 'utf8'), result.content);
      await call('designer_export', {sessionId, format, outputPath}, true);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), result.content);
    }
    assert.deepEqual((await read()).saveFile, edited);
    await call('designer_fit_view', {sessionId});
    await page.screenshot({path:path.join(out, 'browser.png')});
    check('PNG preview, valid SVG, TikZ/JSON export, and fit view leave document intact');
    // A second tab receives a distinct session. A tool must always name its target.
    const second = await context.newPage();
    second.on('pageerror', error => errors.push(error.message));
    await second.goto(appUrl, {waitUntil:'domcontentloaded'});
    await second.locator('#mcpButton').waitFor();
    await second.locator('#mcpButton').click();
    await second.locator('#mcpConnectionUrl').fill(initial.connectUrl);
    await second.locator('#mcpConnect').click();
    await second.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), null, {timeout:60000});
    assert.equal(await second.locator('#mcpConnectionUrl').inputValue(), '');
    check('Visible MCP dialog connects an existing canvas and clears its password field');
    sessions = (await call('designer_status')).sessions;
    assert.equal(sessions.length, 2);
    const otherId = sessions.find(session => session.sessionId !== sessionId).sessionId;
    assert.equal((await call('designer_get_document', {sessionId:otherId})).components.length, 0);
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'delete', ids:[resistorId]}]});
    assert.equal((await call('designer_get_document', {sessionId:otherId})).components.length, 0);
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'undo'});
    assert.deepEqual(document.saveFile, edited);
    await second.close();
    check('Multiple tabs route edits to the explicit canvas only');
    // The UI and MCP both mutate the same model, so an unsaved hand edit invalidates revisions.
    await page.evaluate(() => window.mainController.circuitComponents[0].mathJaxLabel.updateValue('manual_label', true, true));
    const handConflict = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'delete', ids:[resistorId]}]}, true);
    assert.match(handConflict, /Revision conflict/);
    document = await read();
    const manualExport = await call('designer_export', {sessionId});
    assert.equal(manualExport.revision, document.revision);
    assert(manualExport.content.includes('manual_label') && !manualExport.content.includes('R_2'));
    assert.equal((await read()).revision, document.revision);
    check('Current code export immediately reflects manual canvas edits without importing again');
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'update', id:resistorId, patch:{label:{value:'R_2'}}}]});
    assert.deepEqual(document.saveFile, edited);
    check('Manual browser edits invalidate stale agent revisions');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), null, {timeout:60000});
    sessions = (await call('designer_status')).sessions;
    assert.equal(sessions.length, 1);
    const disconnected = sessionId;
    sessionId = sessions[0].sessionId;
    assert.notEqual(sessionId, disconnected);
    document = await read();
    assert.deepEqual(document.saveFile, edited);
    await call('designer_get_document', {sessionId:disconnected}, true);
    check('Refresh restores saved geometry and ids, with a new browser session');
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'create', component:{type:'group', components:[
      {type:'simpleText', position:{x:0,y:-90}, text:'Group A'},
      {type:'wire', points:[{x:0,y:-70},{x:100,y:-70}], directions:['--']},
    ]}}]});
    const groupId = document.components.at(-1).id;
    const grouped = document.saveFile;
    const groupedGrid = await call('designer_check_grid', {sessionId});
    assert(groupedGrid.issues.some(issue => issue.ancestors.includes(groupId)));
    assert(groupedGrid.checkedComponents > document.components.length);
    assert.deepEqual((await read()).saveFile, grouped);
    check('Grid check inspects grouped child geometry without editing the document');
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'undo'});
    document = await call('designer_history', {sessionId, expectedRevision:document.revision, action:'redo'});
    assert.equal(document.components.at(-1).id, groupId);
    assert.deepEqual(document.saveFile, grouped);
    const groupPreview = await call('designer_preview', {sessionId});
    assert(groupPreview.content.some(item => item.type === 'image'));
    check('Group and child identities survive undo/redo and render in preview');
    const editingChecks = await require('./qa-mcp-editing.cjs')({call, read, page, sessionId, out});
    const diagnosticChecks = await require('./qa-mcp-diagnostics.cjs')({call, read, page, sessionId, out, rawCall:(name,args)=>client.callTool({name,arguments:args})});
    document = await read();
    document = await call('designer_apply_operations', {sessionId, expectedRevision:document.revision, operations:[{op:'delete', ids:document.components.map(component => component.id)}]});
    assert.equal(document.components.length, 0);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), null, {timeout:60000});
    sessionId = (await call('designer_status')).sessions[0].sessionId;
    assert.equal((await read()).components.length, 0);
    await page.locator('#mcpButton').click();
    await page.locator('#mcpDisconnect').click();
    await page.waitForFunction(() => !sessionStorage.getItem('circuitikz-mcp-connection'));
    await page.waitForTimeout(100);
    assert.equal((await call('designer_status')).sessions.length, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    check('Deleting all components persists, and visible Disconnect revokes the session');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({passed:checks.length, checks, editingChecks, diagnosticChecks, browserErrors:errors, appUrl, transport:connectedInProcess ? 'SDK stdio over paired streams (no child process)' : 'SDK stdio child process', browser:process.env.QA_CDP_URL ? 'Dedicated Edge over CDP' : 'Headless Edge'}, null, 2));
    console.log(`PASS: ${checks.length} MCP integration checks.`);
  } finally {
    await context?.close();
    await browser?.close();
    await client.close();
    await mcpServer?.close();
    await bridge?.close();
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
  }
})().catch(error => { console.error(error); httpServer.close(); process.exitCode = 1; });
