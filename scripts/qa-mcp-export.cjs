// Backend integration checks: real MCP SDK stdio framing and authenticated
// WebSocket bridge, with a deterministic peer standing in for the browser.
// This does not test page initialization or browser rendering.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const fromMcp = file => import(pathToFileURL(path.join(root, 'mcp', file)).href);
const checks = [];
function check(name) { checks.push(name); console.log('PASS:', name); }

(async () => {
  const out = path.join(root, 'qa-results', 'mcp-export');
  await fs.mkdir(out, {recursive:true});
  const files = await fs.mkdtemp(path.join(out, 'run-'));
  const {Client} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const {StdioServerTransport} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
  const {ReadBuffer, serializeMessage} = await fromMcp('node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js');
  const {WebSocket} = await fromMcp('node_modules/ws/wrapper.mjs');
  const {createBridge} = await fromMcp('bridge.mjs');
  const {createDesignerServer} = await fromMcp('server.mjs');
  const childProcess = process.env.QA_MCP_CHILD_PROCESS === '1';
  const bridge = childProcess ? undefined : await createBridge({port:0});
  const server = childProcess ? undefined : createDesignerServer(bridge);
  const client = new Client({name:'export-backend-qa', version:'1.0.0'});
  const input = new PassThrough(), output = new PassThrough(), buffer = new ReadBuffer();
  const transport = childProcess ? new StdioClientTransport({command:process.execPath, args:[path.join(root, 'mcp', 'server.mjs')], env:{...process.env, MCP_BRIDGE_PORT:'0'}, stderr:'pipe'}) : {
    async start() { output.on('data', chunk => { buffer.append(chunk); let message; while ((message = buffer.readMessage()) !== null) this.onmessage?.(message); }); },
    async send(message) { input.write(serializeMessage(message)); },
    async close() { input.end(); output.end(); this.onclose?.(); },
  };
  if (childProcess) transport.stderr.on('data', () => {}); // Contains a private connection token.
  const call = (name, args = {}) => client.callTool({name, arguments:args});
  function parse(response) {
    const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert(!response.isError, text);
    return JSON.parse(text);
  }
  async function fails(args, pattern) {
    const result = await call('designer_export', args);
    assert(result.isError, 'Expected a tool error');
    assert.match(result.content.map(c => c.text || '').join('\n'), pattern);
  }
  async function absent(file) { await assert.rejects(fs.stat(file), {code:'ENOENT'}); }
  let peer;
  try {
    if (server) await server.connect(new StdioServerTransport(input, output));
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 16);
    assert(tools.some(tool => tool.name === 'designer_compile'));
    const tool = tools.find(t => t.name === 'designer_export');
    assert(tool.inputSchema.properties.outputPath);
    assert(tool.inputSchema.properties.overwrite);
    assert.equal(tool.annotations.readOnlyHint, false);
    const status = parse(await call('designer_status'));
    assert.deepEqual(status.sessions, []);
    const disconnectedPath = path.join(files, 'disconnected', 'out.tex');
    await fails({sessionId:'missing', outputPath:disconnectedPath}, /Unknown or disconnected sessionId/);
    await absent(path.dirname(disconnectedPath));
    check('MCP initialize, tools/list, schemas, annotations and disconnected calls');

    const url = new URL(status.connectUrl);
    const token = new URLSearchParams(url.hash.slice(1)).get('mcpToken');
    peer = new WebSocket(`ws://127.0.0.1:${url.searchParams.get('mcpPort')}/bridge`, ['circuitikz', token], {origin:url.origin});
    const fixtures = {tikz:'\\begin{tikzpicture}\n% 中文电路 Ω\n\\draw (0,0) to[R,l=$R_1$] (2,0);\n\\end{tikzpicture}\n', svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>中文 Ω</text></svg>\n', json:JSON.stringify({version:'qa', components:[], title:'中文 Ω'})};
    let revision = 'qa-r1', browserError, invalidContent = false, requestCount = 0;
    const sessionId = await new Promise((resolve, reject) => {
      peer.once('error', reject);
      peer.once('open', () => peer.send(JSON.stringify({type:'hello', version:1, title:'Export test peer'})));
      peer.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'welcome') { resolve(message.sessionId); return; }
        if (message.type !== 'request') return;
        requestCount++;
        assert.equal(message.method, 'export');
        peer.send(JSON.stringify({type:'result', id:message.id, ...(browserError ? {error:browserError} : {result:{revision, format:message.args.format, content:invalidContent ? null : fixtures[message.args.format]}})}));
      });
    });
    assert.equal(parse(await call('designer_status')).sessions[0].sessionId, sessionId);
    const original = parse(await call('designer_export', {sessionId}));
    assert.deepEqual(original, {revision, format:'tikz', content:fixtures.tikz});
    check('Authenticated WebSocket session routes the export; text default stays compatible');

    for (const format of ['tikz', 'svg', 'json']) {
      const outputPath = path.join(files, '新目录', `${format}.${format === 'tikz' ? 'tex' : format}`);
      const text = parse(await call('designer_export', {sessionId, format}));
      const saved = parse(await call('designer_export', {sessionId, format, outputPath}));
      assert.deepEqual(saved, {revision, format, outputPath, bytesWritten:Buffer.byteLength(text.content, 'utf8'), encoding:'utf-8'});
      assert.deepEqual(await fs.readFile(outputPath), Buffer.from(text.content, 'utf8'));
      await fails({sessionId, format, outputPath}, /already exists/);
      assert.equal(await fs.readFile(outputPath, 'utf8'), text.content);
      check(`${format}: UTF-8 file matches text byte for byte; parents created; overwrite refused`);
    }
    const outputPath = path.join(files, '新目录', 'tikz.tex');
    revision = 'qa-r2'; fixtures.tikz += '% changed\n';
    const replaced = parse(await call('designer_export', {sessionId, outputPath, overwrite:true}));
    assert.equal(replaced.revision, revision);
    assert.equal(await fs.readFile(outputPath, 'utf8'), fixtures.tikz);
    check('Explicit overwrite exports the latest revision and content');

    const before = requestCount;
    for (const badPath of ['relative.tex', '', 'E:relative.tex', `${files}\0bad.tex`])
      await fails({sessionId, outputPath:badPath}, /absolute|small|characters/i);
    assert.equal(requestCount, before, 'Invalid paths must fail before requesting browser export');
    check('Invalid paths fail schema validation before touching browser or disk');

    const blockedParent = path.join(files, 'parent-is-file');
    await fs.writeFile(blockedParent, 'keep', 'utf8');
    await fails({sessionId, outputPath:path.join(blockedParent, 'out.tex')}, /EEXIST|ENOTDIR/i);
    assert.equal(await fs.readFile(blockedParent, 'utf8'), 'keep');
    await fails({sessionId, outputPath:path.join(files, '新目录')}, /already exists|EISDIR|EPERM/i);
    check('Filesystem errors return tool errors and preserve existing data');

    const rejectedPath = path.join(files, 'browser-failed', 'out.tex');
    browserError = 'Export fixture refused';
    await fails({sessionId, outputPath:rejectedPath}, /Export fixture refused/);
    await absent(path.dirname(rejectedPath));
    browserError = undefined; invalidContent = true;
    await fails({sessionId, outputPath:rejectedPath}, /did not return text/);
    await absent(path.dirname(rejectedPath));
    invalidContent = false;
    check('Browser failures and invalid content never create output files');

    const raced = path.join(files, 'race.tex');
    const races = await Promise.all([call('designer_export', {sessionId, outputPath:raced}), call('designer_export', {sessionId, outputPath:raced})]);
    assert.equal(races.filter(r => !r.isError).length, 1);
    assert.equal(races.filter(r => r.isError).length, 1);
    assert.equal(await fs.readFile(raced, 'utf8'), fixtures.tikz);
    check('Concurrent writes without overwrite have exactly one winner');

    const report = {passed:checks.length, checks, transport:`Real MCP SDK stdio ${childProcess ? 'child process' : 'over paired streams'}; authenticated TCP WebSocket test peer`, browser:'Not exercised by these backend checks', files};
    await fs.writeFile(path.join(out, childProcess ? 'results-child.json' : 'results.json'), JSON.stringify(report, null, 2));
    console.log(`Completed ${checks.length} backend checks.`);
  } finally {
    if (peer) peer.terminate();
    await client.close();
    if (server) await server.close();
    if (bridge) await bridge.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
