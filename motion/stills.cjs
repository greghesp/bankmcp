// Render one frame per beat (plus any extra times) to PNG for review.
const path = require('path');
const { chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'));
(async () => {
  const out = process.argv[2] || 'stills';
  const times = process.argv[3] ? process.argv[3].split(',').map(Number) : Array.from({ length: 28 }, (_, i) => i * 0.5);
  require('fs').mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1440 } });
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('ERR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, 'index.html'));
  await page.evaluate(() => window.ready);
  for (const t of times) {
    await page.evaluate(t => seek(t), t);
    await page.screenshot({ path: `${out}/t${t.toFixed(3).padStart(6, '0')}.png` });
  }
  if (logs.length) console.log(logs.join('\n'));
  await browser.close();
})();
