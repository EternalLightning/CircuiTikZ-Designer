const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const load = file => import(pathToFileURL(path.join(root, 'mcp', file)).href);
const checks = [];
const check = name => { checks.push(name); console.log('PASS:', name); };
(async () => {
  const { compileTikz, standaloneDocument } = await load('compile.mjs');
  const { createCompileQueue } = await load('compileQueue.mjs');
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'tikz-compile-qa-'));
  const evidence = path.join(root, 'qa-results/tikz-optimization');
  await fs.mkdir(evidence, { recursive: true });
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const queue = createCompileQueue({ concurrency: 2, maxQueued: 1 });
  const first = deferred(), second = deferred(); let active = 0, peak = 0, cancelledRan = false;
  const task = gate => queue(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; return 'done'; });
  const a = task(first), b = task(second);
  const cancellation = new AbortController();
  const queued = queue(() => { cancelledRan = true; }, cancellation.signal);
  await assert.rejects(queue(() => {}), { code: 'queue_full' });
  cancellation.abort(); await assert.rejects(queued, { name: 'AbortError' });
  first.resolve(); second.resolve(); await Promise.all([a,b]);
  assert.equal(peak, 2); assert(!cancelledRan);
  assert.equal((await queue(() => 42)).result,42);
  check('Compile queue limits active processes, bounds waiting work, cancels queued jobs and releases slots');
  const picture = String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`;
  const commented = '% \\documentclass{article} is only a comment\n' + picture;
  const macro = String.raw`\def\unused{\documentclass{article}}` + '\n' + picture;
  assert(standaloneDocument(commented).startsWith('\\documentclass[border='));
  assert(standaloneDocument(macro).startsWith('\\documentclass[border='));
  const full = String.raw`\documentclass{standalone}\usepackage{tikz}\begin{document}` + picture + '\\end{document}';
  assert.equal(standaloneDocument(full),full);
  check('Document detection ignores comments and macro bodies while preserving real full documents');
  const compilations = [];
  try {
    for (const [name,source,engine] of [['commented-fragment',commented,'xelatex'], ['macro-fragment',macro,'xelatex'], ['full-document',full,'pdflatex']]) {
      const result = await compileTikz({ source, engine, includePreview: false, outputPath: path.join(out,name+'.pdf') });
      assert(result.success,result.diagnostics); assert(result.durationMs >= result.compileMs);
      compilations.push({ name, ...result });
    }
    check('Commented fragments, macro fragments and full documents compile with real XeLaTeX/pdfLaTeX');
    const existing = path.join(out,'existing.pdf'); await fs.writeFile(existing,'keep');
    await assert.rejects(compileTikz({source:picture,outputPath:existing}), { code:'output_exists' });
    assert.equal(await fs.readFile(existing,'utf8'),'keep');
    await assert.rejects(compileTikz({source:picture,resourceDirectory:path.join(out,'missing')}), {code:'ENOENT'});
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(compileTikz({source:picture,signal:aborted.signal}),{name:'AbortError'});
    check('Existing PDFs, invalid resource paths and pre-cancelled requests are rejected before compiling');
    const failure = await compileTikz({source:picture.replace('\\draw','\\undefinedcommand'),includePreview:false});
    assert(!failure.success); assert.equal(failure.errorCode,'compile_failed'); assert(failure.diagnostics);
    check('Real TeX failures retain bounded diagnostics and a machine-readable error code');
    const temporary = () => fs.readdir(os.tmpdir()).then(names => names.filter(name=>name.startsWith('tikz-designer-')));
    const before = new Set(await temporary()), controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),300);
    let cancelled;
    try { cancelled = await compileTikz({source:'\\loop\\iftrue\\repeat',includePreview:false,signal:controller.signal}); }
    finally { clearTimeout(timer); }
    assert(!cancelled.success); assert.equal(cancelled.errorCode,'cancelled');
    assert.deepEqual((await temporary()).filter(name=>!before.has(name)),[]);
    check('An active TeX process is cancelled and its temporary directory is removed');
    await fs.writeFile(path.join(evidence,'compiler-results.json'),JSON.stringify({checks,compilations,cancelled},null,2));
  } finally { await fs.rm(out,{recursive:true,force:true}); }
  console.log('PASS:',checks.length,'compiler checks');
})().catch(error=>{console.error(error);process.exitCode=1;});
