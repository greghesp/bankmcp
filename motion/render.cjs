// Render the loop: 4 subframes per frame, blended with ffmpeg tmix -> 60 fps motion blur.
// usage: node render.cjs [out.mp4] [--workers 4] [--frames a:b]
const path = require('path'), fs = require('fs'), { spawn, execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const FF = execSync(`python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"`).toString().trim();

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : 'out/loop.mp4';
const WORKERS = +opt('--workers', 4);
const SUB = 4, SHUTTER = 0.75, FPS = 60, DESIGN_T = 14;

const beats = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio/beats.json')));
const N = Math.round(beats.duration * FPS);                  // frames in the loop
const [F0, F1] = (opt('--frames', `0:${N}`)).split(':').map(Number);
const tmp = path.join(__dirname, 'out/chunks');
fs.mkdirSync(tmp, { recursive: true });

// design time for subframe k of frame f: the loop maps exactly onto N frames
const designT = (f, k) => ((f + ((k + 0.5) / SUB - 0.5) * SHUTTER) / N) * DESIGN_T;

async function worker(id, a, b) {
  const file = path.join(tmp, `c${String(id).padStart(2, '0')}.mkv`);
  const ff = spawn(FF, ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'png', '-i', '-',
    '-vf', `tmix=frames=${SUB}:weights=1 1 1 1,select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB`,
    '-r', String(FPS), '-c:v', 'ffv1', '-pix_fmt', 'rgb24', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1440 } });
  await page.goto('file://' + path.resolve(__dirname, 'index.html'));
  await page.evaluate(() => window.ready);
  for (let f = a; f < b; f++) {
    for (let k = 0; k < SUB; k++) {
      await page.evaluate(t => seek(t), designT(f, k));
      const png = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
    }
    if (id === 0 && (f - a) % 30 === 0) process.stdout.write(`\r${f - a}/${b - a} frames (worker 0)`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close();
  return file;
}

(async () => {
  const t0 = Date.now();
  const per = Math.ceil((F1 - F0) / WORKERS);
  const jobs = [];
  for (let i = 0; i < WORKERS; i++) {
    const a = F0 + i * per, b = Math.min(F1, a + per);
    if (a < b) jobs.push(worker(i, a, b));
  }
  const files = await Promise.all(jobs);
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, files.map(f => `file '${f}'`).join('\n'));
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const audio = path.join(__dirname, 'audio/mix.wav');
  const full = F0 === 0 && F1 === N;
  execSync([FF, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    ...(full ? ['-i', audio, '-map', '0:v', '-map', '1:a', '-af', `apad,atrim=0:${N / FPS}`, '-c:a', 'aac', '-b:a', '256k'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(FPS),
    ...(full ? ['-t', String(N / FPS)] : []), OUT].map(s => `"${s}"`).join(' '), { stdio: 'inherit' });
  console.log(`\n${OUT}: ${F1 - F0} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})();
