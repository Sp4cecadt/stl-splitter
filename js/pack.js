// Plate packing: orientation choice + rotation-aware MaxRects bin packing.
const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };
const app3 = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
export function rotBetween(a, b) { // rotation (row-major 3x3) taking unit a to unit b
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c < -0.999999) { const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const u = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]]; const l = Math.hypot(...u); const [x, y, z] = u.map((q) => q / l); return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1]; }
  const k = 1 / (1 + c); const [x, y, z] = v;
  return [1 - k * (y * y + z * z), k * x * y - z, k * x * z + y, k * x * y + z, 1 - k * (x * x + z * z), k * y * z - x, k * x * z - y, k * y * z + x, 1 - k * (x * x + y * y)];
}
const AXIS_ORIENTS = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]].map((d) => rotBetween(d, [0, 0, -1]));
function hull2d(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up);
}
function rectAt(hull, th) { const c = Math.cos(th), s = Math.sin(th); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const [x, y] of hull) { const X = c * x - s * y, Y = s * x + c * y; x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); } return { th, w: x1 - x0, h: y1 - y0, x0, y0 }; }
function bestRect(hull, bx, by) {
  // min-area rectangle over hull edge angles, then (if needed) any angle that fits the bed
  let best = null;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; const th = -Math.atan2(b[1] - a[1], b[0] - a[0]); const r = rectAt(hull, th); if (!best || r.w * r.h < best.w * best.h) best = r; }
  if (!best) best = rectAt(hull, 0);
  const fits = (r) => (r.w <= bx && r.h <= by);
  const cands = [best, rectAt(hull, best.th + Math.PI / 2)];
  for (const r of cands) if (fits(r)) return { ...r, fit: true };
  let bf = null; for (let d = 0; d < 180; d += 2) { const r = rectAt(hull, d * Math.PI / 180); if (fits(r) && (!bf || r.w * r.h < bf.w * bf.h)) bf = r; }
  if (bf) return { ...bf, fit: true };
  return { ...best, fit: false };
}
function samplePts(arr, max = 6000) { const n = arr.pos.length / 3; const step = Math.max(1, Math.floor(n / max)); const out = []; for (let i = 0; i < n; i += step) out.push([arr.pos[i * 3], arr.pos[i * 3 + 1], arr.pos[i * 3 + 2]]); return out; }

// Area of faces lying on the bed (normal ≈ -Z and at the lowest Z) for rotation R.
function contactArea(arr, R, z0) {
  const P = arr.pos, T = arr.tri; let a = 0; const step = T.length > 600000 ? 3 * Math.ceil(T.length / 600000) : 3;
  for (let t = 0; t < T.length; t += step) {
    const A = app3(R, [P[T[t] * 3], P[T[t] * 3 + 1], P[T[t] * 3 + 2]]), B = app3(R, [P[T[t + 1] * 3], P[T[t + 1] * 3 + 1], P[T[t + 1] * 3 + 2]]), C = app3(R, [P[T[t + 2] * 3], P[T[t + 2] * 3 + 1], P[T[t + 2] * 3 + 2]]);
    if (A[2] - z0 > 0.05 || B[2] - z0 > 0.05 || C[2] - z0 > 0.05) continue;
    const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (nz < 0) a += -nz / 2; // downward-facing (CCW seen from below)
  }
  return a * (step / 3);
}
// mode: 'flat' = largest flat face on the bed (default), 'cut' = cut face down when it is flat, 'asis' = as modelled
export function orientPart(part, bed, mode) {
  const pts = samplePts(part.arrays);
  const cands = [];
  const lastFace = part.faces && part.faces.length ? part.faces[part.faces.length - 1] : null;
  if (mode === 'asis') cands.push({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], why: 'as modelled' });
  if (lastFace && mode !== 'asis') cands.push({ R: rotBetween(lastFace.n, [0, 0, -1]), why: 'cut face down', cut: true });
  AXIS_ORIENTS.forEach((R, i) => cands.push({ R, why: i === 0 ? 'as modelled' : 'flat face down' }));
  const evald = cands.map((c) => {
    const P = pts.map((p) => app3(c.R, p));
    let z0 = Infinity, z1 = -Infinity; for (const p of P) { z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    const H = z1 - z0; const hull = hull2d(P.map((p) => [p[0], p[1]]));
    const r = bestRect(hull, bed[0], bed[1]);
    const res = { R: c.R, why: c.why, H, z0, hull, rect: r, fit: r.fit && H <= bed[2] };
    res.contact = mode === 'asis' && c.why === 'as modelled' ? 1e12 : contactArea(part.arrays, c.R, z0);
    if (c.cut && mode === 'cut') res.contact *= 4; // prefer the cut face if it is genuinely flat
    res.score = Math.max(r.w / bed[0], r.h / bed[1], H / bed[2]);
    return res;
  });
  const fitting = evald.filter((e) => e.fit);
  if (fitting.length) {
    fitting.sort((a, b) => (b.contact / Math.sqrt(b.H + 1) - a.contact / Math.sqrt(a.H + 1)) || (a.H - b.H));
    return fitting[0];
  }
  const f = evald.sort((a, b) => a.score - b.score)[0]; f.scaleToFit = Math.floor(100 / f.score) / 100;
  return f;
}

