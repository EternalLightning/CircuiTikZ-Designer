const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('../.qa-tools/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf'};
const server = http.createServer((req, res) => {
  const file = path.join(root, 'dist', decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(path.join(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({channel:'msedge', headless:true});
  const results = [];
  try {
    for (const offline of [false, true]) {
      const context = await browser.newContext({viewport:{width:1440, height:1000}});
      const page = await context.newPage();
      const external = [], errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        // Antivirus injects its own script into local HTTP responses on this host.
        // Block that unrelated traffic in both modes so it does not skew app measurements.
        if (new URL(route.request().url()).hostname.endsWith('.kaspersky-labs.com')) return route.abort();
        if (!new URL(route.request().url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) {
          external.push(route.request().url());
          if (offline || route.request().url().includes('googletagmanager')) return route.abort();
        }
        return route.continue();
      });
      for (let run = 0; run < (baseline ? 1 : 2); run++) {
        const started = Date.now();
        await page.goto(`http://127.0.0.1:${server.address().port}`, {waitUntil:'commit', timeout:20000});
        let ready = true;
        try { await page.waitForFunction(() => window.mainController?.isDocumentReady, {timeout: baseline ? 15000 : 10000}); } catch { ready = false; }
        const ms = Date.now() - started;
        let details;
        if (ready) details = await page.evaluate(async () => {
          await document.fonts.load('24px "Material Symbols Outlined"');
          const formula = MathJax.tex2svg(String.raw`\frac{U}{R}+\text{test}`);
          return {symbols:window.mainController.symbols.length, math:!!formula.querySelector('svg'), mathErrors:formula.querySelectorAll('[data-mml-node="merror"]').length,
            icons:document.fonts.check('24px "Material Symbols Outlined"'), serif:document.fonts.check('12px "Computer Modern Serif"'),
            spinnerHidden:document.getElementById('loadingSpinner').classList.contains('d-none')};
        });
        results.push({offline, run, ready, ms, details, external:[...new Set(external)], errors:[...errors]});
        console.log(JSON.stringify(results.at(-1)));
        if (!baseline) {
          assert(ready, 'Application must initialize even with external requests blocked');
          assert.equal(external.length, 0, 'Startup must use only local resources');
          assert.deepEqual(errors, []);
          assert(details.symbols > 100 && details.math && !details.mathErrors && details.icons && details.serif && details.spinnerHidden);
          if (offline && run === 0) await page.screenshot({path:path.join(root, 'qa-results/startup-offline.png')});
        }
      }
      await context.close();
    }
    if (!baseline) {
      const page = await browser.newPage();
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1' || /\/tex-svg\.[^/]+\.js$/.test(url.pathname)) return route.abort();
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`, {waitUntil:'domcontentloaded'});
      await page.waitForFunction(() => document.querySelector('#loadingSpinner[role="alert"]')?.textContent.includes('加载失败'));
      assert.equal(await page.evaluate(() => window.mainController.isInitDone), false);
      results.push({missingMathJax: 'visible load failure instead of an endless spinner'});
      console.log('Missing MathJax: load failure is visible');
      await page.close();
    }
  } finally {
    fs.mkdirSync(path.join(root, 'qa-results'), {recursive:true});
    fs.writeFileSync(path.join(root, `qa-results/startup-${baseline ? 'before' : 'after'}.json`), JSON.stringify(results, null, 2));
    await browser.close(); server.close();
  }
})().catch(e => {console.error(e); process.exitCode=1; server.close();});
