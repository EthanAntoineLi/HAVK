# Convert the Shapr3D STEP assembly into an articulated, optimised GLB.
# Groups: G0 static motor, G1..G5 = link groups rotated by joints J1..J5.
import sys, os, json, struct, time, math
from array import array
import numpy as np

# Needs OpenCASCADE Python bindings:  pip install cadquery-ocp
# Run with:  PYTHONPATH=<ocp install> python3 tools/export_model.py [input.step]
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDataStd import TDataStd_Name
from OCP.Interface import Interface_Static
from OCP.OCP.collections import Sequence_TDF_Label
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location

PATH = sys.argv[1] if len(sys.argv) > 1 else '/Users/azaa/Desktop/EPQ/3D Designs /EPQ 3.1 Design FINAL.step'
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'model')
os.makedirs(OUT_DIR, exist_ok=True)

# ---- scene mapping (STEP mm, y-up model) -> metres, y-up, arm +X, laid on base
BASE_TOP = 0.10
def map_point(x, y, z):
    return ((-z + 151.96) / 1000.0,
            (334.4 - y) / 1000.0 + BASE_TOP,
            (-x + 112.46) / 1000.0)
def map_normal(nx, ny, nz):
    return (-nz, -ny, -nx)

# joint pivots in STEP mm, then mapped
PIVOTS_STEP = [
    (112.46, 113.92, 151.96),   # J1 yaw axis Y
    (112.46, 113.92, 201.74),   # J2 shoulder pitch axis X
    (112.46, 113.92, 74.00),    # J3 roll axis Z
    (112.46, 113.92, -31.41),   # J4 elbow pitch axis X
    (112.46, 113.92, -127.50),  # J5 wrist roll axis Z
]
PIVOTS = [map_point(*p) for p in PIVOTS_STEP]
GROUP_PIVOTS = [(0.0,0.0,0.0)] + PIVOTS  # geometry is stored relative to its group pivot
# node translations: J1 at pivot, then relative offsets
NODE_T = [ (PIVOTS[0][0], PIVOTS[0][1], PIVOTS[0][2]) ]
for i in range(1, 5):
    NODE_T.append((PIVOTS[i][0]-PIVOTS[i-1][0], 0.0, 0.0))

GROUP_NAMES = ['Static', 'J1', 'J2', 'J3', 'J4', 'J5']

# ---- components / groups / materials
# comp indices from earlier analysis:
# 1 unused nuts, 3 J5 gearmotor, 4 J4 gearmotor, 5 J3 gearmotor,
# 6 upper arm, 7 shoulder joint, 8 shoulder lift, 9 J1 57 motor, 10 links
def group_for(comp, solid, bbox):
    if comp == 9: return 0
    if comp in (7, 8): return 1
    if comp == 5: return 2
    if comp == 10:
        if solid in (1, 2): return 2      # shoulder lift arms
        if solid in (3, 5): return 3      # elbow-side mount/cover stays with the upper arm (link 3)
        return 4                          # forearm link
    if comp == 6: return 2          # upper-arm sleeve stays with the J2 lift structure
    if comp == 4: return 3
    if comp == 3:
        # only the output nose (shaft/flange) rotates with J5; motor housing stays on J4
        return 5 if bbox[2] <= -170.0 else 4
    return 0

def classify(comp, bbox, vol):
    x0,y0,z0,x1,y1,z1 = bbox
    maxdim = max(x1-x0, y1-y0, z1-z0)
    cy = (y0+y1)*0.5
    if comp in (6,7,8,10): return 'printed'
    if comp == 9:
        if cy > 262: return 'motor'
        if vol > 12000 and maxdim > 30: return 'silver'
        return 'steel'
    if comp in (3,4,5):
        if vol > 35000: return 'motor'
        if maxdim < 18 and vol < 900: return 'steel'
        return 'silver'
    return 'steel'

MATERIALS = {
    'printed': dict(color=[0.012,0.014,0.017,1.0], metallic=0.06, rough=0.68),
    'motor':   dict(color=[0.004,0.0045,0.006,1.0], metallic=0.55, rough=0.42),
    'silver':  dict(color=[0.46,0.49,0.55,1.0], metallic=0.92, rough=0.34),
    'steel':   dict(color=[0.66,0.70,0.75,1.0], metallic=1.0, rough=0.24),
}

