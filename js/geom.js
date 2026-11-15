// Geometry core: manifold-3d (WASM) wrapper — repair, components, cuts, joints, numbering.
// No DOM / three.js dependency so it can be unit-tested in Node.
let W = null;
export async function initManifold() {
  if (W) return W;
  const mod = (await import('../vendor/manifold/manifold.js')).default;
  W = await mod();
  W.setup();
  W.setMinCircularAngle(8);
  W.setMinCircularEdgeLength(0.4);
  return W;
}
export const M = () => W;

// ---------- small vector helpers ----------
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Frame for a plane n·x = d. Local z = n, plane at z = 0, u×v = n.
export function planeFrame(n, d) {
  n = norm(n);
  const u = Math.abs(n[2]) < 0.9 ? norm(cross([0, 0, 1], n)) : norm(cross([0, 1, 0], n)); // keeps text upright
  const v = cross(n, u);
  const toWorld = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * d, n[1] * d, n[2] * d, 1];
  const toLocal = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, -d, 1];
  return { n, d, u, v, toWorld, toLocal,
    world: (x, y, z = 0) => add3(add3(add3(scl3(u, x), scl3(v, y)), scl3(n, z)), scl3(n, d)),
    local: (p) => [dot(p, u), dot(p, v), dot(p, n) - d] };
}

// ---------- mesh <-> manifold ----------
export function manifoldToArrays(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  let pos = mesh.vertProperties;
  if (np !== 3) { pos = new Float32Array(nv * 3); for (let i = 0; i < nv; i++) { pos[i * 3] = mesh.vertProperties[i * np]; pos[i * 3 + 1] = mesh.vertProperties[i * np + 1]; pos[i * 3 + 2] = mesh.vertProperties[i * np + 2]; } }
  return { pos: new Float32Array(pos), tri: new Uint32Array(mesh.triVerts) };
}

