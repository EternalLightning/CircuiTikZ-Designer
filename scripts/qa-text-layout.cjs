// Reproduction-only harness. Uses the running editor, without changing application sources.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('../.qa-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'qa-results', 'text-layout');
fs.mkdirSync(out, { recursive: true });

const cases = [];
function add(id, options = {}) {
  cases.push({ id, width: 160, height: 80, text: 'Hello world', align: 0, justify: -1,
    fontSize: 'normalsize', innerSep: '5pt', rotation: 0, strokeWidth: '1pt',
    scale: {x:1,y:1}, ...options });
}
for (const align of [0,1,2]) for (const justify of [-1,0,1])
  add(`align-${align}-${justify}`, { align, justify });
add('multiline-top', { text:'First line\nSecond line\nThird line' });
add('multiline-center', { text:'First line\nSecond line\nThird line', justify:0 });
add('multiline-bottom', { text:'First line\nSecond line\nThird line', justify:1 });
add('wrap-left', { text:'The quick brown fox jumps over the lazy dog. The quick brown fox jumps.' });
add('wrap-justify', { text:'The quick brown fox jumps over the lazy dog. The quick brown fox jumps.', align:3 });
add('justify-short', { text:'One two three', align:3 });
add('narrow-word', { text:'Electromagnetism', width:65 });
add('hyphen-off', { text:'Electromagnetic synchronization characterization', width:100 });
add('hyphen-on', { text:'Electromagnetic synchronization characterization', width:100, useHyphenation:true });
for (const fontSize of ['tiny','small','large','Huge']) add(`font-${fontSize}`, {fontSize});
for (const innerSep of ['0pt','10pt']) add(`padding-${innerSep}`, {innerSep});
for (const strokeWidth of ['0pt','4pt']) add(`stroke-${strokeWidth}`, {strokeWidth});
for (const rotation of [45,90,180,270]) add(`rotate-${rotation}`, {rotation});
add('overflow-height', {text:'First line\nSecond line\nThird line', height:15, justify:0});
add('overflow-width', {text:'Hello', width:10, innerSep:'10pt'});
add('math', {text:'Input $V_{in}$ and $R_1$'});
add('math-tall', {text:'Gain $\\dfrac{V_o}{V_i}$\nOutput $V_o$'});
add('chinese', {text:'输入电压 输出电流'});
add('xml-characters', {text:'A < B & C > D'});
add('font-fallback', {text:'Hello world', forceFallback:true});
add('scale-2', {scale:{x:2,y:2}});
add('scale-x', {scale:{x:2,y:1}});
add('save-zero-padding', {innerSep:'0pt'});
add('placeholder-empty', {text:'',showPlaceholderText:true});

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/www.googletagmanager.com/**',r=>r.abort());
    await page.goto(process.env.QA_EDITOR_URL || 'http://localhost:1234',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.mainController?.isInitDone,{timeout:60000});
    await page.evaluate(async()=>{await document.fonts.load('10pt "Computer Modern Serif"'); await document.fonts.ready;});
    const environment=await page.evaluate(()=>({url:location.href,userAgent:navigator.userAgent,
      fontLoaded:document.fonts.check('10pt "Computer Modern Serif"'),
      fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),
      devicePixelRatio:devicePixelRatio}));
    await page.evaluate(()=>{
      document.querySelector('.libComponent[title="文本"]').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      window.qaRectConstructor=window.mainController.circuitComponents.at(-1).constructor;
      for(const c of [...window.mainController.circuitComponents])c.remove();
    });
    const results=[];
    for(const spec of cases){
      const result=await page.evaluate(spec=>{
        const main=window.mainController;
        for(const c of [...main.circuitComponents])c.remove();
        const data={type:'rect',position:{x:0,y:0},size:{x:spec.width,y:spec.height},
          rotation:spec.rotation,scale:spec.scale,stroke:{opacity:0,width:spec.strokeWidth},
          text:{text:spec.text,align:spec.align,justify:spec.justify,fontSize:spec.fontSize,
            innerSep:spec.innerSep,showPlaceholderText:spec.showPlaceholderText||false,
            useHyphenation:spec.useHyphenation||false}};
        const c=new window.qaRectConstructor(true); c.applyJson(data);
        if(spec.forceFallback){
          const original=document.createElement.bind(document);
          const prototype=HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext=function(...args){
            const ctx=prototype.apply(this,args);
            if(args[0]==='2d'){
              const measure=ctx.measureText.bind(ctx);
              ctx.measureText=function(t){this.font=this.font.replace('"Computer Modern Serif"','"Times New Roman"');return measure(t)};
            }
            return ctx;
          };
          try{c.update()}finally{HTMLCanvasElement.prototype.getContext=prototype}
          c.textSVG.find('text').forEach(t=>t.attr('font-family','Times New Roman'));
        }
        const serializeBox=b=>({x:b.x,y:b.y,width:b.width,height:b.height});
        const spans=[...c.textSVG.find('tspan')].map(s=>{
          const node=s.node,local=node.getStartPositionOfChar(0),matrix=node.getCTM();
          const canvasMatrix=main.canvasController.canvas.node.getCTM().inverse();
          const world=new DOMPoint(local.x,local.y).matrixTransform(matrix).matrixTransform(canvasMatrix);
          return {text:node.textContent,x:world.x,y:world.y,
            localX:local.x,localY:local.y,fontSize:getComputedStyle(node).fontSize,
            bbox:serializeBox(node.getBBox())};
        });
        const saved=c.toJson();
        const tikz=c.toTikzString();
        const beforeInnerSep=c.textInnerSep.value.toString();
        let roundtripInnerSep;
        if(spec.id==='save-zero-padding'){
          const r=new window.qaRectConstructor(true); r.applyJson(JSON.parse(JSON.stringify(saved)));
          roundtripInnerSep=r.textInnerSep.value.toString(); r.remove();
        }
        document.getElementById('qa-preview')?.remove();
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.id='qa-preview';svg.setAttribute('viewBox','-180 -120 360 240');
        svg.setAttribute('width','720');svg.setAttribute('height','480');
        svg.style.cssText='position:fixed;top:0;left:0;z-index:2147483647;background:white;--bs-emphasis-color:black;--bs-body-bg:white;color:black';
        const defs=main.canvasController.canvas.node.querySelector('defs');if(defs)svg.append(defs.cloneNode(true));
        const guide=document.createElementNS(svg.namespaceURI,'rect');
        for(const [k,v] of Object.entries({x:-spec.width/2,y:-spec.height/2,width:spec.width,height:spec.height,
          fill:'none',stroke:'#b9c5d0','stroke-width':0.4,'stroke-dasharray':'3 2',
          transform:`rotate(${-spec.rotation}) scale(${spec.scale.x} ${spec.scale.y})`}))guide.setAttribute(k,v);
        svg.append(guide,c.visualization.node.cloneNode(true));document.body.append(svg);
        return {spec,input:data,saved,tikz,spans,beforeInnerSep,roundtripInnerSep,
          textBBox:serializeBox(c.textSVG.bbox()),svg:svg.outerHTML};
      },spec);
      await page.locator('#qa-preview').screenshot({path:path.join(out,`${spec.id}-preview.png`)});
      fs.writeFileSync(path.join(out,`${spec.id}-preview.svg`),result.svg);
      delete result.svg;
      results.push(result);
    }
    // Check the actual export controller in addition to individual component export.
    await page.evaluate(input=>{
      document.getElementById('qa-preview')?.remove();
      for(const c of [...window.mainController.circuitComponents])c.remove();
      const c=new window.qaRectConstructor(true);c.applyJson(input);
      document.getElementById('exportCircuiTikZButton').click();
    },results[0].input);
    const controllerExport=await page.locator('#exportedContent').inputValue();
    assert(controllerExport.includes(results[0].tikz), 'Actual export controller must preserve the tested node command');
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({environment,errors,controllerExport,results},null,2));
    const body=results.map(r=>{
      const {spec,tikz}=r;
      const w=(spec.width/2*2.54/96).toFixed(7), h=(spec.height/2*2.54/96).toFixed(7);
      const guide=`\\draw[gray!50,dashed,line width=0.3pt,rotate=${spec.rotation},xscale=${spec.scale.x},yscale=${spec.scale.y}] (-${w},-${h}) rectangle (${w},${h});`;
      return `% CASE ${spec.id}\n\\begin{tikzpicture}[transform shape]\n\\path[use as bounding box] (-4.7625,-3.175) rectangle (4.7625,3.175);\n${guide}\n${tikz}\n\\end{tikzpicture}`;
    }).join('\n');
    for(const [name,options,packages] of [['compiled-10pt','10pt',''],['compiled-12pt','12pt','']]){
      const source=`\\documentclass[${options},tikz,multi=tikzpicture,border=0pt]{standalone}\n\\usepackage{circuitikz}\n\\usepackage{amsmath}\n\\usepackage[fontset=windows]{ctex}\n${packages}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0pt}\n\\begin{document}\n${body}\n\\end{document}\n`;
      fs.writeFileSync(path.join(out,`${name}.tex`),source);
      fs.writeFileSync(path.join(out,name.replace('compiled-','compiled-plain-')+'.tex'),
        source.replace('\\usepackage[fontset=windows]{ctex}\n',''));
    }
    console.log(JSON.stringify({cases:results.length,environment,errors,out,
      example:results[0],saveZero:results.find(r=>r.spec.id==='save-zero-padding')},null,2));
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
