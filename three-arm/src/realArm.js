// Real CAD arm (EPQ 3.1 Design FINAL.step) exported to an articulated GLB.
// The GLB contains the node hierarchy Static -> J1 -> J2 -> J3 -> J4 -> J5;
// geometry is stored relative to each joint pivot, so the app only has to
// rotate the joint nodes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ARM_GLB_B64 } from './modelData.js';

const D2R = Math.PI / 180;

function makeGrainTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  let seed = 4242;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(118 + rand() * 70);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.anisotropy = 4;
  return tex;
}

export function createSceneMaterials() {
  const grain = makeGrainTexture();
  const std = o => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...o });
  return {
    printed: std({ color: 0x16181d, roughness: 0.66, metalness: 0.05, bumpMap: grain, bumpScale: 0.0006 }),
    motor: std({ color: 0x0a0b0d, roughness: 0.46, metalness: 0.55 }),
    silver: std({ color: 0x99a1ac, roughness: 0.42, metalness: 0.88 }),
    steel: std({ color: 0xb4bac3, roughness: 0.3, metalness: 0.95 }),
    stand: std({ color: 0x14171c, roughness: 0.68, metalness: 0.25 }),
    standTrim: std({ color: 0x3b424d, roughness: 0.55, metalness: 0.55 }),
    accent: std({ color: 0xff7a1f, roughness: 0.4, metalness: 0.2, emissive: 0x6b2600, emissiveIntensity: 0.5 })
  };
}

export async function loadArm() {
  const mats = createSceneMaterials();
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const bin = Uint8Array.from(atob(ARM_GLB_B64), c => c.charCodeAt(0));
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(bin.buffer, '', resolve, reject);
  });
  const root = gltf.scene;
  root.name = 'EPQ_ARM';
  root.updateMatrixWorld(true);

  // swap the exported PBR materials for the scene materials
  root.traverse(obj => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const name = obj.material && obj.material.name;
    obj.material = mats[name] || mats.printed;
    if (obj.geometry && !obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
  });
  const joints = ['J1', 'J2', 'J3', 'J4', 'J5'].map(n => {
    const node = root.getObjectByName(n);
    if (!node) throw new Error('GLB missing joint node ' + n);
    return node;
  });
  const endEffector = new THREE.Object3D();
  endEffector.name = 'EEF';
  endEffector.position.set(0.0565, 0, 0); // J5 output shaft tip
  joints[4].add(endEffector);

  // Rotate the base-mounted export into the original chest-mount orientation:
  // J1 motor/axis horizontal, the arm hanging below it in front of the mount.
  const mountR = new THREE.Matrix4().set(
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1
  );
  const mount = new THREE.Group();
  mount.quaternion.setFromRotationMatrix(mountR);
  mount.position.set(0, 0.45596, -0.32048);
  mount.add(root);

  const outer = new THREE.Group();
  outer.name = 'EPQ_ARM_FLOATING';
  outer.add(mount);
  outer.updateMatrixWorld(true);
  return { root: outer, joints, endEffector, materials: mats, mount };
}