// Repair raw triangle soup (Float32Array, 9 floats per triangle) into a Manifold, with report.
export function repairToManifold(soup, name = 'body') {
  const { Manifold, Mesh } = W;
  const rep = { name, inputTris: soup.length / 9, mergedVerts: 0, degenerate: 0, duplicates: 0, flipped: 0, invertedComponents: 0, holesFilled: 0, droppedComponents: 0, status: '', notes: [] };
  // 1. merge vertices
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < soup.length; i += 3) { const x = soup[i], y = soup[i + 1], z = soup[i + 2]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; if (z < minz) minz = z; if (z > maxz) maxz = z; }
  const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz) || 1;
  const eps = Math.max(diag * 1e-6, 1e-6);
  const map = new Map(); const verts = []; const idx = new Uint32Array(soup.length / 3);
  for (let i = 0, k = 0; i < soup.length; i += 3, k++) {
    const key = Math.round(soup[i] / eps) + ',' + Math.round(soup[i + 1] / eps) + ',' + Math.round(soup[i + 2] / eps);
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(soup[i], soup[i + 1], soup[i + 2]); }
    idx[k] = id;
  }
  rep.mergedVerts = soup.length / 3 - verts.length / 3;
  // 2. degenerate + duplicate faces
  let tris = []; const seen = new Set();
  const P = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) { rep.degenerate++; continue; }
    const pa = P(a), pb = P(b), pc = P(c);
    const cr = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
    if (Math.hypot(cr[0], cr[1], cr[2]) < eps * eps * 1e-2) { rep.degenerate++; continue; }
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) { rep.duplicates++; continue; }
    seen.add(key); tris.push([a, b, c]);
  }
  // 3. consistent winding per connected component + outward orientation
  const fixWinding = () => {
    const edgeMap = new Map();
    const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
    tris.forEach((t, i) => { for (let e = 0; e < 3; e++) { const k = ek(t[e], t[(e + 1) % 3]); let l = edgeMap.get(k); if (!l) edgeMap.set(k, l = []); l.push(i); } });
    const comp = new Int32Array(tris.length).fill(-1); let nc = 0;
    const has = (t, a, b) => (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);
    for (let s = 0; s < tris.length; s++) {
      if (comp[s] >= 0) continue; const stack = [s]; comp[s] = nc; const members = [s];
      while (stack.length) {
        const i = stack.pop(); const t = tris[i];
        for (let e = 0; e < 3; e++) {
          const a = t[e], b = t[(e + 1) % 3]; const l = edgeMap.get(ek(a, b));
          if (l.length !== 2) continue;
          const j = l[0] === i ? l[1] : l[0]; if (comp[j] >= 0) continue;
          if (has(tris[j], a, b)) { tris[j] = [tris[j][0], tris[j][2], tris[j][1]]; rep.flipped++; }
          comp[j] = nc; stack.push(j); members.push(j);
        }
      }
      let vol = 0; for (const i of members) { const [a, b, c] = tris[i].map(P); vol += dot(a, cross(b, c)); }
      if (vol < 0) { rep.invertedComponents++; for (const i of members) tris[i] = [tris[i][0], tris[i][2], tris[i][1]]; }
      nc++;
    }
    return { edgeMap, comp, nc };
  };
  fixWinding();
  const tryBuild = (tl) => {
    const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tl.flat()) });
    mesh.merge();
    return new Manifold(mesh);
  };
  let man = null;
  try { man = tryBuild(tris); } catch (e) { rep.notes.push('Initial build: ' + (e.message || e)); }
  if (!man) {
    // 4. fill holes: boundary loops fan-triangulated to a centroid vertex
    const dirCount = new Map(); const und = new Map();
    for (const t of tris) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; dirCount.set(a + '>' + b, 1); const k = a < b ? a + '_' + b : b + '_' + a; und.set(k, (und.get(k) || 0) + 1); }
    const next = new Map();
    for (const t of tris) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = a < b ? a + '_' + b : b + '_' + a; if (und.get(k) === 1) { if (!next.has(a)) next.set(a, []); next.get(a).push(b); } }
    const used = new Set();
    for (const [start, outs] of next) {
      for (const first of outs) {
        if (used.has(start + '>' + first)) continue;
        const loop = [start]; let cur = start, nx = first, guard = 0, ok = false;
        while (guard++ < 100000) {
          used.add(cur + '>' + nx); loop.push(nx);
          if (nx === start) { ok = true; break; }
          const cand = (next.get(nx) || []).filter((c) => !used.has(nx + '>' + c));
          if (!cand.length) break; cur = nx; nx = cand[0];
        }
        if (!ok || loop.length < 4) continue;
        loop.pop();
        let c = [0, 0, 0]; for (const v of loop) c = add3(c, P(v)); c = scl3(c, 1 / loop.length);
        const ci = verts.length / 3; verts.push(c[0], c[1], c[2]);
        for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; tris.push([b, a, ci]); }
        rep.holesFilled++;
      }
    }
    if (rep.holesFilled) fixWinding();
    try { man = tryBuild(tris); } catch (e) { rep.notes.push('After hole fill: ' + (e.message || e)); }
  }
  if (!man) {
    // 5. per-component salvage
    const { comp, nc } = fixWinding();
    const ok = [];
    for (let c = 0; c < nc; c++) {
      const tl = tris.filter((_, i) => comp[i] === c);
      try { ok.push(tryBuild(tl)); } catch (e) { rep.droppedComponents++; }
    }
    if (ok.length) man = W.Manifold.compose(ok);
  }
  if (!man || man.isEmpty()) { rep.status = 'failed'; rep.notes.push('Could not make this mesh manifold. Try repairing it in Bambu Studio / Meshmixer first.'); return { manifold: null, report: rep }; }
  rep.status = rep.droppedComponents ? 'partial' : 'ok';
  rep.outputTris = man.numTri(); rep.volume = man.volume(); rep.genus = man.genus();
  return { manifold: man, report: rep };
}

