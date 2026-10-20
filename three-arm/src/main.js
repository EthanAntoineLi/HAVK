// EPQ 5-DOF robotic arm — interactive three.js visualisation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadArm } from './realArm.js';
import {
  JOINTS, RAD, DEG, homePose,
  createShowcase, createRangeTest, createHomeMove, easeInOut
} from './motion.js';
import { createUI } from './ui.js';

// ------------------------------------------------------------------- setup
const params = new URLSearchParams(location.search);
const SHOT = params.has('shot');
const NO_UI = params.get('ui') === '0';
const MOBILE_MQ = window.matchMedia('(max-width: 760px), (max-height: 560px)');
const isMobileLayout = () => MOBILE_MQ.matches;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(stage.clientWidth || window.innerWidth, stage.clientHeight || window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = null;

const camera = new THREE.PerspectiveCamera(36, (stage.clientWidth || window.innerWidth) / (stage.clientHeight || window.innerHeight), 0.01, 30);
camera.position.set(1.7, 1.05, 1.95);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.11, 0.31, 0.0);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.75;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.55;
controls.minDistance = 0.55;
controls.maxDistance = 3.4;
controls.maxPolarAngle = Math.PI * 0.492;
controls.autoRotateSpeed = 0.75;
controls.enabled = false;

// environment reflections
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new RoomEnvironment();
scene.environment = pmrem.fromScene(envScene, 0.04).texture;
scene.environmentIntensity = 0.8;

// lights
scene.add(new THREE.HemisphereLight(0xFFFFFF, 0xE4ECF5, 1.15));
const key = new THREE.DirectionalLight(0xFFF6EC, 3.2);
key.position.set(1.15, 1.75, 0.95);
key.castShadow = false;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -1.1;
key.shadow.camera.right = 1.1;
key.shadow.camera.top = 1.2;
key.shadow.camera.bottom = -0.9;
key.shadow.camera.near = 0.2;
key.shadow.camera.far = 5;
key.shadow.bias = -0.00035;
key.shadow.normalBias = 0.03;
key.shadow.radius = 4;
key.shadow.intensity = 0.72;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9FC4E8, 1.2);
fill.position.set(-1.7, 0.75, 0.9);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x0A7194, 1.3);
rim.position.set(-1.3, 1.2, -1.5);
scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xC2410C, 0.9);
rim2.position.set(1.5, 0.75, -1.4);
scene.add(rim2);
const bounce = new THREE.DirectionalLight(0xD3DDE8, 0.6);
bounce.position.set(0.3, -1.0, 0.8);
scene.add(bounce);
const frontFill = new THREE.DirectionalLight(0xFFFFFF, 0.9);
frontFill.position.set(-0.4, 0.35, 2.0);
scene.add(frontFill);

// --------------------------------------------------------------------- arm
// Placeholder arm so the UI / motion logic can be built before the CAD model
// finishes loading; it is replaced by the real GLB arm in boot().
let arm = {
  root: new THREE.Group(),
  joints: [0, 1, 2, 3, 4].map(() => new THREE.Object3D()),
  endEffector: new THREE.Object3D()
};

const AXIS_DIRS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0)
];
let axisArrows = [];
let toolAxes = null;

// --------------------------------------------------------------- motion state
const state = {
  mode: 'showcase',
  angles: homePose(),
  targets: homePose(),
  runner: null,
  runnerTime: 0,
  blend: null,
  speed: 1,
  paused: false,
  activeJoint: -1,
  caption: 'Automatic motion sequence',
  trail: true,
  axes: false,
  labels: true,
  rotate: false
};
// joint driven by the arrow keys (1–5, a slider or a click on its row)
const keyNudge = { selected: 0 };

function buildAxisArrows() {
  for (const a of axisArrows) {
    if (a.parent) a.parent.remove(a);
  }
  axisArrows = arm.joints.map((group, i) => {
    const arrow = new THREE.ArrowHelper(AXIS_DIRS[i], new THREE.Vector3(0, 0, 0), 0.095, 0xC2410C, 0.018, 0.011);
    arrow.traverse(o => {
      if (o.material) {
        o.material.transparent = true;
        o.material.opacity = 0.95;
        o.material.depthWrite = false;
      }
    });
    arrow.visible = state.axes;
    group.add(arrow);
    return arrow;
  });
}

