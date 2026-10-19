// Generate presentation-ready 1920x1080 stills from the delivered page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9000 + Math.floor(Math.random() * 800);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(ROOT, '..', 'previews');
const PROFILE = path.join(os.tmpdir(), `epq-arm-preview-${Date.now()}`);
const URL_ = pathToFileURL(path.resolve(ROOT, '..', 'index.html')).href;
fs.mkdirSync(OUT, { recursive: true });
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--window-size=1920,1080', '--force-device-scale-factor=1',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, URL_
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function devtools() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith('file://'));
      if (page) return page;
    } catch {}
    await sleep(150);
  }
  throw new Error('devtools unreachable');
}
const page = await devtools();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}
async function step(sec) { await evaluate(`__arm.step(1/60, ${Math.round(sec * 60)})`); }
async function shot(name) {
  await sleep(350);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('wrote', name);
}

await sleep(400);
for (let i = 0; i < 60; i++) {
  if (await evaluate('!!window.__armReady')) break;
  await sleep(250);
}
await evaluate('__arm.setAuto(false)');
await step(3.2);                       // finish intro, showcase starts
await evaluate('document.getElementById("t-trail").click()');   // clean stills, no trail
await evaluate('__arm.setAngles([0, 0, 0, 0, 0]); __arm.flyTo("iso", true)');
await step(0.8);
await shot('EPQ-Arm-hero-ui');
await evaluate('document.getElementById("hide-ui").click()');
await evaluate('document.body.classList.add("no-hint")');
await sleep(700); await evaluate('__arm.step(1/60,2)');
await shot('EPQ-Arm-hero-clean');
await evaluate('document.getElementById("show-ui").click(); document.body.classList.remove("no-hint");');
await sleep(500);

// range test still (running, not paused)
await evaluate('document.querySelector("[data-mode=range]").click()');
await step(11.0);
await shot('EPQ-Arm-range');

// manual pose showing the wrist roll
await evaluate('document.querySelector("[data-mode=manual]").click()');
await evaluate(`(() => {
  const vals = [26, 34, 22, 48, 40];
  document.querySelectorAll('#joints input[type=range]').forEach((s, i) => {
    s.value = vals[i]; s.dispatchEvent(new Event('input', {bubbles:true}));
  });
})()`);
await step(1.6);
await shot('EPQ-Arm-manual');

chrome.kill(); ws.close();
console.log('previews done');
