const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { evaluateTikzMath: math, compileTikzMath, readTikzGroup } = require('../src/scripts/utils/tikzMath.ts');
const { prepareTikz } = require('../src/scripts/utils/tikzPreprocessor.ts');
const { resolveTikzColor: color, collectTikzColors } = require('../src/scripts/utils/tikzColors.ts');
const { TikzStyles } = require('../src/scripts/utils/tikzStyles.ts');
const { fitAffine } = require('../src/scripts/utils/affineFit.ts');
for (const [expression, expected] of [['2+3*4', 14], ['-2^2', -4], ['2^3^2', 512], ['sin(30)', .5], ['cos(180)', -1],
  ['2.4*sin(90)+.6*sin(180)', 2.4], ['max(-1.68,min(1.68,2))', 1.68], ['mod(5+3,16)+1', 9],
  ['2<2.5 ? 1.1+.36*2 : 2+.4*(1-exp(-.9*(2-2.5)))', 1.82], ['{sin(30)}', .5], ['round(-2.5)', -3]]) {
  assert(Math.abs(math(expression) - expected) < 1e-10, expression);
}
assert.equal(math('sin(\\x)', { x: 30 }), .49999999999999994);
for (const expression of ['globalThis.process.exit()', 'constructor(1)', 'sin(1,2)', '1/0', 'sin(', '', '2;3', '1 constructor 2', '1 toString 2']) assert.equal(math(expression), null, expression);
const formula = compileTikzMath('2*sin(\\x)');
assert(formula); assert.equal(formula({x:90}),2); assert.equal(formula({x:0}),0);
assert.equal(formula({}),null); assert.equal(formula({x:Infinity}),null);
assert.equal(compileTikzMath('('.repeat(70)+'1'+')'.repeat(70)),null);
for(let i=0;i<200;i++) assert.equal(math('\\x+'+i,{x:3}),i+3);
assert.equal(math('2*sin(\\x)',{x:90}),2);
assert.equal(readTikzGroup('{a{b}c}', 0).content, 'a{b}c');
assert.equal(readTikzGroup('[font={a[b]}]', 0, '[', ']').content, 'font={a[b]}');
assert.equal(readTikzGroup('{a\\}b}', 0).content, 'a\\}b');
const range = prepareTikz(String.raw`\foreach \k in {1,...,8}{\node at (\k,0) {\k};}`).source;
assert.equal((range.match(/\\node/g) || []).length, 8);
assert(range.includes('(7,0) {7}'));
const steps = prepareTikz(String.raw`\foreach \k in {15,45,...,165}{\node at (\k:1) {};}`).source;
assert.equal((steps.match(/\\node/g) || []).length, 6);
const descending = prepareTikz(String.raw`\foreach \k in {3,2,...,0}{\node at (\k,0) {};}`).source;
assert.equal((descending.match(/\\node/g) || []).length, 4);
const calculated = prepareTikz(String.raw`\foreach \k in {1,...,16}{\pgfmathtruncatemacro{\lowerSlot}{mod(\k+3,16)+1}\node {\lowerSlot};}`).source;
assert(calculated.includes('\\node {16};') && calculated.includes('\\node {1};'));
assert(!calculated.includes('lowerSlot'));
const macro = prepareTikz(String.raw`\newcommand{\p}[2]{\draw (#1,#2)--(1,1);}\p{2}{3}`).source;
assert(macro.includes('\\draw (2,3)--(1,1);'));
const local = prepareTikz(String.raw`\def\a{1}{\def\a{2}\node{\a};}\node{\a};`).source;
assert(local.includes('\\node{2};') && local.endsWith('\\node{1};'));
assert.throws(() => prepareTikz(String.raw`\def\a{\a}\a`), /32/);
assert.throws(() => prepareTikz(String.raw`\foreach \k in {1,...,100000}{\node {\k};}`), /2000/);
assert.equal(prepareTikz(String.raw`\node {100\%}; % comment`).source.trim(), String.raw`\node {100\%};`);
const custom = collectTikzColors(String.raw`\definecolor{chapter}{HTML}{0984e3}\colorlet{tint}{chapter!20!white}`);
assert.equal(color('red'), '#ff0000'); assert.equal(color('orange!85!black'), '#d96d00');
assert.equal(color('chapter', custom), '#0984e3'); assert.equal(color('chapter!20', custom), '#cee6f9');
assert.equal(color('tint', custom), '#cee6f9'); assert.equal(color('noSuchColor'), null);
const styles = new TikzStyles(); styles.define('vector/.style={->,red,thick},base/.style={vector,dashed}');
assert.deepEqual(styles.expand(['base']), ['->', 'red', 'thick', 'dashed']);
const child = new TikzStyles(styles); child.define('vector/.style={blue}');
assert.deepEqual(child.expand(['vector']), ['blue']); assert.deepEqual(styles.expand(['vector']), ['->', 'red', 'thick']);
styles.define('a/.style={b},b/.style={a}'); assert.throws(() => styles.expand(['a']), /20/);
const fanout = new TikzStyles();
for(let i=0;i<15;i++) fanout.define(`s${i}/.style={s${i+1},s${i+1}}`);
assert.throws(() => fanout.expand(['s0']), /10000/);
const scope = prepareTikz(String.raw`\def\a{1}\begin{scope}\def\a{2}\node{\a};\end{scope}\node{\a};`).source;
assert(scope.includes('\\node{2};') && scope.endsWith('\\node{1};'));
const original = [{x:0,y:0},{x:1,y:2},{x:3,y:4},{x:4,y:1}];
const transformed = original.map(p=>({x:2*p.x-3*p.y+5,y:4*p.x+p.y-8}));
assert.deepEqual(fitAffine(original,transformed),{a:2,b:4,c:-3,d:1,e:5,f:-8});
transformed[1].x+=1; assert.equal(fitAffine(original,transformed),null);
console.log('TikZ syntax checks passed: math, ranges, macros, scope, expansion limits, colors and styles.');