t0 = time.time()
Interface_Static.SetCVal_s('xstep.cascade.unit','MM')
doc = TDocStd_Document(TCollection_ExtendedString('doc'))
reader = STEPCAFControl_Reader()
reader.SetNameMode(True); reader.SetColorMode(False); reader.SetLayerMode(False)
reader.ReadFile(PATH); reader.Transfer(doc)
stool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
roots = Sequence_TDF_Label(); stool.GetFreeShapes(roots)
comps = Sequence_TDF_Label(); stool.GetComponents_s(roots.Value(1), comps, False)
print('read+transfer %.1fs, components %d' % (time.time()-t0, comps.Length()))

# storage: (group, material) -> dict(pos=array('f'), nrm=array('f'), idx=array('I'))
buckets = {}
def bucket(g, m):
    key = (g, m)
    if key not in buckets:
        buckets[key] = dict(pos=array('f'), nrm=array('f'), idx=array('I'), nverts=0)
    return buckets[key]

def defl_for(bbox):
    maxdim = max(bbox[3]-bbox[0], bbox[4]-bbox[1], bbox[5]-bbox[2])
    return max(0.18, min(0.55, maxdim * 0.004))

tri_total = 0
for ci in range(1, comps.Length()+1):
    lab = comps.Value(ci)
    shape_c = stool.GetShape_s(lab)
    if shape_c is None or shape_c.IsNull(): continue
    if ci == 1 or ci == 2: continue   # unused nuts / empty sketch
    exp = TopExp_Explorer(shape_c, TopAbs_SOLID)
    solid_i = 0
    while exp.More():
        solid_i += 1
        solid = TopoDS.Solid(exp.Current()); exp.Next()
        b = Bnd_Box(); BRepBndLib.Add_s(solid, b)
        if b.IsVoid(): continue
        mn=b.CornerMin(); mx=b.CornerMax()
        bbox=[mn.X(),mn.Y(),mn.Z(),mx.X(),mx.Y(),mx.Z()]
        maxdim = max(bbox[3]-bbox[0], bbox[4]-bbox[1], bbox[5]-bbox[2])
        vol = 0.0
        try:
            props=GProp_GProps(); BRepGProp.VolumeProperties_s(solid, props); vol=props.Mass()
        except Exception: pass
        if maxdim < 4.0 or vol < 12.0: continue
        mat = classify(ci, bbox, vol)
        grp = group_for(ci, solid_i, bbox)
        BRepMesh_IncrementalMesh(solid, defl_for(bbox), False, 0.5, True)
        fexp = TopExp_Explorer(solid, TopAbs_FACE)
        while fexp.More():
            face = TopoDS.Face(fexp.Current()); fexp.Next()
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is None: continue
            if not tri.HasNormals(): tri.ComputeNormals()
            trsf = loc.Transformation()
            # rotation matrix for normals
            r11,r12,r13 = trsf.Value(1,1),trsf.Value(1,2),trsf.Value(1,3)
            r21,r22,r23 = trsf.Value(2,1),trsf.Value(2,2),trsf.Value(2,3)
            r31,r32,r33 = trsf.Value(3,1),trsf.Value(3,2),trsf.Value(3,3)
            bk = bucket(grp, mat)
            base = bk['nverts']
            nn = tri.NbNodes()
            for i in range(1, nn+1):
                p = tri.Node(i).Transformed(trsf)
                sx,sy,sz = map_point(p.X(), p.Y(), p.Z())
                gp = GROUP_PIVOTS[grp]
                bk['pos'].append(sx-gp[0]); bk['pos'].append(sy-gp[1]); bk['pos'].append(sz-gp[2])
                n = tri.Normal(i)
                nx,ny,nz = n.X(), n.Y(), n.Z()
                wx = r11*nx + r12*ny + r13*nz
                wy = r21*nx + r22*ny + r23*nz
                wz = r31*nx + r32*ny + r33*nz
                mx,my,mz = map_normal(wx,wy,wz)
                ln = math.sqrt(mx*mx+my*my+mz*mz) or 1.0
                bk['nrm'].append(mx/ln); bk['nrm'].append(my/ln); bk['nrm'].append(mz/ln)
            bk['nverts'] += nn
            for ti in range(1, tri.NbTriangles()+1):
                a,b_,c = tri.Triangle(ti).Get()
                bk['idx'].append(base + a - 1)
                bk['idx'].append(base + b_ - 1)
                bk['idx'].append(base + c - 1)
            tri_total += tri.NbTriangles()
