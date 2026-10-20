// HUD: joint sliders, mode controls, toggles, captions and joint labels.
import { JOINTS, DEG } from './motion.js';

const MODE_LABEL = {
  showcase: 'SHOWCASE',
  range: 'RANGE TEST',
  manual: 'MANUAL',
  home: 'HOMING'
};
const MODE_NOTE = {
  showcase: 'Auto demo',
  range: 'Auto · loops',
  manual: 'Drag to pose',
  home: 'Moving home'
};
// the ❚❚ glyph renders as a solid block at this size, so draw the icons
const ICON_PAUSE = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="1.5" y="1" width="2.4" height="8" rx=".6"/><rect x="6.1" y="1" width="2.4" height="8" rx=".6"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2.4 1.2v7.6a.5.5 0 0 0 .76.43l6.2-3.8a.5.5 0 0 0 0-.86l-6.2-3.8a.5.5 0 0 0-.76.43z"/></svg>';

// keep a range input's filled track in step with its thumb
const paintFill = (input, v, min, max) =>
  input.style.setProperty('--fill', (((v - min) / (max - min)) * 100).toFixed(2) + '%');

export function createUI(handlers) {
  const modeButtons = [...document.querySelectorAll('#modes .mode')];
  const pauseBtn = document.getElementById('pause');
  const noteEl = document.getElementById('mode-note');
  const jointsEl = document.getElementById('joints');
  const capMode = document.getElementById('cap-mode');
  const capText = document.getElementById('cap-text');
  const speedEl = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  const chips = {
    trail: document.getElementById('t-trail'),
    axes: document.getElementById('t-axes'),
    labels: document.getElementById('t-labels'),
    rotate: document.getElementById('t-rotate')
  };
  const viewButtons = [...document.querySelectorAll('#viewbar button')];
  const hideBtn = document.getElementById('hide-ui');
  const showBtn = document.getElementById('show-ui');
  const labelHost = document.getElementById('labels');

  // ------------------------------------------------------------ joint rows
  const rows = JOINTS.map((j, idx) => {
    const el = document.createElement('div');
    el.className = 'joint';
    el.dataset.joint = String(idx);
    el.innerHTML = `
      <div class="jrow">
        <span class="jkey">${j.key}</span>
        <span class="jname">${j.name}</span>
        <span class="jangle">0°</span>
      </div>
      <div class="jspec" title="${j.actuator} · ${j.drive} · ${j.torque}">${j.actuator} · ${j.drive} · ${j.rangeLabel}</div>
      <input type="range" min="${j.min}" max="${j.max}" step="0.5" value="${j.home}"
        aria-label="${j.key} ${j.name} angle">`;
    jointsEl.appendChild(el);
    const input = el.querySelector('input');
    const angleEl = el.querySelector('.jangle');
    let dragging = false;
    const paint = v => paintFill(input, v, j.min, j.max);
    paint(j.home);
    input.addEventListener('pointerdown', () => {
      dragging = true;
      handlers.onSliderStart(idx);
    });
    input.addEventListener('focus', () => handlers.onSelect(idx));
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      paint(v);
      angleEl.textContent = `${Math.round(v)}°`;
      handlers.onSlider(idx, v);
    });
    const end = () => { dragging = false; };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('change', end);
    el.addEventListener('pointerdown', () => handlers.onSelect(idx));
    window.addEventListener('pointerup', end);
    return { el, input, angleEl, paint, j, isDragging: () => dragging };
  });

  // --------------------------------------------------------------- handlers
  for (const b of modeButtons) {
    b.addEventListener('click', () => handlers.onMode(b.dataset.mode));
  }
  pauseBtn.addEventListener('click', () => handlers.onPause());
  const paintSpeed = () => paintFill(speedEl, parseFloat(speedEl.value), parseFloat(speedEl.min), parseFloat(speedEl.max));
  paintSpeed();
  speedEl.addEventListener('input', () => {
    const v = parseFloat(speedEl.value);
    speedVal.textContent = v.toFixed(1) + '×';
    paintSpeed();
    handlers.onSpeed(v);
  });
  for (const [key, el] of Object.entries(chips)) {
    el.addEventListener('click', () => handlers.onToggle(key));
  }
  for (const b of viewButtons) {
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'reset') handlers.onResetView();
      else handlers.onView(v);
    });
  }
  hideBtn.addEventListener('click', () => handlers.onHideUI());
  showBtn.addEventListener('click', () => handlers.onHideUI());

  // ---------------------------------------------------------------- labels
  // each pill hangs off a leader line drawn from a small anchor on its joint
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const leaderSvg = document.createElementNS(SVG_NS, 'svg');
  leaderSvg.id = 'leaders';
  leaderSvg.setAttribute('aria-hidden', 'true');
  labelHost.appendChild(leaderSvg);
  const labels = JOINTS.map((j, idx) => {
    const line = document.createElementNS(SVG_NS, 'line');
    const anchor = document.createElementNS(SVG_NS, 'circle');
    anchor.setAttribute('r', '2.6');
    const g = document.createElementNS(SVG_NS, 'g');
    g.append(line, anchor);
    leaderSvg.appendChild(g);
    const el = document.createElement('div');
    el.className = 'lbl';
    el.innerHTML = `<span class="dot"></span><b>${j.key}</b><span>0°</span>`;
    labelHost.appendChild(el);
    return { el, angleEl: el.querySelector('span:last-child'), leader: g, line, anchor };
  });

  let lastCaption = '';
  let lastCapMode = '';

  return {
    rows,
    labels,

    setMode(mode) {
      for (const b of modeButtons) {
        const on = b.dataset.mode === mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      noteEl.textContent = MODE_NOTE[mode] || '';
    },
    setPaused(paused) {
      pauseBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
      pauseBtn.classList.toggle('paused', paused);
      pauseBtn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
      pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    },
    setToggle(name, on) {
      if (!chips[name]) return;
      chips[name].classList.toggle('on', on);
      chips[name].setAttribute('aria-pressed', String(on));
    },
    setView(name) {
      for (const b of viewButtons) {
        if (b.dataset.view === 'reset') continue;
        b.classList.toggle('active', b.dataset.view === name);
      }
    },
    setActiveJoint(idx) {
      rows.forEach((r, i) => r.el.classList.toggle('active', i === idx));
      labels.forEach((l, i) => {
        l.el.classList.toggle('active', i === idx);
        l.leader.classList.toggle('active', i === idx);
      });
    },
    setCaption(mode, text) {
      const label = MODE_LABEL[mode] || 'DEMO';
      if (label !== lastCapMode) { capMode.textContent = label; lastCapMode = label; }
      if (text && text !== lastCaption) { capText.textContent = text; lastCaption = text; }
    },
    // per-frame refresh of angles / sliders / labels
    update(state) {
      rows.forEach((r, i) => {
        const deg = state.angles[i] * DEG;
        if (!r.isDragging()) {
          const clamped = Math.min(r.j.max, Math.max(r.j.min, deg));
          r.input.value = clamped.toFixed(1);
          r.paint(clamped);
        }
        r.angleEl.textContent = `${Math.round(deg)}°`;
        // keep the fill in sync even while dragging from other controls
        r.paint(parseFloat(r.input.value));
      });
    },
  };
}