const ui = createUI({
  onMode: mode => {
    if (mode === 'home') setMode('home');
    else setMode(mode);
    if (isMobileLayout() && mode !== 'manual') setPanelOpen(false);
  },
  onPause: () => {
    state.paused = !state.paused;
    ui.setPaused(state.paused);
    updateCaption();
  },
  onSpeed: v => { state.speed = v; },
  onSliderStart: () => enterManual(),
  onSlider: (i, deg) => {
    enterManual();
    state.targets[i] = Math.max(JOINTS[i].min, Math.min(JOINTS[i].max, deg)) * RAD;
    selectJoint(i);
    state.caption = `Manual joint control · ${JOINTS[i].key}`;
    updateCaption();
  },
  onSelect: i => selectJoint(i),
  onToggle: name => toggleSetting(name),
  onView: name => flyTo(name),
  onResetView: () => flyTo('iso'),
  onHideUI: () => toggleUI()
});

// ---------------------------------------------------------- mobile panel
const panelEl = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
const panelClose = document.getElementById('panel-close');
const scrim = document.getElementById('scrim');

function setPanelOpen(open, focus = false) {
  document.body.classList.toggle('panel-open', open);
  if (panelToggle) panelToggle.setAttribute('aria-expanded', String(open));
  if (panelEl) panelEl.setAttribute('aria-hidden', String(!open));
  if (isMobileLayout()) {
    camera.fov = open ? 31 : 36;
    camera.updateProjectionMatrix();
    if (open && panelEl) {
      requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--sheet-h', panelEl.offsetHeight + 'px');
      });
    }
  }
  if (open && focus && panelClose) panelClose.focus({ preventScroll: true });
  if (!open && focus && panelToggle) panelToggle.focus({ preventScroll: true });
}
if (panelToggle) panelToggle.addEventListener('click', () => setPanelOpen(!document.body.classList.contains('panel-open'), true));
if (panelClose) panelClose.addEventListener('click', () => setPanelOpen(false, true));
if (scrim) scrim.addEventListener('click', () => setPanelOpen(false));

function syncPanelToViewport() {
  setPanelOpen(false);
  if (panelEl) panelEl.setAttribute('aria-hidden', String(isMobileLayout()));
}
syncPanelToViewport();
if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', syncPanelToViewport);
else if (MOBILE_MQ.addListener) MOBILE_MQ.addListener(syncPanelToViewport);

function setMode(mode) {
  state.mode = mode;
  state.runnerTime = 0;
  state.paused = false;
  ui.setPaused(false);
  ui.setMode(mode);
  resetTrail();
  state.blend = null;
  if (mode === 'showcase') {
    state.runner = createShowcase();
    state.runnerTime = 0;
    startBlend();
  } else if (mode === 'range') {
    state.runner = createRangeTest();
    state.runnerTime = 0;
    startBlend();
  } else if (mode === 'home') {
    state.runner = createHomeMove([...state.angles]);
    state.runnerTime = 0;
  } else {
    state.runner = null;
    state.targets = [...state.angles];
  }
  if (mode === 'manual') {
    state.caption = 'Drag a slider to pose the arm';
    state.activeJoint = -1;
  } else if (mode === 'home') {
    state.caption = 'Returning to the home pose';
    state.activeJoint = -1;
  } else {
    state.caption = 'Automatic motion sequence';
  }
  updateCaption();
  ui.setActiveJoint(state.activeJoint);
}

// A demo's first frame can be far from the current pose (e.g. after posing by
// hand); ease across instead of letting the arm snap there.
function startBlend() {
  const first = state.runner.sample(0, state.angles).pose;
  const maxDeg = Math.max(...first.map((a, i) => Math.abs(a - state.angles[i]))) * DEG;
  state.blend = maxDeg > 0.5 ? { from: [...state.angles], t: 0, dur: Math.min(1.6, 0.4 + maxDeg / 150) } : null;
}

function blendIn(pose, dt) {
  const b = state.blend;
  if (!b) return pose;
  b.t += dt / b.dur;
  if (b.t >= 1) { state.blend = null; return pose; }
  const k = easeInOut(b.t);
  return pose.map((a, i) => b.from[i] + (a - b.from[i]) * k);
}

function selectJoint(i) {
  keyNudge.selected = i;
  if (state.mode === 'manual') state.activeJoint = i;
}