// MaxRects (best short side fit)
class Bin { constructor(w, h) { this.free = [{ x: 0, y: 0, w, h }]; }
  insert(w, h) {
    let best = null;
    for (const f of this.free) for (const [ww, hh, rot] of [[w, h, false], [h, w, true]]) if (ww <= f.w + 1e-6 && hh <= f.h + 1e-6) { const s = Math.min(f.w - ww, f.h - hh); if (!best || s < best.s) best = { x: f.x, y: f.y, w: ww, h: hh, rot, s }; }
    if (!best) return null;
    const nf = [];
    for (const f of this.free) {
      if (best.x >= f.x + f.w || best.x + best.w <= f.x || best.y >= f.y + f.h || best.y + best.h <= f.y) { nf.push(f); continue; }
      if (best.x > f.x) nf.push({ x: f.x, y: f.y, w: best.x - f.x, h: f.h });
      if (best.x + best.w < f.x + f.w) nf.push({ x: best.x + best.w, y: f.y, w: f.x + f.w - best.x - best.w, h: f.h });
      if (best.y > f.y) nf.push({ x: f.x, y: f.y, w: f.w, h: best.y - f.y });
      if (best.y + best.h < f.y + f.h) nf.push({ x: f.x, y: best.y + best.h, w: f.w, h: f.y + f.h - best.y - best.h });
    }
    this.free = nf.filter((a, i) => !nf.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.w * a.h < b.w * b.h)));
    return best;
  }
}

export function packParts(parts, bed, opts = {}) {
  const sp = opts.spacing ?? 5, edge = opts.edge ?? 3;
  const bedU = [bed[0] - 2 * edge, bed[1] - 2 * edge, bed[2]];
  const items = parts.map((p) => ({ p, o: orientPart(p, bedU, opts.mode || 'flat') }));
  const plates = []; const oversized = [];
  const order = items.filter((i) => i.o.fit).sort((a, b) => b.o.rect.w * b.o.rect.h - a.o.rect.w * a.o.rect.h);
  for (const it of items) if (!it.o.fit) oversized.push(it);
  const W = bed[0] - 2 * edge + sp, H = bed[1] - 2 * edge + sp;
  for (const it of order) {
    let placed = null, pi = 0;
    for (; pi < plates.length; pi++) { placed = plates[pi].bin.insert(it.o.rect.w + sp, it.o.rect.h + sp); if (placed) break; }
    if (!placed) { plates.push({ bin: new Bin(W, H), items: [] }); pi = plates.length - 1; placed = plates[pi].bin.insert(it.o.rect.w + sp, it.o.rect.h + sp); }
    if (!placed) { it.o.scaleToFit = Math.floor(100 * Math.min(bedU[0] / it.o.rect.w, bedU[1] / it.o.rect.h, 1)) / 100; oversized.push(it); continue; } // safety
    it.plate = pi; it.place = placed; plates[pi].items.push(it);
  }
  // Build transforms (column-major 4x4) original -> plate coords
  for (const it of items) {
    const { R, rect, z0 } = it.o;
    let th = rect.th; let x0 = rect.x0, y0 = rect.y0;
    const c = Math.cos(th), s = Math.sin(th);
    let Rz = [c, -s, 0, s, c, 0, 0, 0, 1];
    let M3 = mul3(Rz, R);
    let tx = -x0, ty = -y0, w = rect.w, h = rect.h;
    if (it.place && it.place.rot) { // extra 90° about z: (x,y)->(-y,x) then shift
      const R90 = [0, -1, 0, 1, 0, 0, 0, 0, 1]; M3 = mul3(R90, M3); const ntx = -ty, nty = tx; tx = ntx + h; ty = nty; [w, h] = [h, w];
    }
    const ox = it.place ? edge + it.place.x : 0, oy = it.place ? edge + it.place.y : 0;
    tx += ox; ty += oy;
    it.matrix = [M3[0], M3[3], M3[6], 0, M3[1], M3[4], M3[7], 0, M3[2], M3[5], M3[8], 0, tx, ty, -z0, 1];
    it.footprint = { w, h, H: it.o.H };
    it.hullPlaced = it.o.hull.map(([x, y]) => { const X = c * x - s * y - x0, Y = s * x + c * y - y0; return it.place && it.place.rot ? [-Y + h, X] : [X, Y]; }).map(([x, y]) => [x + ox, y + oy]);
    if (it.place && it.place.rot) it.hullPlaced = it.o.hull.map(([x, y]) => { const X = c * x - s * y - x0, Y = s * x + c * y - y0; return [-Y + rect.h + ox, X + oy]; });
  }
  return { plates: plates.map((pl, i) => ({ index: i, items: pl.items })), oversized, items };
}
export function applyMatrix(arr, m) {
  const out = new Float32Array(arr.pos.length);
  for (let i = 0; i < arr.pos.length; i += 3) { const x = arr.pos[i], y = arr.pos[i + 1], z = arr.pos[i + 2]; out[i] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; }
  return { pos: out, tri: arr.tri };
}
