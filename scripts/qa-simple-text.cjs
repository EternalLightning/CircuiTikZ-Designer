// Source integration tests with SVGDOM/LinkeDOM and MathJax 3.2.2.
// These adapters exercise real components and properties; they do not replace browser UI QA.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const SVG = require('@svgdotjs/svg.js');
const {parseHTML} = require('../.qa-tools/node_modules/linkedom');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'qa-results', 'simple-text');
const internals = {};
const loaded = new Map();

function sourceModule(relative) {
  const filename = path.join(root, relative);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const module = new Module(filename);
  loaded.set(filename, module);
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = name => {
    if (name === '../internal') return internals;
    if (name.startsWith('.') && fs.existsSync(path.resolve(path.dirname(filename), name + '.ts')))
      return sourceModule(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')));
    return originalRequire(name);
  };
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true},
    fileName:filename,
  }).outputText;
  module._compile(js, filename);
  return module.exports;
}

(async () => {
  fs.mkdirSync(out, {recursive:true});
  const {createSVGWindow, Element:DOMElement} = await import('../.qa-tools/node_modules/svgdom/main-module.js');
  DOMElement.prototype.hasAttributes = function(){return this.attributes.length > 0};
  // SVGDOM omits DOMTokenList; implement its class attribute operations for the adapter.
  Object.defineProperty(DOMElement.prototype,'classList',{get(){
    const node=this, tokens=()=>new Set((node.getAttribute('class')||'').split(/\s+/).filter(Boolean));
    return {
      add(...values){const t=tokens();values.forEach(v=>t.add(v));node.setAttribute('class',[...t].join(' '))},
      remove(...values){const t=tokens();values.forEach(v=>t.delete(v));node.setAttribute('class',[...t].join(' '))},
      contains(value){return tokens().has(value)},
    };
  }});
  const svgWindow = createSVGWindow();
  SVG.registerWindow(svgWindow, svgWindow.document);
  const canvas = SVG.SVG(svgWindow.document.documentElement).size(900, 500).viewbox(-60, -170, 380, 220);
  canvas.defs().id('backgroundDefs');
  const htmlWindow = parseHTML('<html><body></body></html>');
  global.document = htmlWindow.document;
  const htmlGetById = document.getElementById.bind(document);
  document.getElementById = id => htmlGetById(id) ?? svgWindow.document.getElementById(id);
  const events = htmlWindow.Event;

  const p = '../.qa-tools/node_modules/mathjax-full/js/';
  const {mathjax} = require(p + 'mathjax.js');
  const {TeX} = require(p + 'input/tex.js');
  const {SVG:MathJaxSVG} = require(p + 'output/svg.js');
  const {liteAdaptor} = require(p + 'adaptors/liteAdaptor.js');
  const {RegisterHTMLHandler} = require(p + 'handlers/html.js');
  require(p + 'input/tex/ams/AmsConfiguration.js');
  require(p + 'input/tex/textmacros/TextMacrosConfiguration.js');
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const mathDocument = mathjax.document('', {
    InputJax:new TeX({packages:['base','ams','textmacros']}),
    OutputJax:new MathJaxSVG({fontCache:'local'}),
  });
  let lastMathError = false;
  let lastMathViewBox;
  global.window = {MathJax:{
    texReset(){},
    tex2svg(text, options) {
      const rendered = adaptor.outerHTML(mathDocument.convert(text, options));
      lastMathError = rendered.includes('data-mjx-error');
      const wrapper = svgWindow.document.createElementNS('http://www.w3.org/1999/xhtml','div');
      wrapper.innerHTML = rendered;
      const svg = wrapper.querySelector('svg');
      lastMathViewBox = svg.getAttribute('viewBox').split(/\s+/).map(Number);
      // SVGDOM omits this browser SVGLength API, used only for baseline metadata.
      svg.height = {baseVal:{valueInSpecifiedUnits:parseFloat(svg.getAttribute('height'))}};
      return wrapper;
    },
  }};

  const main = {
    circuitComponents:[], symbols:[], switchMode(){},
    addComponent(component){this.circuitComponents.push(component)},
    removeComponent(component){component.remove();this.circuitComponents.splice(this.circuitComponents.indexOf(component),1)},
  };
  const environment = {getGlobalSettings:()=>({voltages:'european'}), toJson:()=>({}), fromJson(){}};
  Object.assign(internals, {
    MainController:{instance:main}, CanvasController:{instance:{canvas}},
    SelectionController:{instance:{referenceComponent:null, selectComponents(){}}},
    SnapCursorController:{instance:{visible:false}}, SnapDragHandler:{snapDrag(){}},
    EnvironmentVariableController:{instance:environment}, Modes:{DRAG_PAN:0},
    defaultStroke:'black', currentSaveVersion:1, SelectionMode:{RESET:0},
    strokeStyleChoices:[], arrowTips:[], TextAlign:{CENTER:1}, TextJustify:{CENTER:0},
    WireDirection:{Straight:0,HV:1,VH:2},
  });
  for (const file of [
    'properties/editableProperty.ts', 'properties/textProperty.ts',
    'properties/sectionHeaderProperty.ts', 'properties/buttonGridProperty.ts',
    'controllers/propertiesController.ts', 'components/circuitComponent.ts',
    'snapDrag/snapPoint.ts', 'controllers/undoController.ts',
  ]) Object.assign(internals, sourceModule('src/scripts/' + file));
  sourceModule('src/scripts/utils/impSVGNumber.ts');
  Object.assign(internals, sourceModule('src/scripts/utils/textHelper.ts'));
  Object.assign(internals, sourceModule('src/scripts/components/simpleTextComponent.ts'));
  internals.SaveController = {fromJson:data=>internals.CircuitComponent.fromJson(data)};
  const {SimpleTextComponent, CircuitComponent, Undo, TextProperty} = internals;
  const {parseCircuiTikz} = sourceModule('src/scripts/utils/tikzImporter.ts');
  const cm = 96 / 2.54;
  const near = (actual, expected, tolerance=1e-5) => assert(Math.abs(actual-expected)<tolerance, `${actual} != ${expected}`);
  const checkFinite = component => {
    for (const v of [component.position.x,component.position.y,component.bbox.x,component.bbox.y,component.bbox.w,component.bbox.h])
      assert(Number.isFinite(v));
  };
  const edit = (property, value) => {
    const input = property.getHTMLElement().querySelector('input');
    input.value = value;
    input.dispatchEvent(new events('input', {bubbles:true}));
    return input;
  };
  const clear = () => {for (const c of [...main.circuitComponents]) main.removeComponent(c)};
  const checks = [];
  function test(name, run) {run();checks.push(name)}

  const component = new SimpleTextComponent();
  test('Only content/x/y are editable', () => {
    const fields = [...component.properties.values()].flat().filter(p=>p instanceof TextProperty);
    assert.deepEqual(fields.map(p=>p.id), ['simpletext:content','simpletext:x','simpletext:y']);
  });
  test('One click places text at the TikZ center coordinate', () => {
    assert.equal(component.placeStep(new SVG.Point(-0.55*cm,-1.5*cm)), true);
    component.placeFinish();
    assert.equal(component.toTikzString(), '\\node at (-0.55, 1.5) {文本};');
    near(component.snappingPoints[0].x,-0.55*cm);
    near(component.snappingPoints[0].y,-1.5*cm);
    assert.equal(component.xProperty.value,'-0.55');
    assert.equal(component.yProperty.value,'1.5');
  });
  test('Decimal/negative/zero coordinates can be typed without rewriting intermediate input', () => {
    for (const value of ['1','1.','1.2','1.25']) assert.equal(edit(component.xProperty,value).value,value);
    assert.equal(component.toTikzString(), '\\node at (1.25, 1.5) {文本};');
    edit(component.yProperty,'-0.625');
    near(component.position.y,0.625*cm);
    edit(component.xProperty,'0');
    assert(component.toTikzString().includes('(0, -0.625)'));
    edit(component.xProperty,'1000.25');
    assert(component.toTikzString().includes('(1000.25, -0.625)'));
  });
  test('Invalid coordinates do not enter geometry and recover on blur', () => {
    const before = component.position.clone();
    for (const value of ['','-','NaN','Infinity','abc']) {
      const input = edit(component.xProperty,value);
      assert(component.position.eq(before));
      assert(input.classList.contains('is-invalid'));
      input.dispatchEvent(new events('focusout', {bubbles:true}));
      assert.equal(input.value,component.xProperty.value);
      checkFinite(component);
    }
  });

  const samples = [
    {x:-0.55,y:1.5,text:String.raw`\(U_1\)`},
    {x:7.15,y:1.5,text:String.raw`\(U_2\)`},
    {x:0.62,y:3.35,text:String.raw`\(I_1\)`},
    {x:5.98,y:3.35,text:String.raw`\(I_2\)`},
    {x:3.68,y:2.75,text:String.raw`\(M\)`},
    {x:3,y:3.25,text:String.raw`\textbf{1}`},
    {x:0.75,y:3.25,text:String.raw`\(+\)`},
    {x:1.5,y:2.5,text:String.raw`\(1\,\Omega\)`},
    {x:3.2,y:1.45,text:String.raw`\(N\)`},
    {x:5.55,y:2.65,text:String.raw`\(1:3\)`},
    {x:0,y:0,text:'文本内容'},
    {x:0,y:-1,text:'Input $U_1$'},
    {x:0,y:-2,text:String.raw`\(\frac{U_1}{I_2}\)`},
    {x:0,y:-3,text:String.raw`A \& B, 50\%`},
  ];
  const exported = [];
  for (const [index,spec] of samples.entries()) test(`Old diagram content and natural center ${index+1}`, () => {
    component.moveTo(new SVG.Point(spec.x*cm,-spec.y*cm));
    edit(component.textProperty,spec.text);
    assert.equal(lastMathError,false,spec.text);
    checkFinite(component);
    const layoutBox = new SVG.Box(...lastMathViewBox)
      .transform(component.componentVisualization.children()[0].matrixify())
      .transform(component.componentVisualization.matrixify()).transform(component.getTransformMatrix());
    near(layoutBox.cx,component.position.x);near(layoutBox.cy,component.position.y);
    const command = component.toTikzString();
    assert.equal(command,`\\node at (${spec.x}, ${spec.y}) {${spec.text}};`);
    exported.push({...spec,tikz:command});
    const saved = JSON.parse(JSON.stringify(component.toJson()));
    const restored = CircuitComponent.fromJson(saved);
    assert.equal(restored.toTikzString(),command);
    assert.equal(restored.textProperty.value,spec.text);
    assert.notEqual(restored.automationId,component.automationId);
    main.removeComponent(restored);
  });
  test('Natural preview width matches the measured 10pt TeX Hello box', () => {
    edit(component.textProperty,'Hello');component.moveTo(new SVG.Point(0,0));
    // XeLaTeX: \\setbox0=\\hbox{Hello} -> \\wd0=22.5pt.
    near(component.bbox.w,22.5*96/72.27);
  });
  test('Redrawing the same text does not accumulate transforms or MathJax definitions', () => {
    component.moveTo(new SVG.Point(0,0));
    const count = () => canvas.findOne('#backgroundDefs').children().length;
    const before = count();
    const beforeBox = JSON.stringify(component.componentVisualization.bbox());
    for (let i=0;i<10;i++) component.renderText();
    assert.equal(count(),before);
    assert.equal(JSON.stringify(component.componentVisualization.bbox()),beforeBox);
    const other = new SimpleTextComponent();
    const defs = new Map();component.toSVG(defs);
    main.removeComponent(other);
    for(const id of defs.keys()) assert(document.getElementById(id));
  });
  test('Copy, movement, rotation and flip preserve content and serialization', () => {
    component.rotate(90);component.flip(true);component.moveRel(new SVG.Point(cm,2*cm));
    const command=component.toTikzString();
    assert(command.startsWith('\\node[rotate=90, yscale=-1] at (1, -2)'));
    const copy=component.copyForPlacement();
    copy.moveTo(component.position);copy.placeFinish();
    assert.equal(copy.toTikzString(),command);
    const saved=JSON.parse(JSON.stringify(component.toJson()));
    main.removeComponent(component);
    const restored=CircuitComponent.fromJson(saved);
    assert.equal(restored.toTikzString(),command);
    assert.equal(restored.automationId,saved.automationId);
    main.removeComponent(copy);main.removeComponent(restored);
  });
  test('Empty and unfinished TeX remain editable, selectable and serializable', () => {
    const c=new SimpleTextComponent();
    for(const content of ['', '{}', String.raw`\(\)`, '\\(', '\\', '{', '$U_', '文本']) {
      edit(c.textProperty,content);checkFinite(c);
      assert.equal(c.toJson().text,content);
      assert(c.bbox.w>=12 && c.bbox.h>=12);
    }
    main.removeComponent(c);
  });
  test('Clearing content supports actual Undo/Redo and remains empty after reload', () => {
    const c=new SimpleTextComponent();Undo.addState();
    const input=c.textProperty.getHTMLElement().querySelector('input');
    input.dispatchEvent(new events('focusin',{bubbles:true}));
    edit(c.textProperty,'');input.dispatchEvent(new events('focusout',{bubbles:true}));
    assert.equal(Undo.getCurrentState().components[0].text,'');
    Undo.undo();assert.equal(main.circuitComponents[0].textProperty.value,'文本');
    Undo.redo();assert.equal(main.circuitComponents[0].textProperty.value,'');
    assert.equal(main.circuitComponents[0].toTikzString(),'\\node at (0, 0) {};');
    clear();
  });
  test('Bare old TikZ nodes import as simple text with raw LaTeX and unchanged coordinates', () => {
    const parsed=parseCircuiTikz(exported.map(s=>s.tikz).join('\n'));
    assert.equal(parsed.components.length,samples.length,JSON.stringify(parsed.warnings));
    for(const [i,data] of parsed.components.entries()) {
      assert.equal(data.type,'simpleText');assert.equal(data.text,samples[i].text);
      const c=CircuitComponent.fromJson(data);
      assert.equal(c.toTikzString(),exported[i].tikz);
      main.removeComponent(c);
    }
  });
  test('Anchored plain labels retain natural width and their original anchor', () => {
    const parsed=parseCircuiTikz(String.raw`\node[anchor=west] at (1,2) {hello};`);
      assert.equal(parsed.components[0].type,'simpleText');
      assert.equal(parsed.components[0].anchor,'west');
      const anchored=CircuitComponent.fromJson(parsed.components[0]);
      assert(anchored.bbox.x>=cm);
      assert(anchored.toTikzString().includes('anchor=west'));
      assert(!anchored.toTikzString().includes('text width'));
      anchored.remove();
  });
  test('Explicit formatted text boxes keep the rectangular text importer', () => {
      const parsed=parseCircuiTikz(String.raw`\node[anchor=west,font=\small,minimum width=2cm] at (1,2) {hello};`);
      assert.equal(parsed.components[0].type,'rect');
  });
  test('Imported environment scale and scope translation apply to simple text', () => {
    const parsed=parseCircuiTikz(String.raw`\begin{circuitikz}[scale=0.65,transform shape]
\begin{scope}[xshift=1cm,yshift=-1cm]\node at (1,2) {\(U_1\)};\end{scope}\end{circuitikz}`);
    assert.equal(parsed.components.length,1,JSON.stringify(parsed.warnings));
    const c=CircuitComponent.fromJson(parsed.components[0]);
    assert.equal(c.toTikzString(),String.raw`\node[xscale=0.65, yscale=0.65] at (1.3, 0.65) {\(U_1\)};`);
    near(c.getTransformMatrix().a,0.65);near(c.getTransformMatrix().d,0.65);
    main.removeComponent(c);
  });
  test('SVG export omits the transparent selection area and retains every glyph definition', () => {
    const c=new SimpleTextComponent();edit(c.textProperty,String.raw`\(U_1\)`);
    const defs=new Map(), svg=c.toSVG(defs);
    assert.equal(svg.find('.simple-text-hit-area').length,0);
    assert(defs.size>0);
    for(const use of svg.find('use')) {
      const id=(use.attr('href')??use.attr('xlink:href')).slice(1);
      assert(defs.has(id));
    }
    main.removeComponent(c);
    assert.equal(canvas.findOne('#backgroundDefs').children().length,0);
  });

  test('Natural multiline alignment survives import, copy and JSON reload', () => {
    for (const align of ['left','center','right']) {
      const parsed=parseCircuiTikz('\\node[align='+align+'] at (1,2) {A\\\\Longer label};');
      const data=parsed.components[0];
      assert.equal(data.type,'simpleText');assert.equal(data.align,align);
      const c=CircuitComponent.fromJson(data);checkFinite(c);assert.equal(lastMathError,false);
      const command=c.toTikzString();assert(command.includes('align='+align));assert(!command.includes('text width'));
      const copy=c.copyForPlacement();assert.equal(copy.toJson().align,align);
      const restored=CircuitComponent.fromJson(JSON.parse(JSON.stringify(c.toJson())));
      assert.equal(restored.toTikzString(),command);
      for (const item of [c,copy,restored]) main.removeComponent(item);
    }
  });
  test('Circuit environment options keep labels as natural text', () => {
    const parsed=parseCircuiTikz(String.raw`\begin{tikzpicture}[european voltages,voltage dir=noold]
\node[font=\small,anchor=west] at (1,2) {\(U\)};
\node[align=left] at (3,2) {\small 他励\\绕组};\end{tikzpicture}`);
    assert(parsed.components.every(c=>c.type==='simpleText'));
    assert.equal(parsed.components[1].align,'left');
    const c=CircuitComponent.fromJson(parsed.components[1]);checkFinite(c);assert.equal(lastMathError,false);
    assert(c.toTikzString().includes(String.raw`\small 他励\\绕组`));main.removeComponent(c);
  });
  test('Circle minimum dimensions remain a diameter and empty rectangles respect inner sep', () => {
    for(const dimension of ['width','height']) {
      const parsed=parseCircuiTikz('\\node[shape=circle,draw,inner sep=0pt,minimum '+dimension+'=1.215cm] at (2,2) {};');
      const c=parsed.components[0];assert.equal(c.type,'ellipse');near(c.size.x,c.size.y);assert(c.size.x>1.215*cm);
    }
    const parsed=parseCircuiTikz(String.raw`\node[shape=rectangle,draw,minimum width=.14cm,minimum height=.42cm] at (0,0) {};
\node[shape=rectangle,draw,inner sep=0pt,minimum width=.14cm,minimum height=.42cm] at (1,0) {};`);
    assert(parsed.components[0].size.x>parsed.components[1].size.x);
    near(parsed.components[0].size.y,parsed.components[1].size.y);
  });

  // A single sheet compiles actual component output with coordinate crosshairs.
  const sheet = exported.map((s,i) => {
    const x=(i%5)*2.4, y=-Math.floor(i/5)*1.5;
    const c=new SimpleTextComponent();edit(c.textProperty,s.text);c.moveTo(new SVG.Point(x*cm,-y*cm));
    const tikz=c.toTikzString();main.removeComponent(c);
    return `\\draw[gray!60,line width=.2pt] (${x-.16},${y}) -- (${x+.16},${y}) (${x},${y-.16}) -- (${x},${y+.16});\n${tikz}`;
  }).join('\n');
  fs.writeFileSync(path.join(out,'samples.tex'),`\\documentclass[10pt,tikz,border=8pt]{standalone}
\\usepackage{circuitikz}
\\usepackage{amsmath}
\\usepackage[fontset=windows]{ctex}
\\begin{document}
\\begin{tikzpicture}
${sheet}
\\end{tikzpicture}
\\end{document}
`);
  const results={date:'2026-10-25',kind:'Node DOM adapter integration; no browser UI',
    svgjs:JSON.parse(fs.readFileSync(path.join(root,'node_modules/@svgdotjs/svg.js/package.json'),'utf8')).version,
    mathjax:'3.2.2',checks,exported};
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:checks.length,out,kind:results.kind},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