function enterManual() {
  if (state.mode === 'manual') return;
  state.mode = 'manual';
  state.runner = null;
  state.blend = null;
  state.paused = false;
  ui.setPaused(false);
  state.targets = [...state.angles];
  state.activeJoint = -1;
  state.caption = 'Manual joint control';
  ui.setMode('manual');
  ui.setActiveJoint(-1);
  updateCaption();
  resetTrail();
}

function toggleSetting(name) {
  if (name === 'trail') {
    state.trail = !state.trail;
    if (!state.trail) resetTrail();
    ui.setToggle('trail', state.trail);
  } else if (name === 'axes') {
    state.axes = !state.axes;
    for (const a of axisArrows) a.visible = state.axes;
    if (toolAxes) toolAxes.visible = state.axes;
    ui.setToggle('axes', state.axes);
  } else if (name === 'labels') {
    state.labels = !state.labels;
    document.getElementById('labels').style.opacity = state.labels ? '1' : '0';
    ui.setToggle('labels', state.labels);
  } else if (name === 'rotate') {
    state.rotate = !state.rotate;
    controls.autoRotate = state.rotate;
    ui.setToggle('rotate', state.rotate);
  }
}

function toggleUI() {
  if (isMobileLayout()) {
    setPanelOpen(!document.body.classList.contains('panel-open'));
    return;
  }
  document.body.classList.toggle('ui-hidden');
}

// ------------------------------------------------------------------ caption
function updateCaption() {
  if (state.paused && state.mode !== 'manual') {
    ui.setCaption(state.mode, 'Paused — ' + state.caption);
  } else {
    ui.setCaption(state.mode, state.caption);
  }
}

// ------------------------------------------------------------------- trail
const TRAIL_MAX = 560;
const trailPoints = [];
const trailPositions = new Float32Array(TRAIL_MAX * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeo.setDrawRange(0, 0);
const trailLine = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
  color: 0xC2410C, transparent: true, opacity: 0.55, depthWrite: false,
  blending: THREE.NormalBlending, fog: false
}));
trailLine.frustumCulled = false;
scene.add(trailLine);
const tmpVec = new THREE.Vector3();

// glowing tool-point marker at the end effector
const eefDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.0055, 20, 14),
  new THREE.MeshStandardMaterial({ color: 0xC2410C, emissive: 0x7A2606, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.1 })
);
eefDot.castShadow = false;

function resetTrail() {
  trailPoints.length = 0;
  trailGeo.setDrawRange(0, 0);
}

