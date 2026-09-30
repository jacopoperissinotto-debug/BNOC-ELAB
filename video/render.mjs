// Films video/intro.html frame by frame in headless Chrome (no extra installs: uses the Chrome
// already on this Mac via its DevTools protocol), saving numbered JPEGs for encode.swift.
//   node video/render.mjs                 -> every frame of the whole video into video/frames/
//   node video/render.mjs 3.2 17 40       -> just stills at those seconds (for checking)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FPS = 30, W = 1920, H = 1080;
const here = path.dirname(new URL(import.meta.url).pathname);
const stills = process.argv.slice(2).map(Number);
const outDir = process.env.OUT_DIR || path.join(here, 'frames');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bnoc-chrome-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, '--hide-scrollbars',
  '--force-device-scale-factor=1', '--allow-file-access-from-files', `--user-data-dir=${profile}`, 'about:blank'
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
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + path.join(here, 'intro.html') });
for (let i = 0; i < 100; i++) {
  if (await evaluate('document.readyState === "complete" && window.__ready === true').catch(() => false)) break;
  await sleep(150);
}
await evaluate('document.fonts.ready.then(() => true)');
const duration = await evaluate('window.DURATION');

const times = stills.length ? stills : Array.from({ length: Math.round(duration * FPS) }, (_, i) => i / FPS);
const started = Date.now();
for (let i = 0; i < times.length; i++) {
  await evaluate(`render(${times[i]})`);
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  const name = stills.length ? `still-${String(times[i]).replace('.', '_')}.jpg` : `f${String(i).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.result.data, 'base64'));
  if (!stills.length && i % 150 === 0) console.log(`frame ${i}/${times.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
console.log(`saved ${times.length} frame(s) to ${outDir}`);
ws.close();
chrome.kill();
await sleep(800);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing; the OS cleans temp files */ }
