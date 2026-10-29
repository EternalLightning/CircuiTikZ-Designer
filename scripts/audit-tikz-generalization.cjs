// Characterize the current importer through a real, isolated MCP/browser session.
// This is an audit, not a visual-equivalence test or a TeX interpreter.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../.qa-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const corpus = path.resolve(process.argv[2] || process.env.QA_IMPORT_CORPUS || '');
const out = path.resolve(process.argv[3] || path.join(root, 'qa-results/tikz-generalization'));
const preamble = process.argv[4] ? fs.readFileSync(path.resolve(process.argv[4]), 'utf8') + '\n' : '';
if (!process.argv[2] && !process.env.QA_IMPORT_CORPUS) throw Error('Supply a corpus directory.');
if (!fs.statSync(corpus).isDirectory()) throw Error('Corpus must be a directory.');
// Avoid putting generated evidence in the source corpus or overwriting old evidence.
const relativeOut = path.relative(corpus, out);
if (!relativeOut || (!relativeOut.startsWith('..' + path.sep) && relativeOut !== '..' && !path.isAbsolute(relativeOut)))
  throw Error('Output must be outside the source corpus.');
if (fs.existsSync(out)) throw Error('Choose a new output directory to preserve prior evidence.');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? (/^(?:\.git|node_modules|qa-results)$/.test(entry.name) ? [] : walk(file)) :
      /\.(?:tex|tikz)$/.test(entry.name) ? [file] : [];
  }).sort();
}
function features(source) {
  return Object.entries({
    circuitikz: /\\begin\{circuitikz\}/,
    coordinateUnits: /(?:^|[,\[])\s*[xy]\s*=/m,
    scale: /\bscale\s*=/,
    foreach: /\\foreach\b/,
    foreachRange: /\\foreach[\s\S]*?\bin\s*\{[^}]*\.\.\./,
    pgfmath: /\\pgfmath\w*/,
    plot: /\bplot\b/,
    bezier: /\bcontrols\b/,
    scope: /\\begin\{scope\}/,
    parameterized: /#[1-9]/,
    namedStyle: /\\tikzset\b|\/\.style/,
    customColor: /amzchaptercolor/,
    colorMix: /\b[A-Za-z]+!\d/,
    chinese: /[\u3400-\u9fff]/,
  }).filter(([, re]) => re.test(source)).map(([name]) => name);
}
const sources = walk(corpus).map(file => {
  const bytes = fs.readFileSync(file);
  return { file: path.relative(corpus, file), sha256: sha(bytes), text: bytes.toString('utf8') };
});
const samples = [], templates = [];
for (const source of sources) {
  // The audit corpus uses ordinary picture environments. Escaped % is retained.
  const text = source.text.replace(/(?<!\\)%[^\n]*/g, '');
  let ordinal = 0;
  for (const match of text.matchAll(/\\begin\{(circuitikz|tikzpicture)\}[\s\S]*?\\end\{\1\}/g)) {
    const row = { file: source.file, ordinal: ++ordinal, source: match[0], features: features(match[0]) };
    // A macro body containing #1 is a template, not a standalone renderable picture.
    (row.features.includes('parameterized') ? templates : samples).push(row);
  }
}
const probes = [
  ['coordinate-units', String.raw`\begin{tikzpicture}[x=2cm,y=1.15cm]\draw (0,0)--(1,1);\end{tikzpicture}`, 'endpoint', { x: 2, y: -1.15 }],
  ['foreach-range', String.raw`\begin{tikzpicture}\foreach \k in {1,...,8}{\node at (\k,0) {\k};}\end{tikzpicture}`, 'count', 8],
  ['pgfmath-label', String.raw`\begin{tikzpicture}\pgfmathtruncatemacro{\lowerSlot}{mod(5+3,16)+1}\node at (0,0) {\lowerSlot};\end{tikzpicture}`, 'label', '9'],
  ['named-style', String.raw`\tikzset{vector/.style={->,red,thick}}\begin{tikzpicture}\draw[vector] (0,0)--(1,0);\end{tikzpicture}`, 'red-arrow'],
  ['bare-color', String.raw`\begin{tikzpicture}\draw[red] (0,0)--(1,0);\end{tikzpicture}`, 'red'],
  ['explicit-color', String.raw`\begin{tikzpicture}\draw[draw=red] (0,0)--(1,0);\end{tikzpicture}`, 'red'],
  ['plot-expression', String.raw`\begin{tikzpicture}\draw[domain=0:180,samples=100] plot ({\x/45},{2.4*sin(\x)});\end{tikzpicture}`, 'geometry'],
  ['bezier-semantics', String.raw`\begin{tikzpicture}\draw (0,0) .. controls (1,2) and (2,2) .. (3,0);\end{tikzpicture}`, 'bezier'],
];
const results = {
  corpus, startedAt: new Date().toISOString(), preamble,
  method: 'Current production build; official MCP SDK stdio; isolated headless Edge; snapToGrid=false.',
  limits: process.env.QA_GENERALIZATION_CHECKS
    ? 'Includes real TeX compilation of every editable export, representative original sources and parameterized invocations. Compilation does not assert visual equivalence. Picture extraction is for ordinary environments, not arbitrary TeX macro expansion.'
    : 'Import/export characterization and SVG previews only. No source TeX compilation or visual equivalence is asserted. Picture extraction is for ordinary environments, not arbitrary TeX macro expansion.',
  sourceFiles: sources.map(({ text, ...rest }) => rest),
  importerSha256: sha(fs.readFileSync(path.join(root, 'src/scripts/utils/tikzImporter.ts'))),
  buildIndexSha256: sha(fs.readFileSync(path.join(root, 'dist/index.html'))),
  templates: templates.map(({ source, ...rest }) => ({ ...rest, sourceSha256: sha(source) })),
  samples: [], probes: [], browserErrors: [],
};
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const base = path.join(root, 'dist');
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(base, '.' + (requested === '/' ? '/index.html' : requested));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const load = file => import(pathToFileURL(path.join(root, 'mcp', file)).href);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { Client } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const client = new Client({ name: 'tikz-generalization-audit', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'mcp/server.mjs')],
    env: { ...process.env, MCP_BRIDGE_PORT: '0', MCP_APP_URL: `http://127.0.0.1:${server.address().port}/` }, stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  let browser;
  const persist = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  try {
    await client.connect(transport);
    async function call(name, args = {}) {
      const response = await client.callTool({ name, arguments: args });
      const message = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      return { error: !!response.isError, message, response, data: response.isError ? null : JSON.parse(message) };
    }
    const status = await call('designer_status');
    if (status.error) throw Error(status.message);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => results.browserErrors.push(error.message));
    await page.route('**/www.googletagmanager.com/**', route => route.abort());
    await page.goto(status.data.connectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('mcpButton')?.textContent.includes('已连接'), { timeout: 60000 });
    const sessions = (await call('designer_status')).data.sessions;
    if (sessions.length !== 1) throw Error('Expected exactly one isolated browser session.');
    const sessionId = sessions[0].sessionId;
    async function inspect(source, dir, preview) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'input.tikz'), source);
      const doc = await call('designer_get_document', { sessionId });
      const args = { sessionId, expectedRevision: doc.data.revision, source, replace: true, snapToGrid: false };
      const strict = await call('designer_import_tikz', args);
      const imported = strict.error ? await call('designer_import_tikz', { ...args, allowWarnings: true }) : strict;
      const row = { strictAccepted: !strict.error, strictError: strict.error ? strict.message : null, imported: !imported.error };
      if (imported.error) return { ...row, error: imported.message };
      const exported = await call('designer_export', { sessionId, format: 'tikz' });
      if (exported.error) throw Error(exported.message);
      fs.writeFileSync(path.join(dir, 'document.json'), JSON.stringify(imported.data, null, 2));
      fs.writeFileSync(path.join(dir, 'export.tikz'), exported.data.content);
      const saved = await page.evaluate(() => window.mainController.circuitComponents.map(c => c.toJson()));
      fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify(saved, null, 2));
      row.components = saved.length;
      row.types = saved.reduce((counts, c) => ({ ...counts, [c.type]: (counts[c.type] || 0) + 1 }), {});
      row.warnings = imported.data.warnings;
      row.nonfiniteComponents = await page.evaluate(() => window.mainController.circuitComponents.filter(c =>
        ![c.position.x, c.position.y, c.bbox.x, c.bbox.y, c.bbox.width, c.bbox.height].every(Number.isFinite)).length);
      if (preview) {
        const image = await call('designer_preview', { sessionId, showGrid: false, maxDimension: 1400 });
        if (image.error) row.previewError = image.message;
        else {
          const block = image.response.content.find(item => item.type === 'image');
          fs.writeFileSync(path.join(dir, 'preview.png'), Buffer.from(block.data, 'base64'));
        }
      }
      return { ...row, saved, exported: exported.data.content };
    }
    for (const [index, sample] of samples.entries()) {
      const id = `${String(index + 1).padStart(2, '0')}-${path.basename(sample.file, path.extname(sample.file))}-${sample.ordinal}`;
      const preview = /power_angle|winding_connection_table|synchronous_phasor|dc_armature_structure|dc_power_flow/.test(sample.file);
      const inspected = await inspect(preamble + sample.source, path.join(out, id), preview);
      const { saved, exported, ...evidence } = inspected;
      results.samples.push({ id, file: sample.file, ordinal: sample.ordinal, features: sample.features, sourceSha256: sha(sample.source), ...evidence });
      persist();
      console.log(`${id}: strict=${evidence.strictAccepted} imported=${evidence.imported} objects=${evidence.components ?? 0} warnings=${evidence.warnings?.length ?? 0}`);
    }
    for (const [id, source, check, expected] of probes) {
      const inspected = await inspect(source, path.join(out, 'probe-' + id), false);
      const { saved = [], exported = '', ...evidence } = inspected;
      const first = saved[0];
      let observed, preserved = false;
      if (check === 'endpoint') {
        const endpoint = first?.points?.at(-1);
        observed = endpoint ? { x: endpoint.x / (96 / 2.54), y: endpoint.y / (96 / 2.54) } : null;
        preserved = observed != null && Math.abs(observed.x - expected.x) < 1e-4 && Math.abs(observed.y - expected.y) < 1e-4;
      } else if (check === 'count') { observed = saved.length; preserved = observed === expected; }
      else if (check === 'label') { observed = first; preserved = !exported.includes('\\lowerSlot') && /\{9\}/.test(exported); }
      else if (check === 'red' || check === 'red-arrow') {
        observed = first;
        const red = /#ff0000|rgb\(255,\s*0,\s*0\)/i.test(JSON.stringify(first?.stroke));
        preserved = red && (check === 'red' || ['stealth', 'latex', 'to'].includes(first?.endArrow));
      } else if (check === 'geometry') { observed = saved.length; preserved = saved.some(c => (c.points?.length ?? 0) > 2); }
      else if (check === 'bezier') { observed = { type: first?.type, points: first?.points?.length, retainsControls: /\bcontrols\b/.test(exported) }; preserved = observed.retainsControls; }
      results.probes.push({ id, ...evidence, check, expected, observed, preserved });
      persist();
      console.log(`probe-${id}: strict=${evidence.strictAccepted} preserved=${preserved}`);
    }
    if (process.env.QA_GENERALIZATION_CHECKS) {
      results.generalizationChecks = await require('./qa-tikz-generalization.cjs')({ call, page, sessionId, out, corpus, preamble });
    }
    results.summary = {
      texFiles: sources.length, concretePictures: samples.length, parameterizedTemplates: templates.length,
      imported: results.samples.filter(s => s.imported).length,
      strictAccepted: results.samples.filter(s => s.strictAccepted).length,
      withWarnings: results.samples.filter(s => (s.warnings?.length ?? 0) > 0).length,
      failed: results.samples.filter(s => !s.imported).length,
      nonfiniteComponents: results.samples.reduce((sum, s) => sum + (s.nonfiniteComponents || 0), 0),
      sourcesUnchanged: sources.every(s => sha(fs.readFileSync(path.join(corpus, s.file))) === s.sha256),
      importerUnchanged: sha(fs.readFileSync(path.join(root, 'src/scripts/utils/tikzImporter.ts'))) === results.importerSha256,
    };
    results.completedAt = new Date().toISOString();
  } finally {
    persist();
    await browser?.close();
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(results.summary, null, 2));
  console.log('Evidence: ' + out);
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
