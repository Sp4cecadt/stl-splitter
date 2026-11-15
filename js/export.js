// STL / 3MF writers and zip packaging (fflate).
import { zipSync, strToU8 } from '../vendor/three/addons/libs/fflate.module.js';
import { applyMatrix } from './pack.js';

export function stlBinary(arr, header = 'STL Splitter') {
  const n = arr.tri.length / 3; const buf = new ArrayBuffer(84 + n * 50); const dv = new DataView(buf);
  const h = strToU8(header.slice(0, 79)); new Uint8Array(buf, 0, h.length).set(h);
  dv.setUint32(80, n, true); const P = arr.pos, T = arr.tri;
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50; const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    for (let k = 0; k < 3; k++) { const v = T[t * 3 + k] * 3; dv.setFloat32(o + 12 + k * 12, P[v], true); dv.setFloat32(o + 16 + k * 12, P[v + 1], true); dv.setFloat32(o + 20 + k * 12, P[v + 2], true); }
  }
  return new Uint8Array(buf);
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const f = (v) => (Math.round(v * 1e5) / 1e5).toString();
// objects: [{name, arrays, color '#rrggbb', extruder (1-based), matrix? (column-major 4x4)}]
export function threeMF(objects, opts = {}) {
  const colors = [...new Set(objects.map((o) => (o.color || '#cccccc').toUpperCase()))];
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  parts.push(`<metadata name="Application">STL Splitter PWA</metadata>\n<metadata name="Title">${esc(opts.title || 'parts')}</metadata>\n<resources>\n<basematerials id="1">\n`);
  colors.forEach((c, i) => parts.push(`<base name="colour${i + 1}" displaycolor="${c}FF"/>\n`));
  parts.push('</basematerials>\n');
  objects.forEach((o, i) => {
    const arr = o.arrays; const pi = colors.indexOf((o.color || '#cccccc').toUpperCase());
    parts.push(`<object id="${i + 2}" type="model" name="${esc(o.name)}" pid="1" pindex="${pi}"><mesh><vertices>\n`);
    const P = arr.pos; const vs = new Array(P.length / 3);
    for (let v = 0; v < P.length / 3; v++) vs[v] = `<vertex x="${f(P[v * 3])}" y="${f(P[v * 3 + 1])}" z="${f(P[v * 3 + 2])}"/>`;
    parts.push(vs.join('\n')); parts.push('\n</vertices><triangles>\n');
    const T = arr.tri; const ts = new Array(T.length / 3);
    for (let t = 0; t < T.length / 3; t++) ts[t] = `<triangle v1="${T[t * 3]}" v2="${T[t * 3 + 1]}" v3="${T[t * 3 + 2]}"/>`;
    parts.push(ts.join('\n')); parts.push('\n</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n');
  objects.forEach((o, i) => {
    const m = o.matrix; const tr = m ? ` transform="${[m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]].map(f).join(' ')}"` : '';
    parts.push(`<item objectid="${i + 2}"${tr} printable="1"/>\n`);
  });
  parts.push('</build>\n</model>\n');
  const ct = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  // Slicer hints: per-object extruder (AMS slot). Bambu Studio / Orca / PrusaSlicer style configs.
  const bambu = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + objects.map((o, i) => `  <object id="${i + 2}">\n    <metadata key="name" value="${esc(o.name)}"/>\n    <metadata key="extruder" value="${o.extruder || 1}"/>\n  </object>`).join('\n') + '\n</config>\n';
  const prusa = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + objects.map((o, i) => `<object id="${i + 2}" instances_count="1">\n <metadata type="object" key="name" value="${esc(o.name)}"/>\n <metadata type="object" key="extruder" value="${o.extruder || 1}"/>\n <volume firstid="0" lastid="${o.arrays.tri.length / 3 - 1}">\n  <metadata type="volume" key="extruder" value="${o.extruder || 1}"/>\n </volume>\n</object>`).join('\n') + '\n</config>\n';
  return zipSync({
    '[Content_Types].xml': strToU8(ct), '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(parts.join('')),
    'Metadata/model_settings.config': strToU8(bambu), 'Metadata/Slic3r_PE_model.config': strToU8(prusa),
  }, { level: 6 });
}
export function zipFiles(files) { // {path: Uint8Array}
  return zipSync(files, { level: 6 });
}
export function placedForFile(arr, matrix) { // oriented on bed, dropped to z=0, centred on origin XY
  const a = applyMatrix(arr, matrix);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < a.pos.length; i += 3) { x0 = Math.min(x0, a.pos[i]); x1 = Math.max(x1, a.pos[i]); y0 = Math.min(y0, a.pos[i + 1]); y1 = Math.max(y1, a.pos[i + 1]); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; for (let i = 0; i < a.pos.length; i += 3) { a.pos[i] -= cx; a.pos[i + 1] -= cy; }
  return a;
}
