const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
function load(file) {
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, file);
  return loaded.exports;
}
const baseline = load(path.resolve(root, process.argv[2] || '.qa-tools/optimization-baseline-20261027/src/scripts/utils/tikzMath.ts'));
const current = load(path.join(root, 'src/scripts/utils/tikzMath.ts'));
const expressions = ['\\x/45', '2.4*sin(\\x)+.6*sin(2*\\x)', 'max(-1.68,min(1.68,2*sin(\\x)))',
  '\\x<90 ? 1.1+.36*\\x : 2+.4*(1-exp(-.9*(\\x-90)))'];
function run(math, rounds) {
  let sum = 0;
  const start = performance.now();
  for (let round = 0; round < rounds; round++) for (let i = 0; i < 500; i++) {
    const variables = { x: i * 180 / 499 };
    for (const expression of expressions) {
      const value = math(expression, variables);
      assert(value != null); sum += value;
    }
  }
  return { ms: performance.now() - start, sum };
}
run(baseline.evaluateTikzMath, 2); run(current.evaluateTikzMath, 2);
const before = [], after = [];
for (let round = 0; round < 5; round++) {
  const a = run(baseline.evaluateTikzMath, 25), b = run(current.evaluateTikzMath, 25);
  assert(Math.abs(a.sum - b.sum) < 1e-7, 'Evaluation results changed');
  before.push(a.ms); after.push(b.ms);
}
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const result = { method: 'Node.js; 50,000 evaluations per run, 500 samples, four review-style formulas; five runs, median.',
  baselineMs: median(before), currentMs: median(after), speedup: median(before)/median(after), before, after };
const out = path.join(root, 'qa-results/tikz-optimization'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'math-performance.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