function sampleTrail() {
  arm.endEffector.getWorldPosition(tmpVec);
  if (!state.trail) return;
  const n = trailPoints.length;
  if (n > 0) {
    const last = trailPoints[n - 1];
    if (last.distanceToSquared(tmpVec) < 0.0000012) return;
  }
  trailPoints.push(tmpVec.clone());
  if (trailPoints.length > TRAIL_MAX) trailPoints.shift();
  for (let i = 0; i < trailPoints.length; i++) {
    trailPositions[i * 3] = trailPoints[i].x;
    trailPositions[i * 3 + 1] = trailPoints[i].y;
    trailPositions[i * 3 + 2] = trailPoints[i].z;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.setDrawRange(0, trailPoints.length);
}

// ------------------------------------------------------------------ labels
const labelOffsets = [
  [-86, 0], [-86, -30], [52, -10], [72, 8], [72, 28]
];
function updateLabels() {
  if (!state.labels) return;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  // pull the pills in on phones so they stay close to their joints
  const spread = isMobileLayout() ? 0.62 : 1;
  const v = tmpVec;
  for (let i = 0; i < arm.joints.length; i++) {
    arm.joints[i].getWorldPosition(v);
    v.project(camera);
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;
    const { el, leader, line, anchor } = ui.labels[i];
    const visible = v.z < 1 && x > -80 && x < w + 80 && y > -60 && y < h + 60;
    el.style.opacity = leader.style.opacity = visible ? '1' : '0';
    if (!visible) continue;
    const lx = x + labelOffsets[i][0] * spread;
    const ly = y + labelOffsets[i][1] * spread;
    el.style.left = lx.toFixed(1) + 'px';
    el.style.top = ly.toFixed(1) + 'px';
    line.setAttribute('x1', x.toFixed(1));
    line.setAttribute('y1', y.toFixed(1));
    line.setAttribute('x2', lx.toFixed(1));
    line.setAttribute('y2', ly.toFixed(1));
    anchor.setAttribute('cx', x.toFixed(1));
    anchor.setAttribute('cy', y.toFixed(1));
    ui.labels[i].angleEl.textContent = `${Math.round(state.angles[i] * DEG)}°`;
  }
}

// ------------------------------------------------------------------ camera
const VIEWS = {
  iso: { pos: new THREE.Vector3(0.98, 0.88, 1.12), target: new THREE.Vector3(0.0, 0.42, 0.0) },
  profile: { pos: new THREE.Vector3(1.70, 0.58, 0.0), target: new THREE.Vector3(0.0, 0.42, 0.0) },
  front: { pos: new THREE.Vector3(0.0, 0.64, 1.66), target: new THREE.Vector3(0.0, 0.42, 0.0) },
  top: { pos: new THREE.Vector3(0.0, 1.75, 0.001), target: new THREE.Vector3(0.0, 0.32, 0.0) },
  detail: { pos: new THREE.Vector3(0.72, 0.60, 0.72), target: new THREE.Vector3(0.0, 0.42, 0.0) }
};

let camTween = null;
function viewFor(name) {
  const v = VIEWS[name] || VIEWS.iso;
  if (!isMobileLayout()) return { pos: v.pos.clone(), target: v.target.clone() };
  const portrait = window.innerHeight >= window.innerWidth;
  const scale = portrait ? 1.30 : 1.02;
  const target = v.target.clone();
  return {
    pos: target.clone().add(v.pos.clone().sub(v.target).multiplyScalar(scale)),
    target
  };
}
function flyTo(name, instant = false) {
  const view = viewFor(name);
  if (instant) {
    camera.position.copy(view.pos);
    controls.target.copy(view.target);
    camera.lookAt(view.target);
    controls.update();
    ui.setView(name);
    return;
  }
  camTween = {
    fromPos: camera.position.clone(),
    toPos: view.pos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: view.target.clone(),
    t: 0,
    dur: 1.0,
    name
  };
  controls.enabled = false;
  ui.setView(name);
}

// ------------------------------------------------------------------- intro
const intro = {
  active: !SHOT && !REDUCED_MOTION && !params.has('pose') && !params.has('t'),
  t: 0,
  dur: 2.6,
  fromCam: new THREE.Vector3(2.05, 1.28, 2.15),
  toCam: viewFor('iso').pos,
  fromTarget: new THREE.Vector3(0.0, 0.46, 0.0),
  toTarget: viewFor('iso').target,
  fromPose: [0, 0, 0, 0, 0].map(v => v * RAD),
  toPose: homePose()
};

function updateIntro(dt) {
  intro.t += dt / intro.dur;
  const k = easeInOut(Math.min(1, intro.t));
  camera.position.lerpVectors(intro.fromCam, intro.toCam, k);
  controls.target.lerpVectors(intro.fromTarget, intro.toTarget, k);
  camera.lookAt(controls.target);
  for (let i = 0; i < 5; i++) {
    state.angles[i] = intro.fromPose[i] + (intro.toPose[i] - intro.fromPose[i]) * k;
  }
  applyAngles();
  if (intro.t >= 1) {
    intro.active = false;
    state.angles = homePose();
    state.targets = homePose();
    applyAngles();
    const isoView = viewFor('iso');
    camera.position.copy(isoView.pos);
    controls.target.copy(isoView.target);
    controls.enabled = true;
    controls.update();
    setMode('showcase');
  }
}

function applyAngles() {
  const a = state.angles;
  // real CAD joint axes: J1 Y, J2 Z, J3 X (roll), J4 Z, J5 X (roll)
  arm.joints[0].rotation.y = a[0];
  arm.joints[1].rotation.z = a[1];
  arm.joints[2].rotation.x = -a[2];
  arm.joints[3].rotation.z = a[3];
  arm.joints[4].rotation.x = -a[4];
}

// ------------------------------------------------------------------ update
function updateMotion(dt) {
  if (intro.active) { updateIntro(dt); return; }

  if (state.mode !== 'manual' && state.runner && !state.paused) {
    state.runnerTime += dt * state.speed;
    const sample = state.runner.sample(state.runnerTime, state.angles);
    state.targets = blendIn(sample.pose, dt * state.speed);
    state.caption = sample.caption;
    if (state.activeJoint !== sample.activeJoint) {
      state.activeJoint = sample.activeJoint;
      ui.setActiveJoint(state.activeJoint);
    }
    if (state.mode === 'home' && state.runnerTime >= state.runner.duration) {
      state.mode = 'manual';
      state.runner = null;
      state.runnerTime = 0;
      ui.setMode('manual');
      state.caption = 'Home pose — drag a slider or pick a demo';
      state.activeJoint = -1;
      ui.setActiveJoint(-1);
      resetTrail();
      updateCaption();
    }
  }

  const k = 1 - Math.exp(-dt * 16);
  for (let i = 0; i < 5; i++) {
    state.angles[i] += (state.targets[i] - state.angles[i]) * k;
    const lo = JOINTS[i].min * RAD - 0.02;
    const hi = JOINTS[i].max * RAD + 0.02;
    state.angles[i] = Math.min(hi, Math.max(lo, state.angles[i]));
  }
  applyAngles();
}

function updateCamera(dt) {
  if (camTween) {
    camTween.t += dt / camTween.dur;
    const k = easeInOut(Math.min(1, camTween.t));
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, k);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, k);
    camera.lookAt(controls.target);
    if (camTween.t >= 1) {
      camTween = null;
      controls.enabled = true;
      controls.update();
    }
  }
}