print('meshed %.1fs, triangles %d' % (time.time()-t0, tri_total))
for (g,m),bk in sorted(buckets.items()):
    print(' group',GROUP_NAMES[g],m,'verts',bk['nverts'],'tris',len(bk['idx'])//3)

# write raw GLB
def align4(n): return (n + 3) & ~3
bin_parts = []
views = []
accessors = []
meshes = []   # per group: list of primitive dicts
group_prims = {i: [] for i in range(6)}
mat_index = {m:i for i,m in enumerate(MATERIALS)}
buf_offset = 0
for (g, m), bk in sorted(buckets.items()):
    pos = np.frombuffer(bk['pos'], dtype=np.float32).reshape(-1,3)
    nrm = np.frombuffer(bk['nrm'], dtype=np.float32).reshape(-1,3)
    idx = np.frombuffer(bk['idx'], dtype=np.uint32)
    pos_b = pos.tobytes(); nrm_b = nrm.tobytes(); idx_b = idx.tobytes()
    pos_off = buf_offset; bin_parts.append(pos_b); buf_offset = align4(buf_offset + len(pos_b))
    nrm_off = buf_offset; bin_parts.append(nrm_b); buf_offset = align4(buf_offset + len(nrm_b))
    idx_off = buf_offset; bin_parts.append(idx_b); buf_offset = align4(buf_offset + len(idx_b))
    # pad handled later by joining arrays
    views.append(dict(buffer=0, byteOffset=pos_off, byteLength=len(pos_b), target=34962))
    pos_acc = len(accessors)
    accessors.append(dict(bufferView=len(views)-1, componentType=5126, count=len(pos), type='VEC3',
                          min=[float(pos[:,0].min()),float(pos[:,1].min()),float(pos[:,2].min())],
                          max=[float(pos[:,0].max()),float(pos[:,1].max()),float(pos[:,2].max())]))
    views.append(dict(buffer=0, byteOffset=nrm_off, byteLength=len(nrm_b), target=34962))
    nrm_acc = len(accessors)
    accessors.append(dict(bufferView=len(views)-1, componentType=5126, count=len(nrm), type='VEC3'))
    views.append(dict(buffer=0, byteOffset=idx_off, byteLength=len(idx_b), target=34963))
    idx_acc = len(accessors)
    accessors.append(dict(bufferView=len(views)-1, componentType=5125, count=len(idx), type='SCALAR'))
    group_prims[g].append(dict(attributes=dict(POSITION=pos_acc, NORMAL=nrm_acc), indices=idx_acc, material=mat_index[m]))

# build binary buffer with proper padding
bin_buf = bytearray()
for part, (g,m) in zip(bin_parts, sorted(buckets.keys())):
    while len(bin_buf) % 4: bin_buf += b'\0'
    bin_buf += part
while len(bin_buf) % 4: bin_buf += b'\0'
# fix bufferView offsets: we assumed offsets but appended with alignment; recompute actual offsets
# (recompute pass)
offset = 0
for (g,m),bk in sorted(buckets.items()):
    pass
# We'll rebuild bufferViews accurately
views = []
accessors = []
bin_buf = bytearray()
group_prims = {i: [] for i in range(6)}
def add_view(data, target):
    global bin_buf
    while len(bin_buf) % 4: bin_buf += b'\0'
    off = len(bin_buf)
    bin_buf += data
    views.append(dict(buffer=0, byteOffset=off, byteLength=len(data), target=target))
    return len(views)-1
for (g, m), bk in sorted(buckets.items()):
    pos = np.frombuffer(bk['pos'], dtype=np.float32).reshape(-1,3)
    nrm = np.frombuffer(bk['nrm'], dtype=np.float32).reshape(-1,3)
    idx = np.frombuffer(bk['idx'], dtype=np.uint32)
    vpos = add_view(pos.tobytes(), 34962)
    pos_acc = len(accessors)
    accessors.append(dict(bufferView=vpos, componentType=5126, count=int(len(pos)), type='VEC3',
                          min=[float(pos[:,0].min()),float(pos[:,1].min()),float(pos[:,2].min())],
                          max=[float(pos[:,0].max()),float(pos[:,1].max()),float(pos[:,2].max())]))
    vnrm = add_view(nrm.tobytes(), 34962)
    nrm_acc = len(accessors)
    accessors.append(dict(bufferView=vnrm, componentType=5126, count=int(len(nrm)), type='VEC3'))
    vidx = add_view(idx.tobytes(), 34963)
    idx_acc = len(accessors)
    accessors.append(dict(bufferView=vidx, componentType=5125, count=int(len(idx)), type='SCALAR'))
    group_prims[g].append(dict(attributes=dict(POSITION=pos_acc, NORMAL=nrm_acc), indices=idx_acc, material=mat_index[m]))
while len(bin_buf) % 4: bin_buf += b'\0'

materials = []
for m, spec in MATERIALS.items():
    materials.append(dict(name=m, doubleSided=False, pbrMetallicRoughness=dict(
        baseColorFactor=spec['color'], metallicFactor=spec['metallic'], roughnessFactor=spec['rough'])))

meshes = []
for g in range(6):
    if group_prims[g]:
        meshes.append(dict(name=GROUP_NAMES[g]+'_mesh', primitives=group_prims[g]))
# node indices
mesh_index = {}
mi = 0
for g in range(6):
    if group_prims[g]:
        mesh_index[g] = mi; mi += 1
nodes = []
# root
nodes.append(dict(name='ArmRoot', children=[]))
# find mesh node indices
def add_node(name, group, translation, children):
    node = dict(name=name, children=children)
    if group in mesh_index: node['mesh'] = mesh_index[group]
    if translation is not None: node['translation'] = list(translation)
    nodes.append(node)
    return len(nodes)-1
# build chain bottom-up indices
j5 = add_node('J5', 5, NODE_T[4], [])
j4 = add_node('J4', 4, NODE_T[3], [j5])
j3 = add_node('J3', 3, NODE_T[2], [j4])
j2 = add_node('J2', 2, NODE_T[1], [j3])
j1 = add_node('J1', 1, NODE_T[0], [j2])
st = add_node('Static', 0, None, [])
nodes[0]['children'] = [st, j1]

gltf = dict(asset=dict(version='2.0', generator='EPQ arm exporter'), scene=0,
            scenes=[dict(nodes=[0])], nodes=nodes, meshes=meshes, materials=materials,
            accessors=accessors, bufferViews=views, buffers=[dict(byteLength=len(bin_buf))])
if not meshes: raise SystemExit('no meshes')
json_chunk = json.dumps(gltf, separators=(',',':')).encode()
while len(json_chunk) % 4: json_chunk += b' '
bin_buf = bytes(bin_buf)
total = 12 + 8 + len(json_chunk) + 8 + len(bin_buf)
out = bytearray()
out += struct.pack('<III', 0x46546C67, 2, total)
out += struct.pack('<II', len(json_chunk), 0x4E4F534A); out += json_chunk
out += struct.pack('<II', len(bin_buf), 0x004E4942); out += bin_buf
raw_path = os.path.join(OUT_DIR, 'arm-raw.glb')
open(raw_path,'wb').write(out)
print('wrote', raw_path, '%.1f MB' % (len(out)/1e6), 'nodes', len(nodes), 'accessors', len(accessors))
json.dump(dict(group_names=GROUP_NAMES, node_translations=NODE_T, pivots=PIVOTS), open(os.path.join(OUT_DIR,'meta.json'),'w'), indent=1)
print('done %.1fs' % (time.time()-t0))
