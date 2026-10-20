// Joint definitions + motion sequences for the EPQ 5-DOF robotic arm.
// Ranges for J2 (shoulder) and J4 (elbow) come from the EPQ report (FR-03):
// shoulder 0-150 deg, elbow 0-140 deg. The remaining ranges are design values.

export const JOINTS = [
  {
    key: 'J1', name: 'Base yaw', axis: 'y',
    min: -120, max: 120, home: 0,
    actuator: 'UMIR57 stepper', drive: '25:1 planetary', torque: '19 N·m',
    rangeLabel: '±120°',
    blurb: 'Rotates the complete arm about the vertical axis.'
  },
  {
    key: 'J2', name: 'Shoulder pitch', axis: 'z',
    min: 0, max: 150, home: 0,
    actuator: 'UMIR57 stepper', drive: '50:1 worm (self-locking)', torque: '5.4 N·m',
    rangeLabel: '0°–150°',
    blurb: 'Lifts the arm; the worm drive holds the pose without drawing current.'
  },
  {
    key: 'J3', name: 'Upper-arm roll', axis: 'x',
    min: -135, max: 135, home: 0,
    actuator: 'UMIR42 stepper', drive: 'planetary', torque: '—',
    rangeLabel: '±135°',
    blurb: 'Rolls the forearm assembly about the upper-arm axis.'
  },
  {
    key: 'J4', name: 'Elbow pitch', axis: 'z',
    min: 0, max: 140, home: 0,
    actuator: 'UMIR42 stepper', drive: 'planetary', torque: '—',
    rangeLabel: '0°–140°',
    blurb: 'Bends the forearm; 140° of travel exceeds the original target.'
  },
  {
    key: 'J5', name: 'Wrist roll', axis: 'x',
    min: -180, max: 180, home: 0,
    actuator: 'UMIR42 stepper', drive: 'planetary', torque: '—',
    rangeLabel: '±180°',
    blurb: 'Rolls the end-effector flange about the forearm axis.'
  }
];

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;
export const homePose = () => JOINTS.map(j => j.home * RAD);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- showcase
// A looping set of expressive poses, each reached with a smooth ease.
const SHOWCASE_KEYS = [
  { pose: [0, 0, 0, 0, 0], hold: 1.8 },        // original CAD pose (all joints 0)
  { pose: [0, 22, 0, 38, 0], hold: 0.7 },
  { pose: [0, 6, 0, 8, 0], hold: 0.7 },        // full forward extension
  { pose: [0, 62, 22, 26, 50], hold: 0.7 },    // lift
  { pose: [46, 104, 0, 54, -38], hold: 0.9 },  // high on the left
  { pose: [-52, 96, 0, 46, 32], hold: 0.9 },   // high on the right
  { pose: [-14, 40, -58, 128, -95], hold: 1.0 }, // compact fold / wrist twist
  { pose: [58, 54, 54, 24, 172], hold: 0.8 }   // low sweep, wrist spin
];

export function createShowcase() {
  const segs = [];
  let total = 0;
  for (let i = 0; i < SHOWCASE_KEYS.length; i++) {
    const from = SHOWCASE_KEYS[i].pose.map(v => v * RAD);
    const to = SHOWCASE_KEYS[(i + 1) % SHOWCASE_KEYS.length].pose.map(v => v * RAD);
    const dur = 2.1;
    const hold = SHOWCASE_KEYS[(i + 1) % SHOWCASE_KEYS.length].hold;
    segs.push({ from, to, dur, hold, start: total });
    total += dur + hold;
  }
  return {
    duration: total,
    sample(t, current) {
      const time = ((t % total) + total) % total;
      const seg = segs.find(s => time >= s.start && time < s.start + s.dur + s.hold) || segs[0];
      const local = time - seg.start;
      const k = easeInOut(clamp(local / seg.dur, 0, 1));
      const pose = seg.from.map((a, i) => lerp(a, seg.to[i], k));
      return { pose, activeJoint: -1, caption: 'Automatic motion sequence' };
    }
  };
}

// ------------------------------------------------------------- range test
export function createRangeTest() {
  const steps = [];
  const add = (pose, dur, caption, activeJoint) =>
    steps.push({ pose: pose.map(v => v * RAD), dur, caption, activeJoint });

  // sweep time grows with the angle travelled
  const sweep = (from, to) => 0.5 + Math.abs(to - from) / 170;

  // start from home pose
  add(JOINTS.map(j => j.home), 0.9, 'Moving to the home pose', -1);

  const order = [0, 1, 2, 3, 4];
  for (const idx of order) {
    const j = JOINTS[idx];
    const home = [...JOINTS.map(x => x.home)];
    // visit each limit, nearest first; J2/J4 start at a limit, so they only have one
    const ends = [j.max, j.min]
      .filter(v => v !== j.home)
      .sort((a, b) => Math.abs(a - j.home) - Math.abs(b - j.home));
    add([...home], 0.5, `${j.key} · ${j.name} — home`, idx);
    let at = j.home;
    for (const end of ends) {
      const p = [...home]; p[idx] = end;
      add(p, sweep(at, end), `${j.key} · ${j.name} — ${end.toFixed(0)}°`, idx);
      add(p, 0.55, `${j.key} · ${j.name} — ${end.toFixed(0)}°`, idx);
      at = end;
    }
    add([...home], sweep(at, j.home), `${j.key} · ${j.name} — back to home`, idx);
  }
  add(JOINTS.map(j => j.home), 0.8, 'Range test complete', -1);

  const total = steps.reduce((s, x) => s + x.dur, 0);
  return {
    duration: total,
    sample(t, prevPose) {
      const time = ((t % total) + total) % total;
      let acc = 0;
      let prev = JOINTS.map(j => j.home * RAD);
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (time < acc + s.dur) {
          const k = easeInOut(clamp((time - acc) / s.dur, 0, 1));
          const pose = prev.map((a, j) => lerp(a, s.pose[j], k));
          return { pose, activeJoint: s.activeJoint, caption: s.caption, progress: i / steps.length };
        }
        acc += s.dur;
        prev = s.pose;
      }
      const last = steps[steps.length - 1];
      return { pose: last.pose, activeJoint: -1, caption: last.caption, progress: 1 };
    }
  };
}

// ------------------------------------------------------------------ homing
export function createHomeMove(fromPose) {
  const to = JOINTS.map(j => j.home * RAD);
  return {
    duration: 1.4,
    sample(t) {
      const k = easeInOut(clamp(t / 1.4, 0, 1));
      const pose = fromPose.map((a, i) => lerp(a, to[i], k));
      return { pose, activeJoint: -1, caption: 'Returning to the home pose' };
    }
  };
}