// -------------------------------------------------------------------- loop
let lastActive = -2;
let captionTimer = 0;
let autoLoop = true;
const clock = new THREE.Clock();

function tick(dt) {
  updateMotion(dt);
  updateCamera(dt);
  if (!intro.active && !camTween) controls.update();

  ui.update(state);
  updateLabels();
  if (!intro.active) sampleTrail();

  captionTimer += dt;
  if (captionTimer > 0.1) {
    captionTimer = 0;
    updateCaption();
  }

  if (state.activeJoint !== lastActive) {
    lastActive = state.activeJoint;
    ui.setActiveJoint(lastActive);
  }
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (autoLoop) tick(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ resize
function resizeRenderer() {
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
}
window.addEventListener('resize', resizeRenderer);
if (window.ResizeObserver) new ResizeObserver(resizeRenderer).observe(stage);

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', e => {
  const t = e.target;
  // a focused slider keeps its own arrow keys, but the other shortcuts still work
  const onSlider = t && t.tagName === 'INPUT' && t.type === 'range';
  if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !onSlider))) return;
  const k = e.key;
  if (k === ' ') {
    e.preventDefault();
    state.paused = !state.paused;
    ui.setPaused(state.paused);
    updateCaption();
  } else if (k === 'Escape') {
    if (document.body.classList.contains('panel-open')) setPanelOpen(false, true);
  } else if (k === 'h' || k === 'H') {
    toggleUI();
  } else if (k === 'r' || k === 'R') {
    flyTo('iso');
  } else if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  } else if (k >= '1' && k <= '5') {
    selectJoint(parseInt(k, 10) - 1);
  } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    if (onSlider) return;
    const i = keyNudge.selected;
    const dir = (k === 'ArrowRight' || k === 'ArrowUp') ? 1 : -1;
    const stepDeg = e.shiftKey ? 5 : 1;
    enterManual();
    selectJoint(i);
    const current = state.targets[i] * DEG + dir * stepDeg;
    state.targets[i] = Math.max(JOINTS[i].min, Math.min(JOINTS[i].max, current)) * RAD;
    state.caption = `Manual joint control · ${JOINTS[i].key}`;
    updateCaption();
    e.preventDefault();
  }
});

