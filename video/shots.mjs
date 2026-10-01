// Product screenshots for the pitch deck: the phone alone, on a transparent background, at 2x.
//   node video/shots.mjs <out-dir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = process.argv[2] || path.join(here, 'shots');
fs.mkdirSync(outDir, { recursive: true });
// [seconds into the film, file name]
const SHOTS = [[7.5, 'phone-feed'], [12.4, 'phone-confidence'], [24.0, 'phone-forecast'], [41.5, 'phone-ranks'], [47.0, 'phone-rewards']];

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bnoc-chrome-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, '--window-size=1920,1080', '--hide-scrollbars',
  '--allow-file-access-from-files', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 100 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(150); }
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await send('Page.navigate', { url: 'file://' + path.join(here, 'intro.html') });
for (let i = 0; i < 100; i++) {
  if (await evaluate('document.readyState === "complete" && window.__ready === true').catch(() => false)) break;
  await sleep(150);
}
await evaluate('document.fonts.ready.then(() => true)');
// Everything but the phone disappears, and the page itself goes transparent.
await evaluate(`(() => { const st = document.createElement('style'); st.textContent = \`
  html, body, #stage { background: transparent !important }
  #ring, #blob, #blob2, #bigNum, .cap, #later, #panel, #plus, #prize, #winStamp, #tagline6, #particles,
  #band1, #band2, #intro, #wipeCoral, #wipeLav, #outro, #fadeOut, #tap { display: none !important }
  #phoneWrap .phone { box-shadow: 0 30px 50px -24px rgba(45,27,61,.45) !important }\`; document.head.appendChild(st); return true; })()`);

for (const [t, name] of SHOTS) {
  await evaluate(`render(${t})`);
  const r = await evaluate(`(() => { const b = document.querySelector('#phoneWrap .phone').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const clip = { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 10), width: r.w + 48, height: Math.min(1080 - Math.max(0, r.y - 10), r.h + 60), scale: 1 };
  const shot = await send('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(shot.result.data, 'base64'));
  console.log(name, Math.round(clip.width * 2) + 'x' + Math.round(clip.height * 2));
}
ws.close(); chrome.kill(); await sleep(800);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ }
