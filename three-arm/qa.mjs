// Headless functional QA for the delivered single-file page, driven through CDP.
// The page exposes __arm.setAuto(false) + __arm.step(dt, n) so tests are
// deterministic even when headless Chrome throttles requestAnimationFrame.
// Usage: node qa.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9000 + Math.floor(Math.random() * 800);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'shots');
const PROFILE = path.join(os.tmpdir(), `epq-arm-qa-${Date.now()}`);
const URL_ = pathToFileURL(path.resolve(ROOT, '..', 'index.html')).href;
fs.mkdirSync(OUT, { recursive: true });
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
  '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1600,1000', '--force-device-scale-factor=1',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, URL_
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith('file://'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('devtools not reachable');
}

const page = await waitForDevtools();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let id = 0;
const pending = new Map();
const errors = [];
const consoleLines = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' && !/favicon/i.test(e.text)) errors.push(`${e.source}: ${e.text}`);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.bringToFront');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

async function evaluate(expression, awaitPromise = false) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description || ''));
  return res.result.value;
}
async function step(seconds) {
  const frames = Math.max(1, Math.round(seconds * 60));
  await evaluate(`__arm.step(1/60, ${frames})`);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  screenshot', name);
}

const report = [];
function check(label, condition, detail = '') {
  report.push({ label, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- run tests
await sleep(400);
const booted = await evaluate('!!window.__arm');
check('app booted', booted);
// wait for the embedded CAD model to load
let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await evaluate('!!window.__armReady');
  if (ready) break;
  await sleep(250);
}
check('CAD model loaded', ready);
const cad = await evaluate('({name: __arm.arm.root.name, joints: __arm.arm.joints.length, meshes: (() => { let n=0; __arm.arm.root.traverse(o => { if (o.isMesh) n++; }); return n; })()})');
check('GLB hierarchy present', String(cad.name).startsWith('EPQ_ARM') && cad.joints === 5, JSON.stringify(cad));
check('CAD meshes present', cad.meshes > 20, 'meshes=' + cad.meshes);
await evaluate('__arm.setAuto(false)');

// intro frames (deterministic)
await step(0.5);
let introState = await evaluate('({active: __arm.state.mode, camZ: +__arm.camera.position.z.toFixed(2)})');
check('intro camera dolly running', introState.camZ > 1.4, JSON.stringify(introState));
await screenshot('qa-00-intro-a');
await step(1.0);
await screenshot('qa-00-intro-b');
await step(1.7);

// showcase
await step(0.8);
let state = await evaluate('({mode: __arm.state.mode, runner: !!__arm.state.runner, angles: __arm.state.angles.map(a => +(a*180/Math.PI).toFixed(1)), canvas: !!document.querySelector("canvas"), joints: document.querySelectorAll("#joints .joint").length, labels: document.querySelectorAll(".lbl").length, err: !!document.getElementById("__err")})');
check('WebGL canvas present', state.canvas);
check('five joint controls built', state.joints === 5, String(state.joints));
check('five joint labels built', state.labels === 5, String(state.labels));
check('no in-page JS error banner', !state.err);
check('showcase running after intro', state.mode === 'showcase' && state.runner, JSON.stringify(state.mode));

const a0 = state.angles;
let changed = false, lastAngles = a0;
for (let k = 0; k < 6 && !changed; k++) {
  await step(0.6);
  const sample = await evaluate('__arm.state.angles.map(a => +(a*180/Math.PI).toFixed(1))');
  lastAngles = sample;
  changed = sample.some((v, i) => Math.abs(v - a0[i]) > 0.5);
}
check('arm is animating', changed, JSON.stringify(lastAngles));
const trailCount = await evaluate('(() => { const l = __arm.scene.children.find(o => o.isLine && o.geometry && o.geometry.attributes.position); return l ? l.geometry.drawRange.count : -1; })()');
check('end-effector motion trail accumulating', trailCount > 20, `points=${trailCount}`);
const perf = await evaluate('({calls: __arm.renderer.info.render.calls, tris: __arm.renderer.info.render.triangles})');
check('draw calls reasonable', perf.calls < 400, JSON.stringify(perf));
check('triangle count reasonable', perf.tris < 300000, JSON.stringify(perf));
await screenshot('qa-01-showcase');

// pause
await evaluate('document.getElementById("pause").click()');
await step(0.5);
let st = await evaluate('({paused: __arm.state.paused, cap: document.getElementById("cap-text").textContent})');
check('pause toggles', st.paused === true, st.cap);
await evaluate('document.getElementById("pause").click()');

// range test via button
await evaluate('document.querySelector("[data-mode=range]").click()');
await step(1.4);
state = await evaluate('({mode: __arm.state.mode, active: __arm.state.activeJoint, cap: document.getElementById("cap-text").textContent, note: document.getElementById("mode-note").textContent})');
check('range mode engages', state.mode === 'range', JSON.stringify(state));
check('range test highlights a joint', state.active >= 0, `active=${state.active}`);
check('range caption updates', /J\d/.test(state.cap), state.cap);
await screenshot('qa-02-range');

await step(9.0);
state = await evaluate('({angles: __arm.state.angles.map(a => +(a*180/Math.PI).toFixed(1)), active: __arm.state.activeJoint, cap: document.getElementById("cap-text").textContent})');
check('range sweep moves joints', state.angles.some(a => Math.abs(a) > 5), JSON.stringify(state));
await screenshot('qa-03-range-sweep');

// manual slider
await evaluate(`(() => { const s = document.querySelectorAll('#joints input[type=range]')[2]; s.value = 95; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await step(1.5);
state = await evaluate('({mode: __arm.state.mode, j3: +(__arm.state.angles[2]*180/Math.PI).toFixed(1), target: +(__arm.state.targets[2]*180/Math.PI).toFixed(1)})');
check('slider switches to manual', state.mode === 'manual', JSON.stringify(state));
check('slider drives J3', Math.abs(state.j3 - 95) < 3, JSON.stringify(state));
await screenshot('qa-04-manual');

// toggles
await evaluate('document.getElementById("t-axes").click(); document.getElementById("t-labels").click();');
await step(0.2);
await sleep(1100);
const toggles = await evaluate('({axes: __arm.state.axes, labels: __arm.state.labels, arrows: __arm.arm.joints.filter(j => j.children.some(c => c.type === "ArrowHelper")).length, labelOpacity: getComputedStyle(document.getElementById("labels")).opacity})');
check('joint axes toggle', toggles.axes && toggles.arrows === 5, JSON.stringify(toggles.axes));
check('labels toggle hides labels', toggles.labelOpacity === '0', `opacity=${toggles.labelOpacity}`);
await screenshot('qa-05-axes');
await evaluate('document.getElementById("t-axes").click(); document.getElementById("t-labels").click();');

// home button
await evaluate('document.querySelector("[data-mode=home]").click()');
await step(2.2);
state = await evaluate('({mode: __arm.state.mode, angles: __arm.state.angles.map(a => +(a*180/Math.PI).toFixed(1)), active: __arm.state.activeJoint})');
check('home returns to home pose + manual', state.mode === 'manual' && state.angles.every(v => Math.abs(v) < 1.5), JSON.stringify(state));

// camera presets
await evaluate('document.querySelector("[data-view=profile]").click()');
await step(1.4);
const cam = await evaluate('({x: +__arm.camera.position.x.toFixed(2), y: +__arm.camera.position.y.toFixed(2), z: +__arm.camera.position.z.toFixed(2)})');
check('profile camera preset', cam.x > 1.2, JSON.stringify(cam));
await screenshot('qa-06-profile');

// hide UI (CSS transition runs in real time)
await evaluate('document.getElementById("hide-ui").click()');
await sleep(1100);
await step(0.1);
const hidden = await evaluate('({cls: document.body.className})');
check('hide UI', hidden.cls.includes('ui-hidden'), JSON.stringify(hidden));
await evaluate('document.getElementById("show-ui").click()');
await sleep(500);

// resize responsiveness
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await evaluate('window.dispatchEvent(new Event("resize"))');
await sleep(300);
await step(0.2);
const resized = await evaluate('({w: __arm.renderer.domElement.width, h: __arm.renderer.domElement.height})');
check('renderer resizes', resized.w === 1280 && resized.h === 720, JSON.stringify(resized));
await screenshot('qa-07-1280x720');
await send('Emulation.clearDeviceMetricsOverride');

// ---------------------------------------------------------- mobile layout
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
await send('Page.reload');
await sleep(900);
let mobileReady = false;
for (let i = 0; i < 80; i++) {
  try { mobileReady = await evaluate('!!window.__armReady'); } catch { mobileReady = false; }
  if (mobileReady) break;
  await sleep(250);
}
check('mobile page loads', mobileReady);
await evaluate('__arm.setAuto(false); __arm.step(0.02, 30);');
const mobileInit = await evaluate(`({
  open: document.body.classList.contains('panel-open'),
  opacity: getComputedStyle(document.getElementById('panel')).opacity,
  toggle: getComputedStyle(document.getElementById('panel-toggle')).display,
  overflow: document.documentElement.scrollWidth - innerWidth
})`);
check('mobile panel hidden by default', !mobileInit.open && mobileInit.opacity === '0' && mobileInit.toggle !== 'none', JSON.stringify(mobileInit));
check('mobile no horizontal overflow', mobileInit.overflow <= 1, JSON.stringify(mobileInit));
await evaluate('document.getElementById("panel").style.transition = "none"; document.getElementById("stage").style.transition = "none"; document.getElementById("labels").style.transition = "none";');
await evaluate('document.getElementById("panel-toggle").click()');
await sleep(250);
await evaluate('window.dispatchEvent(new Event("resize")); __arm.step(0.02, 10);');
await sleep(350);
const mobileOpen = await evaluate(`({
  open: document.body.classList.contains('panel-open'),
  opacity: getComputedStyle(document.getElementById('panel')).opacity,
  expanded: document.getElementById('panel-toggle').getAttribute('aria-expanded'),
  canvasH: __arm.renderer.domElement.clientHeight,
  viewportH: innerHeight,
  labelsOpacity: getComputedStyle(document.getElementById('labels')).opacity
})`);
check('mobile controls sheet opens', mobileOpen.open && mobileOpen.opacity === '1' && mobileOpen.expanded === 'true', JSON.stringify(mobileOpen));
check('mobile 3D view shrinks above the sheet', mobileOpen.canvasH > 0 && mobileOpen.canvasH < mobileOpen.viewportH * 0.7, JSON.stringify(mobileOpen));
check('mobile labels hidden while posing', mobileOpen.labelsOpacity === '0', JSON.stringify(mobileOpen.labelsOpacity));
await screenshot('qa-08-mobile-controls');
await evaluate('document.getElementById("panel-close").click()');
await sleep(300);
await evaluate('window.dispatchEvent(new Event("resize")); __arm.step(0.02, 5);');
await sleep(200);
const mobileClosed = await evaluate('({ open: document.body.classList.contains("panel-open"), opacity: getComputedStyle(document.getElementById("panel")).opacity })');
check('mobile controls close', !mobileClosed.open && parseFloat(mobileClosed.opacity) < 0.05, JSON.stringify(mobileClosed));
await send('Emulation.clearDeviceMetricsOverride');

check('no runtime errors', errors.length === 0, errors.join(' | ').slice(0, 400));

fs.writeFileSync(path.join(ROOT, 'qa-report.json'), JSON.stringify({ report, errors, consoleLines }, null, 2));
console.log('\nErrors:', errors.length ? errors : 'none');
const failed = report.filter(r => !r.ok);
console.log(`\n${report.length - failed.length}/${report.length} checks passed`);
chrome.kill();
ws.close();
process.exit(failed.length ? 1 : 0);
