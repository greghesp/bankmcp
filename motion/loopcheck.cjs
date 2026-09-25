// Verify the loop: every track's value and velocity at t = 14 match t = 0,
// and the rendered DOM at t = 14 is identical to t = 0.
const path = require('path'), { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 1440 } });
  const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('ERR ' + e.message));
  await p.goto('file://' + path.resolve(__dirname, 'index.html')); await p.evaluate(() => window.ready);
  const r = await p.evaluate(() => {
    const h = 1e-4, T = window.DURATION;
    const snap = t => { seek(t); return document.body.innerHTML; };
    // unwrapped evaluation of every track just below T vs at 0 (mod() would make this trivially equal)
    let maxDv = 0, maxV = 0;
    for (const tr of ALL) {
      const a = tr.at(T - h), b = tr.at(0), c = tr.at(h);
      maxV = Math.max(maxV, Math.abs(b - a) / Math.max(1, Math.abs(b)));
      maxDv = Math.max(maxDv, Math.abs((b - a) - (c - b)) / h);
    }
    return { domEqual: snap(T) === snap(0), tracks: ALL.length, valueJumpAcrossSeam: maxV, velocityJumpAcrossSeam: maxDv };
  });
  console.log(JSON.stringify(r), logs.join('\n'));
  await b.close();
})();