export function bbox(m) { const b = m.boundingBox(); return { min: b.min, max: b.max, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] }; }

// ---------- cut planes ----------
const BASE = { x: [[0, 1, 0], [0, 0, 1], [1, 0, 0]], y: [[0, 0, 1], [1, 0, 0], [0, 1, 0]], z: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
export function cutNormal(cut) {
  const [e1, e2, a] = BASE[cut.axis || 'z'];
  const t1 = (cut.tilt1 || 0) * Math.PI / 180, t2 = (cut.tilt2 || 0) * Math.PI / 180;
  const l = [Math.sin(t2) * Math.cos(t1), -Math.sin(t1), Math.cos(t2) * Math.cos(t1)];
  return norm(add3(add3(scl3(e1, l[0]), scl3(e2, l[1])), scl3(a, l[2])));
}
export function tiltsFromNormal(axis, n) {
  const [e1, e2, a] = BASE[axis];
  const l = [dot(n, e1), dot(n, e2), dot(n, a)];
  return { tilt1: -Math.asin(Math.max(-1, Math.min(1, l[1]))) * 180 / Math.PI, tilt2: Math.atan2(l[0], l[2]) * 180 / Math.PI };
}
export function cutPoint(cut, center) { const p = center.slice(); p['xyz'.indexOf(cut.axis || 'z')] = cut.pos; return p; }
export function cutPlane(cut, center) { const n = cutNormal(cut); return { n, d: dot(n, cutPoint(cut, center)) }; }

// ---------- 2D helpers ----------
function pointInPolys(pt, polys) {
  let inside = false;
  for (const poly of polys) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyCentroid(polys) { let x = 0, y = 0, n = 0; for (const p of polys) for (const q of p) { x += q[0]; y += q[1]; n++; } return [x / n, y / n]; }
function deepestPoint(region) {
  let cur = region, d = 0, last = region;
  for (let i = 0; i < 60; i++) { const o = region.offset(-(d + 1), 'Round'); if (o.isEmpty()) break; last = o; d += 1; }
  const polys = last.toPolygons();
  const c = polyCentroid(polys);
  const p = pointInPolys(c, polys) ? c : polys[0][0];
  return { p, depth: d };
}
function resample(polys, step) {
  const out = [];
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.floor(L / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
// Choose joint locations inside a cross-section.
export function chooseJointPoints(sec, inset, count, minInset) {
  let region = sec.offset(-inset, 'Round');
  if (region.isEmpty() && minInset) region = sec.offset(-minInset, 'Round');
  if (region.isEmpty()) return [];
  const pts = [];
  const islands = region.decompose().map((r) => ({ r, area: r.area(), b: r.bounds() })).sort((a, b) => b.area - a.area);
  for (const isl of islands) {
    if (isl.area < 0.5) continue;
    const long = Math.max(isl.b.max[0] - isl.b.min[0], isl.b.max[1] - isl.b.min[1]);
    let k = count === 'auto' ? (long > 160 ? 3 : long > 50 ? 2 : 1) : +count;
    const deep = deepestPoint(isl.r);
    if (k <= 1) { pts.push(deep.p); continue; }
    const cand = resample(isl.r.toPolygons(), 2);
    if (cand.length < 2) { pts.push(deep.p); continue; }
    // farthest pair, then farthest point sampling
    let best = [0, 1], bd = -1;
    const step = Math.max(1, Math.floor(cand.length / 300));
    for (let i = 0; i < cand.length; i += step) for (let j = i + 1; j < cand.length; j += step) { const d = (cand[i][0] - cand[j][0]) ** 2 + (cand[i][1] - cand[j][1]) ** 2; if (d > bd) { bd = d; best = [i, j]; } }
    const chosen = [cand[best[0]], cand[best[1]]];
    // pull the two end points a little toward the middle so they sit in thicker material
    while (chosen.length < k) {
      let bi = -1, bdist = -1;
      for (let i = 0; i < cand.length; i++) { const dmin = Math.min(...chosen.map((c) => (c[0] - cand[i][0]) ** 2 + (c[1] - cand[i][1]) ** 2)); if (dmin > bdist) { bdist = dmin; bi = i; } }
      chosen.push(cand[bi]);
    }
    pts.push(...chosen);
  }
  return pts;
}

// ---------- 7-segment digits for embossed numbers ----------
const SEG = { a: [0, 0.86, 0.6, 1], b: [0.46, 0.5, 0.6, 1], c: [0.46, 0, 0.6, 0.5], d: [0, 0, 0.6, 0.14], e: [0, 0, 0.14, 0.5], f: [0, 0.5, 0.14, 1], g: [0, 0.43, 0.6, 0.57] };
const DIG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
export function textSection(str, h) {
  const { CrossSection } = W; const rects = [];
  const adv = 0.85; const total = str.length * adv - 0.25;
  [...str].forEach((ch, i) => {
    const segs = DIG[ch]; if (!segs) return;
    for (const s of segs) { const [x0, y0, x1, y1] = SEG[s]; rects.push(CrossSection.square([(x1 - x0) * h, (y1 - y0) * h]).translate([(x0 + i * adv - total / 2) * h, (y0 - 0.5) * h])); }
  });
  return { cs: CrossSection.union(rects), w: total * h, h };
}

// ---------- joints ----------
export const JOINT_DEFAULTS = {
  none: {},
  peg: { dia: 6, len: 6 },
  dowel: { dia: 6, len: 20 },
  magnet: { dia: 6, depth: 3 },
  rod: { dia: 8 },
  ball: { dia: 10 },
  snap: { width: 8, thick: 2, len: 8 },
  dovetail: { width: 10, height: 5, angle: 15 },
  insert: { size: 'M3' },
  hinge: { thick: 0.6, gap: 1.2 },
};
export const INSERTS = { // heat-set insert hole (Ø, depth), screw clearance Ø, head Ø — typical published values
  M2: { hole: 3.2, depth: 4.0, clear: 2.4, head: 4.0 },
  'M2.5': { hole: 3.6, depth: 5.0, clear: 2.9, head: 5.0 },
  M3: { hole: 4.0, depth: 5.7, clear: 3.4, head: 6.0 },
  M4: { hole: 5.6, depth: 8.1, clear: 4.5, head: 8.0 },
  M5: { hole: 6.4, depth: 9.5, clear: 5.5, head: 9.5 },
};
function jointRadius(type, p) {
  switch (type) {
    case 'peg': case 'dowel': case 'magnet': case 'rod': return p.dia / 2;
    case 'ball': return p.dia / 2;
    case 'snap': return Math.max(p.width, p.thick * 3) / 2 + 1;
    case 'dovetail': return p.width / 2 + p.height * Math.tan(p.angle * Math.PI / 180);
    case 'insert': return INSERTS[p.size].head / 2;
    default: return 2;
  }
}
// thickness of solid m from world point along direction dir (first exit)
function thickness(m, p, dir, maxLen = 400) {
  const o = add3(p, scl3(dir, 0.02)); const e = add3(p, scl3(dir, maxLen));
  try { const hits = m.rayCast(o, e); if (!hits.length) return 0; return hits[0].distance * (maxLen - 0.02) + 0.02; } catch (_) { return maxLen; }
}
const cyl = (h, r, z0, r2) => W.Manifold.cylinder(h, r, r2 ?? r, 0, false).translate([0, 0, z0]);
const box = (x0, y0, z0, x1, y1, z1) => W.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
const prism = (poly2d, len) => W.Manifold.extrude(W.CrossSection.ofPolygons([poly2d]), len).rotate([90, 0, 0]).translate([0, len / 2, 0]); // profile (x,z) extruded along y, centred
const unionAll = (arr) => arr.length ? W.Manifold.union(arr) : null;

// Apply one cut (+ joint) to a manifold. Returns {pos, neg, merged, extras, jointPts(world), skipped}
export function applyCut(m, plane, joint, clearance) {
  const fr = planeFrame(plane.n, plane.d);
  const type = joint?.type || 'none'; const p = { ...JOINT_DEFAULTS[type], ...(joint?.params || {}) };
  const c = clearance;
  const local = m.transform(fr.toLocal);
  const sec = local.slice(0);
  if (sec.isEmpty()) return null;
  const b = m.boundingBox(); const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) + 10;
  const out = { extras: [], jointPts: [], skipped: 0, notes: [] };
  if (type === 'hinge') {
    const bb = sec.bounds(); const ht = p.thick, g = p.gap;
    const cutter = box(-1e4, bb.min[1] + ht, -g / 2, 1e4, 1e4, g / 2).transform(fr.toWorld);
    out.merged = m.subtract(cutter);
    out.notes.push('Living hinge: parts stay joined by a ' + ht + ' mm strip along one edge. Print with the hinge flat on the bed; PETG/PP/TPU flex far better than PLA.');
    return out;
  }
  let [P, N] = m.splitByPlane(fr.n, fr.d);
  if (P.isEmpty() || N.isEmpty()) return null;
  if (type === 'none') { out.pos = P; out.neg = N; return out; }
  const r = jointRadius(type, p);
  const count = joint?.count ?? 'auto';
  const pts = chooseJointPoints(sec, r + 2.0, count, r + 0.8);
  const addN = [], subN = [], addP = [], subP = [], subBoth = [];
  const ctr = (() => { const bb = sec.bounds(); return [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2]; })();
  for (const [x, y] of pts) {
    const wp = fr.world(x, y, 0);
    const tP = thickness(P, wp, fr.n), tN = thickness(N, wp, scl3(fr.n, -1));
    const T = (g) => g.translate([x, y, 0]).transform(fr.toWorld);
    let used = true;
    switch (type) {
      case 'peg': {
        const L = Math.min(p.len, tP - 1.2, tN + 4);
        if (L < 2) { used = false; break; }
        const r0 = p.dia / 2; const ch = Math.min(0.8, r0 * 0.3);
        addN.push(T(cyl(L - ch + 0.3, r0, -0.3).add(cyl(ch, r0, L - ch, r0 - ch))));
        subP.push(T(cyl(L + 0.4 + 0.5, r0 + c, -0.5)));
        break;
      }
      case 'dowel': {
        const r0 = p.dia / 2; const hP = Math.min(p.len / 2, tP - 1.2), hN = Math.min(p.len / 2, tN - 1.2);
        if (hP < 2 || hN < 2) { used = false; break; }
        subP.push(T(cyl(hP + 0.5 + 0.5, r0 + c, -0.5)));
        subN.push(T(cyl(hN + 0.5 + 0.5, r0 + c, -(hN + 0.5))));
        out.extras.push({ kind: 'dowel', m: cyl(hP + hN, r0, 0, r0), note: `Dowel Ø${p.dia} × ${(hP + hN).toFixed(1)} mm (or use a metal/wood dowel)` });
        break;
      }
      case 'magnet': {
        const r0 = p.dia / 2 + c * 0.5; const dpt = p.depth + 0.2;
        if (tP < dpt + 0.8 || tN < dpt + 0.8) { used = false; break; }
        subP.push(T(cyl(dpt + 0.5, r0, -0.5)));
        subN.push(T(cyl(dpt + 0.5, r0, -dpt)));
        break;
      }
      case 'rod': {
        subBoth.push(T(cyl(diag * 4, p.dia / 2 + c, -diag * 2)));
        break;
      }
      case 'ball': {
        const R = p.dia / 2, rn = R * 0.5, zc = R * 0.55 + R;
        if (tP < zc + R + 1.2) { used = false; break; }
        addN.push(T(cyl(zc + 0.3, rn, -0.3).add(W.Manifold.sphere(R).translate([0, 0, zc]))));
        subP.push(T(W.Manifold.sphere(R + c).translate([0, 0, zc]).add(cyl(zc + 0.5, R * 0.86 + c, -0.5))));
        break;
      }
      case 'snap': {
        const w = p.width, t = p.thick, L = p.len, hk = Math.max(0.6, t * 0.45);
        if (tP < L + 1.5) { used = false; break; }
        const dir = (x - ctr[0]) >= 0 ? 1 : -1; // hooks point outward
        let beam = box(-t / 2, -w / 2, -0.3, t / 2, w / 2, L);
        const hook = prism([[t / 2 - 0.01, L - 2.6], [t / 2 + hk, L - 1.4], [t / 2 + hk, L - 0.9], [t / 2 - 0.01, L]], w);
        beam = beam.add(hook);
        const slot = box(-t / 2 - c - hk - 0.3, -w / 2 - c, -0.5, t / 2 + c, w / 2 + c, L + 0.5)
          .add(box(t / 2, -w / 2 - c, L - 2.6 - c, t / 2 + hk + c, w / 2 + c, L + 0.5));
        const flip = dir < 0 ? (g) => g.rotate([0, 0, 180]) : (g) => g;
        addN.push(T(flip(beam))); subP.push(T(flip(slot)));
        break;
      }
      case 'dovetail': {
        const sb = sec.bounds(); const alongV = (sb.max[1] - sb.min[1]) > (sb.max[0] - sb.min[0]);
        const h = Math.min(p.height, tP * 0.5); if (h < 1.5) { used = false; break; }
        const ta = Math.tan(p.angle * Math.PI / 180), W0 = p.width / 2;
        const prof = [[-W0, -0.3], [W0, -0.3], [W0 + h * ta, h], [-W0 - h * ta, h]];
        const profC = [[-W0 - c, -0.5], [W0 + c, -0.5], [W0 + h * ta + c, h + c], [-W0 - h * ta - c, h + c]];
        const rot = (g) => alongV ? g : g.rotate([0, 0, 90]);
        const clip = P.add(N.intersect(box(-1e4, -1e4, -0.3, 1e4, 1e4, 0.001).transform(fr.toWorld)));
        const key = T(rot(prism(prof, diag * 4))).intersect(clip);
        addN.push(key); subP.push(T(rot(prism(profC, diag * 4))));
        break;
      }
      case 'insert': {
        const s = INSERTS[p.size] || INSERTS.M3;
        if (tN < s.depth + 1) { used = false; break; }
        subN.push(T(cyl(s.depth + 1.0 + 0.5, s.hole / 2, -(s.depth + 1.0))));
        const thru = cyl(tP + 2, s.clear / 2 + c * 0.5, -0.5);
        const cb = tP > 6 ? cyl(4, s.head / 2 + c, tP - Math.min(3, tP * 0.4)) : null;
        subP.push(T(cb ? thru.add(cb) : thru));
        break;
      }
    }
    if (used) out.jointPts.push(wp); else out.skipped++;
  }
  if (type === 'dovetail' && out.jointPts.length) out.notes.push('Dovetail slides in sideways along the cut face.');
  const aN = unionAll(addN), sN = unionAll(subN), aP = unionAll(addP), sP = unionAll(subP), sB = unionAll(subBoth);
  if (sB) { P = P.subtract(sB); N = N.subtract(sB); }
  if (aN) N = N.add(aN); if (sN) N = N.subtract(sN);
  if (aP) P = P.add(aP); if (sP) P = P.subtract(sP);
  if (out.skipped) out.notes.push(`${out.skipped} joint location(s) skipped: material too thin there.`);
  if (!pts.length) out.notes.push('Cut face too small for this joint size; split without joint.');
  out.pos = P; out.neg = N; out.jointRadius = r;
  return out;
}

// ---------- full pipeline ----------
// bodies: [{name, m}], cfg: {cuts, clearance, numbering:{mode,face,depth}, baseName}
export function buildParts(bodies, cfg, center) {
  const log = [];
  let parts = bodies.map((b, i) => ({ m: b.m, faces: [], src: i, kind: 'part', jointPts: [] }));
  const extras = [];
  cfg.cuts.forEach((cut, ci) => {
    const pl = cutPlane(cut, center);
    const next = [];
    for (const part of parts) {
      const b = part.m.boundingBox();
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 8; k++) { const q = [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]]; const s = dot(q, pl.n) - pl.d; lo = Math.min(lo, s); hi = Math.max(hi, s); }
      if (lo > -0.05 || hi < 0.05) { next.push(part); continue; }
      let res = null;
      try { res = applyCut(part.m, pl, cut.joint, cfg.clearance); } catch (e) { log.push(`Cut ${ci + 1}: failed on a part (${e.message || e}); left unsplit.`); }
      if (!res) { next.push(part); continue; }
      res.notes.forEach((n) => log.push(`Cut ${ci + 1}: ${n}`));
      const jp = part.jointPts.concat(res.jointPts.map((p) => ({ p, r: res.jointRadius || 3 })));
      if (res.merged) { for (const m of res.merged.decompose()) next.push({ ...part, m, jointPts: jp }); continue; }
      for (const [side, mm] of [[1, res.pos], [-1, res.neg]]) {
        for (const m of mm.decompose()) {
          if (m.volume() < 1e-3) continue;
          next.push({ m, src: part.src, kind: 'part', faces: part.faces.concat([{ n: scl3(pl.n, -side), d: -side * pl.d, cut: ci }]), jointPts: jp });
        }
      }
      res.extras.forEach((e) => extras.push(e));
    }
    parts = next;
  });
  // stable numbering: sort by bbox centre z, y, x
  const cen = (m) => { const b = m.boundingBox(); return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]; };
  parts.forEach((p) => p.c = cen(p.m));
  parts.sort((a, b) => (a.c[2] - b.c[2]) || (a.c[1] - b.c[1]) || (a.c[0] - b.c[0]));
  const all = parts.concat(extras.map((e) => ({ ...e, faces: [], jointPts: [] })));
  const pad = all.length >= 100 ? 3 : 2;
  let pn = 0, dn = 0;
  all.forEach((p) => {
    if (p.kind === 'dowel') { dn++; p.num = parts.length + dn; p.label = `dowel${String(dn).padStart(2, '0')}`; }
    else { pn++; p.num = pn; p.label = `part${String(pn).padStart(pad, '0')}`; }
    p.name = `${cfg.baseName}_${p.label}`;
  });
  // numbering text
  const nb = cfg.numbering || { mode: 'none' };
  if (nb.mode !== 'none') for (const p of parts) {
    try { const r = numberPart(p, nb); if (r.note) log.push(`${p.label}: ${r.note}`); } catch (e) { log.push(`${p.label}: number not added (${e.message || e})`); }
  }
  for (const p of all) { p.volume = p.m.volume(); p.area = p.m.surfaceArea(); const b = p.m.boundingBox(); p.bbox = { min: b.min, max: b.max }; p.arrays = manifoldToArrays(p.m); }
  return { parts: all, log };
}