// ------------------------------------------------------------- url overrides
function applyParams() {
  if (NO_UI) document.body.classList.add('ui-hidden', 'no-hint');
  if (params.get('axes') === '1') state.axes = true;
  if (params.get('trail') === '0') state.trail = false;
  if (params.get('labels') === '0') { state.labels = false; document.getElementById('labels').style.opacity = '0'; }
  if (params.has('pose')) {
    intro.active = false;
    const pose = params.get('pose').split(',').map(Number);
    if (pose.length === 5 && pose.every(n => Number.isFinite(n))) {
      state.mode = 'manual';
      state.angles = pose.map((v, i) => Math.max(JOINTS[i].min, Math.min(JOINTS[i].max, v)) * RAD);
      state.targets = [...state.angles];
      state.caption = 'Manual joint control';
      ui.setMode('manual');
      applyAngles();
      ui.setActiveJoint(-1);
      resetTrail();
      updateCaption();
    }
  }
  if (params.has('t')) {
    intro.active = false;
    const t = parseFloat(params.get('t')) || 0;
    const mode = params.get('mode') || 'showcase';
    setMode(mode);
    state.blend = null;
    if (state.runner) {
      state.runnerTime = t;
      const sample = state.runner.sample(t, state.angles);
      state.angles = [...sample.pose];
      state.targets = [...sample.pose];
      state.caption = sample.caption;
      state.activeJoint = sample.activeJoint;
      applyAngles();
      ui.setActiveJoint(state.activeJoint);
      updateCaption();
    }
    state.paused = true;
    ui.setPaused(true);
    resetTrail();
    // lay down a static trail preview along the current pose
  }
  if (params.has('cam')) {
    intro.active = false;
    flyTo(params.get('cam'), true);
  }
  if (SHOT) {
    intro.active = false;
    const fader = document.getElementById('fader');
    if (fader) fader.remove();
    if (!params.has('cam')) flyTo('iso', true);
  }
  if (params.has('introT')) {
    const fader = document.getElementById('fader');
    if (fader) fader.remove();
    intro.active = true;
    autoLoop = false;
    intro.t = Math.max(0, Math.min(0.999, parseFloat(params.get('introT')) || 0));
    updateIntro(0);
    renderer.render(scene, camera);
  }
}

// debug / screenshot API
window.__armReady = false;
window.__arm = {
  scene, camera, renderer, controls, state, ui, arm: null,
  setMode, applyAngles, flyTo,
  setAuto(v) { autoLoop = !!v; },
  step(dt = 1 / 60, count = 1) {
    for (let i = 0; i < count; i++) tick(dt);
    renderer.render(scene, camera);
  },
  setAngles(degArray) {
    enterManual();
    state.angles = degArray.map((v, i) => Math.max(JOINTS[i].min, Math.min(JOINTS[i].max, v)) * RAD);
    state.targets = [...state.angles];
    applyAngles();
    ui.update(state);
  }
};

// ------------------------------------------------------------------- start
applyParams();
if (intro.active) {
  controls.enabled = false;
} else {
  applyAngles();
  controls.enabled = true;
  if (!params.has('cam')) flyTo('iso', true);
  controls.update();
}
if (state.mode === 'showcase' && !state.runner) setMode('showcase');
// with reduced motion: no camera fly-in, and the demo waits for Space / play
if (REDUCED_MOTION && state.mode === 'showcase' && !params.has('t')) state.paused = true;
ui.update(state);
ui.setMode(state.mode);
ui.setPaused(state.paused);
ui.setToggle('trail', state.trail);
ui.setToggle('axes', state.axes);
ui.setToggle('labels', state.labels);
ui.setToggle('rotate', state.rotate);
updateCaption();
ui.setActiveJoint(-1);

// load the real CAD arm, then start rendering
const fader = document.getElementById('fader');
loadArm().then(real => {
  arm = real;
  scene.add(arm.root);
  arm.endEffector.add(eefDot);
  buildAxisArrows();
  // small wrist reference triad at the J5 output, shown with the joint axes
  toolAxes = new THREE.Group();
  toolAxes.position.set(0.0565, 0, 0);
  const toolCols = [0xC2410C, 0x0A7194, 0x946200];
  const toolDirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  for (let i = 0; i < 3; i++) {
    const a = new THREE.ArrowHelper(toolDirs[i], new THREE.Vector3(0, 0, 0), 0.032, toolCols[i], 0.008, 0.005);
    a.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = 0.95; o.material.depthWrite = false; } });
    toolAxes.add(a);
  }
  toolAxes.visible = state.axes;
  arm.joints[4].add(toolAxes);
  applyAngles();
  ui.update(state);
  updateLabels();
  window.__arm.arm = arm;
  window.__armReady = true;
  if (intro.active) {
    controls.enabled = false;
  } else {
    controls.enabled = true;
    if (!params.has('cam')) flyTo('iso', true);
    controls.update();
  }
  if (fader && !SHOT) setTimeout(() => fader.classList.add('gone'), 100);
  frame();
}).catch(err => {
  console.error(err);
  if (fader) fader.remove();
  const d = document.createElement('div');
  d.textContent = 'Could not load the CAD model: ' + (err && err.message ? err.message : err);
  d.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:99;background:#C42638;color:#fff;font:13px ui-monospace,monospace;padding:10px 14px;border-radius:8px';
  document.body.appendChild(d);
});
