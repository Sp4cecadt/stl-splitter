// File import: STL (binary/ASCII), OBJ, 3MF (core + Bambu/production-extension components).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync, strFromU8 } from '../vendor/three/addons/libs/fflate.module.js';

function geomToSoup(g, matrix) {
  g = g.index ? g.toNonIndexed() : g.clone();
  if (matrix) g.applyMatrix4(matrix);
  return new Float32Array(g.attributes.position.array);
}
export async function loadFile(name, buf) {
  const ext = name.split('.').pop().toLowerCase();
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_') || 'model';
  if (ext === 'stl') { const g = new STLLoader().parse(buf); return { base, bodies: [{ name: base, soup: geomToSoup(g) }] }; }
  if (ext === 'obj') {
    const grp = new OBJLoader().parse(new TextDecoder().decode(buf)); grp.updateMatrixWorld(true);
    const bodies = []; grp.traverse((o) => { if (o.isMesh) bodies.push({ name: o.name || base + '_' + bodies.length, soup: geomToSoup(o.geometry, o.matrixWorld) }); });
    // OBJ is often Y-up: leave as-is (user can rotate in slicer); merge into one body list
    return { base, bodies };
  }
  if (ext === '3mf') return { base, bodies: parse3MF(new Uint8Array(buf), base) };
  throw new Error('Unsupported file type: .' + ext + ' (use STL, OBJ or 3MF)');
}
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseT = (s) => s ? s.trim().split(/\s+/).map(Number) : IDENT.slice();
const mulT = (a, b) => { // apply a then b (3MF row-vector convention)
  const r = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
};
export function parse3MF(u8, base) {
  const files = unzipSync(u8);
  const norm = (p) => p.replace(/^\//, '');
  let root = '3D/3dmodel.model';
  if (files['_rels/.rels']) { const m = strFromU8(files['_rels/.rels']).match(/Target="([^"]+\.model)"/i); if (m) root = norm(m[1]); }
  const docs = {};
  const getDoc = (path) => {
    path = norm(path); if (docs[path]) return docs[path];
    const key = Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase()); if (!key) throw new Error('3MF missing ' + path);
    const xml = new DOMParser().parseFromString(strFromU8(files[key]), 'application/xml');
    const objs = {};
    for (const o of xml.getElementsByTagNameNS('*', 'object')) objs[o.getAttribute('id')] = o;
    return docs[path] = { xml, objs };
  };
  const bodies = [];
  const emit = (path, id, T, name, acc) => {
    const d = getDoc(path); const o = d.objs[id]; if (!o) return;
    const nm = name || o.getAttribute('name');
    const mesh = [...o.children].find((c) => c.localName === 'mesh');
    if (mesh) {
      const vs = mesh.getElementsByTagNameNS('*', 'vertex'); const V = new Float64Array(vs.length * 3);
      for (let i = 0; i < vs.length; i++) { const x = +vs[i].getAttribute('x'), y = +vs[i].getAttribute('y'), z = +vs[i].getAttribute('z'); V[i * 3] = x * T[0] + y * T[3] + z * T[6] + T[9]; V[i * 3 + 1] = x * T[1] + y * T[4] + z * T[7] + T[10]; V[i * 3 + 2] = x * T[2] + y * T[5] + z * T[8] + T[11]; }
      const ts = mesh.getElementsByTagNameNS('*', 'triangle');
      for (const t of ts) for (const a of ['v1', 'v2', 'v3']) { const k = +t.getAttribute(a) * 3; acc.push(V[k], V[k + 1], V[k + 2]); }
    }
    const comps = o.getElementsByTagNameNS('*', 'component');
    for (const c of comps) emit(c.getAttribute('p:path') || path, c.getAttribute('objectid'), mulT(parseT(c.getAttribute('transform')), T), nm, acc);
  };
  const rd = getDoc(root);
  const items = rd.xml.getElementsByTagNameNS('*', 'item');
  for (const it of items) {
    const acc = []; const id = it.getAttribute('objectid');
    emit(it.getAttribute('p:path') || root, id, parseT(it.getAttribute('transform')), null, acc);
    if (acc.length) bodies.push({ name: (rd.objs[id]?.getAttribute('name') || base + '_' + bodies.length).replace(/[^\w\-]+/g, '_'), soup: new Float32Array(acc) });
  }
  if (!bodies.length) throw new Error('No printable meshes found in 3MF');
  return bodies;
}