function numberPart(p, nb) {
  const text = String(p.num).padStart(2, '0');
  const b = p.m.boundingBox();
  const faces = [];
  if (nb.face === 'cut') for (let i = p.faces.length - 1; i >= 0; i--) faces.push({ ...p.faces[i], inset: 0.05 });
  if (nb.face === 'top' || !faces.length) faces.push({ n: [0, 0, 1], d: b.max[2], inset: 0.3 });
  if (nb.face === 'bottom') faces.unshift({ n: [0, 0, -1], d: -b.min[2], inset: 0.3 });
  const depth = nb.depth || 0.6;
  for (const f of faces) {
    const fr = planeFrame(f.n, f.d);
    let region = p.m.transform(fr.toLocal).slice(-f.inset);
    if (region.isEmpty()) continue;
    // keep text away from joints
    const holes = p.jointPts.map((j) => { const l = fr.local(j.p); return Math.abs(l[2]) < 30 ? W.CrossSection.circle(j.r + 2.5, 24).translate([l[0], l[1]]) : null; }).filter(Boolean);
    if (holes.length) region = region.subtract(W.CrossSection.union(holes));
    if (region.isEmpty()) continue;
    const deep = deepestPoint(region);
    const clear = deep.depth + 0.5;
    const hMax = nb.maxHeight || 10;
    const h = Math.min(hMax, clear / (0.5 * Math.hypot(text.length * 0.85 - 0.25, 1) + 0.05));
    if (h < 3) continue;
    const t = textSection(text, h);
    let g;
    if (nb.mode === 'emboss') g = W.Manifold.extrude(t.cs, depth + 0.2).translate([deep.p[0], deep.p[1], -0.2 - f.inset]);
    else g = W.Manifold.extrude(t.cs, depth + 1).translate([deep.p[0], deep.p[1], -depth - f.inset]);
    g = g.transform(fr.toWorld);
    p.m = nb.mode === 'emboss' ? p.m.add(g) : p.m.subtract(g);
    return { note: '' };
  }
  return { note: 'no flat area large enough for a number (needs ~3 mm text)' };
}

