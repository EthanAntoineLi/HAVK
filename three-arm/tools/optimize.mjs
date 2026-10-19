import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read('../model/arm-raw.glb');
console.log('nodes:', doc.getRoot().listNodes().map(n => n.getName()));
console.log('meshes:', doc.getRoot().listMeshes().length, 'materials:', doc.getRoot().listMaterials().map(m => m.getName()));
await doc.transform(
  dedup(),
  prune(),
  weld(),
  quantize({ quantizePosition: 15, quantizeNormal: 10 }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' })
);
await io.write('../model/arm-opt.glb', doc);