// ---------- suggested split points ----------
export function suggestSplits(bodies, bed) {
  const m = bodies.length > 1 ? W.Manifold.compose(bodies.map((b) => b.m)) : bodies[0].m;
  const bb = m.boundingBox(); const out = [];
  const lim = Math.max(bed[0], bed[1], bed[2]) - 6; // longest any part may be (could be stood diagonal-free)
  ['x', 'y', 'z'].forEach((axis, ai) => {
    const lo = bb.min[ai], hi = bb.max[ai], L = hi - lo; if (L < 10) return;
    const n = [0, 0, 0]; n[ai] = 1;
    const fr = planeFrame(n, 0); const loc = m.transform(fr.toLocal);
    const N = 80; const s = [];
    for (let i = 1; i < N; i++) { const z = lo + L * i / N; s.push({ z, a: loc.slice(z).area() }); }
    const med = s.map((q) => q.a).sort((a, b) => a - b)[Math.floor(s.length / 2)] || 1;
    const maxA = Math.max(...s.map((q) => q.a));
    for (let i = 3; i < s.length - 3; i++) {
      const a = s[i].a; if (a <= 0) continue;
      let isMin = true; for (let k = -3; k <= 3; k++) if (k && s[i + k].a < a) isMin = false;
      if (isMin && a < 0.75 * med && a < maxA * 0.7) out.push({ axis, pos: +s[i].z.toFixed(1), area: Math.round(a), reason: 'thin section (local cross-section minimum)' });
    }
    const pieces = Math.ceil(L / lim);
    if (pieces > 1) for (let k = 1; k < pieces; k++) {
      const target = lo + L * k / pieces; const win = L / pieces * 0.2;
      let best = null; for (const q of s) if (Math.abs(q.z - target) <= win && q.a > 0 && (!best || q.a < best.a * 0.98 || (q.a <= best.a * 1.02 && Math.abs(q.z - target) < Math.abs(best.z - target)))) best = q;
      const z = best ? best.z : target;
      out.push({ axis, pos: +z.toFixed(1), area: Math.round(best ? best.a : 0), reason: `needed to fit the bed (${L.toFixed(0)} mm long → ${pieces} pieces)`, fit: true });
    }
  });
  // dedupe close suggestions
  const res = [];
  for (const q of out.sort((a, b) => (b.fit ? 1 : 0) - (a.fit ? 1 : 0))) if (!res.some((r) => r.axis === q.axis && Math.abs(r.pos - q.pos) < 5)) res.push(q);
  return res.slice(0, 12);
}
