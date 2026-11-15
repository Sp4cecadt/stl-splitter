import * as G from './geom.js';
import { Viewer } from './viewer.js';
import { loadFile } from './loaders.js';
import { packParts } from './pack.js';
import { stlBinary, threeMF, zipFiles, placedForFile } from './export.js';
import { MATERIALS, DEFAULT_FILAMENTS, DEFAULT_PRINT, PRINTERS, estimatePart, fmtTime } from './estimate.js';
import * as DB from './db.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clone = (o) => JSON.parse(JSON.stringify(o));
const PALETTE = ['#e8a33d', '#4aa3df', '#6cc070', '#d9534f', '#a77fd6', '#e0d24a', '#4fc1b8', '#e07fb0', '#9aa4b1', '#c08a5a'];
const JOINT_LABELS = { none: 'None (flat cut)', peg: 'Pegs', dowel: 'Dowel holes (separate dowel)', magnet: 'Magnet pockets', rod: 'Rod channel', ball: 'Ball joint', snap: 'Snap-fit tabs', dovetail: 'Dovetail', insert: 'Threaded-insert holes', hinge: 'Living hinge' };
const JOINT_FIELDS = { peg: [['dia', 'Peg Ø'], ['len', 'Length']], dowel: [['dia', 'Dowel Ø'], ['len', 'Dowel length']], magnet: [['dia', 'Magnet Ø'], ['depth', 'Magnet depth']], rod: [['dia', 'Rod Ø']], ball: [['dia', 'Ball Ø']], snap: [['width', 'Tab width'], ['thick', 'Thickness'], ['len', 'Length']], dovetail: [['width', 'Neck width'], ['height', 'Height'], ['angle', 'Angle °']], insert: [], hinge: [['thick', 'Hinge thickness'], ['gap', 'Fold gap']] };

const S = { project: null, raw: [], bodies: [], repair: [], center: [0, 0, 0], size: [0, 0, 0], result: null, pack: null, filaments: [], activeCut: null, selected: null, dirty: false, tab: 'model', plateView: 0, explode: false, ready: null };
const defaults = () => ({ cuts: [], clearance: 0.18, clearanceAuto: true, numbering: { mode: 'deboss', face: 'cut', depth: 0.6 }, scale: 100, printer: 'p2s', customBed: [200, 200, 200], packMode: 'flat', spacing: 5, defFil: 'f1', partFil: {}, ams: 'ams', print: { ...DEFAULT_PRINT }, fmt: 'stl', expOrient: 'packed' });
const st = () => S.project.settings;
let V;

// ---------- UI helpers ----------
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
async function busy(msg, fn) { $('#busyMsg').textContent = msg; $('#busy').hidden = false; await new Promise((r) => setTimeout(r, 40)); try { return await fn(); } catch (e) { console.error(e); toast('Error: ' + (e.message || e), 5000); } finally { $('#busy').hidden = true; } }
function showTab(name) {
  S.tab = name; $$('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name)); $$('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + name));
  $$('.cutonly').forEach((b) => (b.style.display = name === 'split' ? '' : 'none'));
  if (name === 'filament') renderFilament(); if (name === 'export') renderExport(); if (name === 'library') renderLibrary(); if (name === 'plates') renderPlates();
  refreshView(); $('#panels').scrollTop = 0;
}
const bed = () => { const s = st(); const p = PRINTERS.find((q) => q.id === s.printer) || PRINTERS[0]; return p.id === 'custom' ? s.customBed.map(Number) : p.bed; };
const filById = (id) => S.filaments.find((f) => f.id === id) || S.filaments[0];
const partFil = (p) => filById(st().partFil[p.label] || st().defFil);
const partColor = (p) => (p.kind === 'dowel' ? '#c9a46a' : partFil(p)?.color || PALETTE[(p.num - 1) % PALETTE.length]);

// ---------- project lifecycle ----------
async function newProjectFromFile(name, buf) {
  S.project = { id: uid(), name: name.replace(/\.[^.]+$/, ''), created: Date.now(), updated: Date.now(), file: { name, data: buf }, settings: defaults(), versions: [], photos: [], notes: '' };
  S.project.settings.defFil = (await DB.getSetting('lastDefFil')) || 'f1';
  await openModel();
  await saveProject();
}
async function openModel() {
  const p = S.project; $('#projName').value = p.name; $('#projNotes').value = p.notes || '';
  S.result = null; S.pack = null; S.activeCut = null;
  await busy('Reading & repairing mesh…', async () => {
    const { bodies } = await loadFile(p.file.name, p.file.data);
    S.raw = []; S.repair = [];
    for (const b of bodies) {
      const { manifold, report } = G.repairToManifold(b.soup, b.name); S.repair.push(report);
      if (!manifold) continue;
      const comps = manifold.decompose();
      comps.forEach((m, i) => S.raw.push({ name: comps.length > 1 ? `${b.name}_${i + 1}` : b.name, m }));
      report.components = comps.length;
    }
    if (!S.raw.length) throw new Error('Mesh could not be repaired into a solid.');
    applyScale();
  });
  renderModelInfo(); syncSettingsUI(); renderCuts(); renderVersions();
  await runSplit({ version: false, quiet: true });
}
function applyScale() {
  const s = (st().scale || 100) / 100;
  S.bodies = S.raw.map((b) => ({ name: b.name, m: s === 1 ? b.m : b.m.scale(s) }));
  const box = S.bodies.reduce((a, b) => { const bb = b.m.boundingBox(); return { min: a.min.map((v, i) => Math.min(v, bb.min[i])), max: a.max.map((v, i) => Math.max(v, bb.max[i])) }; }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  S.box = box; S.center = box.min.map((v, i) => (v + box.max[i]) / 2); S.size = box.max.map((v, i) => v - box.min[i]);
}
let saveT;
function autosave() { clearTimeout(saveT); $('#saveState').textContent = 'unsaved'; saveT = setTimeout(saveProject, 800); }
async function saveProject() {
  if (!S.project) return; const p = S.project; p.updated = Date.now(); p.name = $('#projName').value || 'Untitled'; p.notes = $('#projNotes').value;
  try { p.thumb = await thumb(); } catch (_) {}
  await DB.putProject(p); await DB.putSetting('lastProject', p.id); $('#saveState').textContent = 'saved';
}
async function thumb() { const src = V.renderer.domElement; const c = document.createElement('canvas'); c.width = 160; c.height = 120; const s = Math.max(160 / src.width, 120 / src.height); c.getContext('2d').drawImage(src, (160 - src.width * s) / 2, (120 - src.height * s) / 2, src.width * s, src.height * s); return c.toDataURL('image/jpeg', 0.7); }

// ---------- model tab ----------
function renderModelInfo() {
  $('#modelInfoCard').hidden = false; $('#repairCard').hidden = false;
  const sz = S.size.map((v) => v.toFixed(1)).join(' × ');
  const b = bed(); const fits = S.size.every((v, i) => v <= [b[0], b[1], b[2]][i]);
  $('#modelInfo').innerHTML = `<p><b>${S.project.file.name}</b><br>${S.bodies.length} separate bod${S.bodies.length > 1 ? 'ies (auto-detected as parts)' : 'y'} · ${sz} mm<br>Volume ${(S.bodies.reduce((a, q) => a + q.m.volume(), 0) / 1000).toFixed(1)} cm³ · <span class="${fits ? 'good' : 'warn'}">${fits ? 'fits the ' + (PRINTERS.find((q) => q.id === st().printer)?.name || '') + ' bed' : 'larger than the bed — split it'}</span></p>`;
  $('#repairInfo').innerHTML = S.repair.map((r) => `<p><b>${r.name}</b> — <span class="${r.status === 'ok' ? 'good' : r.status === 'partial' ? 'warn' : 'bad'}">${r.status === 'ok' ? 'manifold ✓' : r.status}</span><br>
    <span class="small muted">${r.inputTris} triangles in · ${r.outputTris ?? 0} out · merged ${r.mergedVerts} duplicate vertices · removed ${r.degenerate} degenerate & ${r.duplicates} duplicate faces · fixed ${r.flipped} flipped normals${r.invertedComponents ? ` · turned ${r.invertedComponents} inside-out shell(s)` : ''}${r.holesFilled ? ` · filled ${r.holesFilled} hole(s)` : ''}${r.droppedComponents ? ` · <span class="bad">dropped ${r.droppedComponents} unrepairable shell(s)</span>` : ''} · ${r.components || 0} component(s)</span>${r.notes.length ? '<br><span class="small warn">' + r.notes.join('<br>') + '</span>' : ''}</p>`).join('');
  $('#scalePct').value = st().scale;
  $('#vInfo').textContent = sz + ' mm';
}

// ---------- cuts ----------
function cutViz() { return st().cuts.map((c) => { const pl = G.cutPlane(c, S.center); return { id: c.id, n: pl.n, point: G.cutPoint(c, S.center) }; }); }
function updateCutViz() { if (!S.project) return; const c = st().cuts.find((q) => q.id === S.activeCut) || st().cuts[0]; const ai = c ? 'xyz'.indexOf(c.axis) : 2; const perp = S.size.filter((_, i) => i !== ai); V.setCuts(cutViz(), S.activeCut, Math.max(...perp) * 1.5 + 16); }
function addCut(axis = null, pos = null, joint = null) {
  if (!S.project) return toast('Import a model first');
  const ai = axis ? 'xyz'.indexOf(axis) : S.size.indexOf(Math.max(...S.size));
  const ax = 'xyz'[ai];
  const prevJ = st().cuts.length ? st().cuts[st().cuts.length - 1].joint : { type: 'peg', count: 'auto', params: {} };
  const c = { id: uid(), axis: ax, pos: pos ?? +S.center[ai].toFixed(1), tilt1: 0, tilt2: 0, joint: joint || clone(prevJ) };
  st().cuts.push(c); S.activeCut = c.id; markDirty(); renderCuts(); updateCutViz();
}
function markDirty() { S.dirty = true; $('#applyBtn').textContent = 'Apply split'; $('#applyBtn').classList.add('primary'); autosave(); }
function renderCuts() {
  const list = $('#cutList'); list.innerHTML = '';
  st().cuts.forEach((c, i) => {
    const ai = 'xyz'.indexOf(c.axis); const lo = S.box.min[ai], hi = S.box.max[ai];
    const jp = { ...G.JOINT_DEFAULTS[c.joint.type], ...(c.joint.params || {}) };
    const card = h('div', { class: 'card cut' + (c.id === S.activeCut ? ' active' : ''), onclick: () => { if (S.activeCut !== c.id) { S.activeCut = c.id; $$('.cut').forEach((e) => e.classList.remove('active')); card.classList.add('active'); updateCutViz(); } } },
      h('div', { class: 'head' }, h('h2', {}, `Cut ${i + 1}`), h('button', { class: 'btn small danger', onclick: (e) => { e.stopPropagation(); st().cuts.splice(i, 1); if (S.activeCut === c.id) S.activeCut = null; markDirty(); renderCuts(); updateCutViz(); } }, 'Remove')),
      h('label', {}, 'Axis', h('div', { class: 'seg' }, ...['x', 'y', 'z'].map((a) => h('button', { class: c.axis === a ? 'on' : '', onclick: () => { c.axis = a; c.pos = +S.center['xyz'.indexOf(a)].toFixed(1); c.tilt1 = c.tilt2 = 0; markDirty(); renderCuts(); updateCutViz(); } }, a.toUpperCase())))),
      h('div', { class: 'row gap' },
        h('label', { class: 'grow' }, `Position (${c.axis.toUpperCase()} mm)`, h('input', { type: 'range', min: lo.toFixed(1), max: hi.toFixed(1), step: '0.5', value: c.pos, oninput: (e) => { c.pos = +e.target.value; card.querySelector('.posn').value = c.pos; markDirty(); updateCutViz(); } })),
        h('label', { class: 'w80' }, 'mm', h('input', { class: 'posn', type: 'number', step: '0.1', value: c.pos, onchange: (e) => { c.pos = +e.target.value; markDirty(); renderCuts(); updateCutViz(); } }))),
      h('div', { class: 'row gap' },
        ...[['tilt1', 'Tilt A°'], ['tilt2', 'Tilt B°']].map(([k, lab]) => h('label', { class: 'grow' }, `${lab} `, h('span', { class: 'pill ' + k }, (c[k] || 0).toFixed(0)), h('input', { type: 'range', min: -60, max: 60, step: 1, value: c[k] || 0, oninput: (e) => { c[k] = +e.target.value; card.querySelector('.pill.' + k).textContent = c[k]; markDirty(); updateCutViz(); } })))),
      h('div', { class: 'row gap wrap' },
        h('label', { class: 'grow' }, 'Joint', h('select', { onchange: (e) => { c.joint = { type: e.target.value, count: c.joint.count || 'auto', params: {} }; markDirty(); renderCuts(); } }, ...Object.entries(JOINT_LABELS).map(([k, v]) => h('option', { value: k, selected: c.joint.type === k }, v)))),
        ['none', 'hinge'].includes(c.joint.type) ? null : h('label', { class: 'w80' }, 'Count', h('select', { onchange: (e) => { c.joint.count = e.target.value; markDirty(); } }, ...['auto', '1', '2', '3', '4'].map((k) => h('option', { value: k, selected: String(c.joint.count || 'auto') === k }, k))))),
      h('div', { class: 'row gap wrap' },
        ...(JOINT_FIELDS[c.joint.type] || []).map(([k, lab]) => h('label', { class: 'w80' }, lab, h('input', { type: 'number', step: '0.1', value: jp[k], onchange: (e) => { c.joint.params = { ...(c.joint.params || {}), [k]: +e.target.value }; markDirty(); } }))),
        c.joint.type === 'insert' ? h('label', { class: 'grow' }, 'Heat-set insert', h('select', { onchange: (e) => { c.joint.params = { size: e.target.value }; markDirty(); } }, ...Object.entries(G.INSERTS).map(([k, v]) => h('option', { value: k, selected: jp.size === k }, `${k} — hole Ø${v.hole} × ${v.depth} mm`)))) : null),
    );
    list.append(card);
  });
}
function renderSuggestions(list) {
  const el = $('#suggestions'); el.innerHTML = '';
  if (!list.length) { el.append(h('p', { class: 'muted' }, 'No obvious thin sections; model already fits the bed. Add a cut manually if you want one.')); return; }
  el.append(h('h3', {}, 'Suggested cuts'));
  for (const s of list) el.append(h('div', { class: 'ver' }, h('span', {}, h('b', {}, `${s.axis.toUpperCase()} = ${s.pos} mm`), h('br'), h('span', { class: 'muted small' }, `${s.reason}${s.area ? ` · section ${s.area} mm²` : ''}`)), h('button', { class: 'btn small', onclick: () => addCut(s.axis, s.pos) }, 'Add')));
}

// ---------- split ----------
async function runSplit({ version = true, quiet = false } = {}) {
  if (!S.project) return;
  const s = st();
  await busy(s.cuts.length ? 'Cutting & adding joints…' : 'Detecting parts…', async () => {
    const t0 = performance.now();
    const old = S.result; const keep = new Set(S.bodies.map((b) => b.m));
    const res = G.buildParts(S.bodies, { cuts: s.cuts, clearance: s.clearance, numbering: s.numbering, baseName: S.project.name.replace(/[^\w\-]+/g, '_') || 'model' }, S.center);
    if (old) for (const p of old.parts) if (!keep.has(p.m)) try { p.m.delete(); } catch (_) {}
    S.result = res; S.pack = null; S.dirty = false;
    res.ms = performance.now() - t0;
    if (version && s.cuts.length) pushVersion();
  });
  renderParts(); refreshView(); autosave();
  $('#applyBtn').textContent = 'Re-apply split'; $('#applyBtn').classList.remove('primary');
  if (!quiet) toast(`${S.result.parts.length} part(s) ready`);
}
function pushVersion() {
  const s = st(); const snap = { cuts: clone(s.cuts), clearance: s.clearance, numbering: clone(s.numbering), scale: s.scale, partFil: clone(s.partFil), defFil: s.defFil };
  const last = S.project.versions[S.project.versions.length - 1];
  if (last && JSON.stringify(last.settings) === JSON.stringify(snap)) return;
  const joints = [...new Set(s.cuts.map((c) => JOINT_LABELS[c.joint.type]))].join(', ');
  S.project.versions.push({ id: uid(), ts: Date.now(), label: `v${S.project.versions.length + 1}`, summary: `${s.cuts.length} cut(s) · ${joints} · ${S.result.parts.length} parts · ${s.clearance.toFixed(2)} mm`, settings: snap });
  renderVersions();
}
function renderVersions() {
  const el = $('#versions'); const vs = S.project?.versions || [];
  if (!vs.length) { el.innerHTML = '<p class="muted">Each applied split is saved here so you can go back to it.</p>'; return; }
  el.innerHTML = '';
  [...vs].reverse().forEach((v) => el.append(h('div', { class: 'ver' }, h('span', {}, h('b', {}, v.label), ' · ', new Date(v.ts).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' }), h('br'), h('span', { class: 'muted small' }, v.summary)),
    h('div', {}, h('button', { class: 'btn small', onclick: () => restoreVersion(v) }, 'Restore'), h('button', { class: 'btn small', onclick: () => { const n = prompt('Rename version', v.label); if (n) { v.label = n; renderVersions(); autosave(); } } }, '✎')))));
}
async function restoreVersion(v) {
  Object.assign(st(), clone(v.settings));
  if (st().scale !== undefined) applyScale();
  syncSettingsUI(); renderCuts(); updateCutViz();
  await runSplit({ version: false });
  toast('Restored ' + v.label);
}
function renderParts() {
  const r = S.result; if (!r) return;
  $('#partsCard').hidden = false; $('#partCount').textContent = r.parts.length;
  $('#splitLog').textContent = (r.log.length ? r.log.join('\n') + '\n' : '') + `Done in ${r.ms < 1000 ? Math.round(r.ms) + ' ms' : (r.ms / 1000).toFixed(1) + ' s'}.`;
  const el = $('#partsList'); el.innerHTML = '';
  const b = bed();
  for (const p of r.parts) {
    const sz = p.bbox.max.map((v, i) => v - p.bbox.min[i]);
    const big = [...sz].sort((a, c) => c - a); const bb = [...b].sort((a, c) => c - a);
    const maybe = big[0] <= Math.hypot(b[0], b[1]) && big[1] <= Math.max(b[0], b[1]) && big[2] <= bb[0];
    el.append(h('div', { class: 'part', onclick: () => { S.selected = p.num; V.highlight(p.num); } },
      h('span', { class: 'sw', style: `background:${partColor(p)}` }),
      h('span', { class: 'nm' }, p.name + (p.kind === 'dowel' ? '' : ''), h('br'), h('span', { class: 'muted small' }, `${sz.map((v) => v.toFixed(0)).join('×')} mm · ${(p.volume / 1000).toFixed(1)} cm³ ${maybe ? '' : '⚠︎ may not fit'}`)),
      p.kind === 'dowel' ? h('span', { class: 'muted small' }, 'dowel') : filSelect(p, () => { renderParts(); refreshView(); })));
  }
}
function filSelect(p, after) {
  return h('select', { onclick: (e) => e.stopPropagation(), onchange: (e) => { st().partFil[p.label] = e.target.value; autosave(); after && after(); } },
    ...S.filaments.map((f) => h('option', { value: f.id, selected: partFil(p).id === f.id }, `${f.name}`)));
}

// ---------- view ----------
function refreshView() {
  if (!S.project || !S.result) return;
  if (S.tab === 'plates' && S.pack && S.pack.plates.length) {
    const pl = S.pack.plates[Math.min(S.plateView, S.pack.plates.length - 1)];
    V.setMeshes(pl.items.map((it) => ({ id: it.p.num, arrays: it.p.arrays, color: partColor(it.p), matrix: it.matrix })), { frame: S.lastFrame !== 'plate' });
    V.setBed(bed(), true, true); V.showCuts(false); S.lastFrame = 'plate';
  } else {
    V.setMeshes(S.result.parts.map((p) => ({ id: p.num, arrays: p.arrays, color: partColor(p) })), { frame: S.lastFrame !== 'model' });
    V.setExplode(S.explode ? 0.35 : 0);
    V.setBed(bed(), $('#vBed').classList.contains('on'), false);
    V.showCuts(S.tab === 'split'); updateCutViz(); S.lastFrame = 'model';
  }
}

// ---------- filament ----------
function renderFilament() {
  const s = st?.() ; if (!S.project) return;
  $('#defFil').innerHTML = ''; S.filaments.forEach((f) => $('#defFil').append(h('option', { value: f.id, selected: f.id === s.defFil }, `${f.name} (${f.material})`)));
  $('#amsMode').value = s.ams; $('#psLayer').value = s.print.layer; $('#psWalls').value = s.print.walls; $('#psInfill').value = s.print.infill;
  renderCost(); renderFilList();
}
function costRows() {
  const s = st(); if (!S.result) return [];
  return S.result.parts.map((p) => { const f = partFil(p); const H = S.pack?.items.find((i) => i.p === p)?.o.H ?? (p.bbox.max[2] - p.bbox.min[2]); return { p, f, e: estimatePart({ volume: p.volume, area: p.area, height: H }, f, s.print) }; });
}
function renderCost() {
  const rows = costRows(); if (!rows.length) { $('#costTable').innerHTML = '<p class="muted">Apply a split first.</p>'; return; }
  const tot = rows.reduce((a, r) => ({ g: a.g + r.e.grams, c: a.c + r.e.cost, s: a.s + r.e.seconds }), { g: 0, c: 0, s: 0 });
  const t = h('table', {}, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Filament'), h('th', { class: 'n' }, 'g'), h('th', { class: 'n' }, 'A$'), h('th', { class: 'n' }, 'Time')));
  for (const r of rows) t.append(h('tr', {}, h('td', {}, r.p.label), h('td', {}, r.p.kind === 'dowel' ? 'dowel' : filSelect(r.p, () => renderCost())), h('td', { class: 'n' }, r.e.grams.toFixed(0)), h('td', { class: 'n' }, r.e.cost.toFixed(2)), h('td', { class: 'n' }, fmtTime(r.e.seconds))));
  t.append(h('tr', {}, h('th', {}, 'Total'), h('th', {}, ''), h('th', { class: 'n' }, tot.g.toFixed(0)), h('th', { class: 'n' }, tot.c.toFixed(2)), h('th', { class: 'n' }, fmtTime(tot.s))));
  $('#costTable').innerHTML = ''; $('#costTable').append(t);
}
function renderFilList() {
  const el = $('#filList'); el.innerHTML = '';
  S.filaments.forEach((f, i) => el.append(h('div', { class: 'part' },
    h('input', { type: 'color', value: f.color, style: 'width:44px;flex:none', onchange: (e) => { f.color = e.target.value; saveFils(); refreshView(); } }),
    h('input', { value: f.name, style: 'flex:2', onchange: (e) => { f.name = e.target.value; saveFils(); } }),
    h('select', { style: 'flex:1;max-width:90px', onchange: (e) => { f.material = e.target.value; saveFils(); renderCost(); } }, ...Object.keys(MATERIALS).map((m) => h('option', { value: m, selected: f.material === m }, m))),
    h('input', { type: 'number', value: f.price, step: '0.5', style: 'width:70px;flex:none', title: 'AUD per kg', onchange: (e) => { f.price = +e.target.value; saveFils(); renderCost(); } }),
    h('input', { type: 'number', value: f.slot || 1, min: 1, max: 16, style: 'width:52px;flex:none', title: 'AMS slot', onchange: (e) => { f.slot = +e.target.value; saveFils(); } }),
    h('button', { class: 'btn small danger', onclick: () => { if (S.filaments.length > 1) { S.filaments.splice(i, 1); saveFils(); renderFilament(); } } }, '✕'))));
  el.prepend(h('div', { class: 'muted small' }, 'Colour · name · material · A$/kg · AMS slot'));
}
async function saveFils() { await DB.putSetting('filaments', S.filaments); }
function applyMaterialClearance() {
  const s = st(); if (!s.clearanceAuto) return;
  const m = MATERIALS[filById(s.defFil).material] || MATERIALS.PLA; s.clearance = m.clearance; syncSettingsUI();
}

// ---------- plates ----------
async function doPack() {
  if (!S.result) return toast('Apply a split first');
  await busy('Packing plates…', async () => { const s = st(); S.pack = packParts(S.result.parts, bed(), { mode: s.packMode, spacing: +s.spacing }); S.plateView = 0; });
  renderPlates(); refreshView(); autosave();
}
function renderPlates() {
  const s = st?.(); if (!S.project) return;
  $('#printer').value = s.printer; $('#packMode').value = s.packMode; $('#spacing').value = s.spacing; $('#customBed').hidden = s.printer !== 'custom';
  [$('#bedX').value, $('#bedY').value, $('#bedZ').value] = s.customBed;
  const el = $('#plates'), ov = $('#oversize'); el.innerHTML = ''; ov.innerHTML = '';
  if (!S.pack) { el.append(h('p', { class: 'muted' }, S.result ? 'Tap “Pack parts onto plates”.' : 'Apply a split first.')); return; }
  const b = bed();
  if (S.pack.oversized.length) {
    ov.append(h('h3', { class: 'bad' }, `⚠︎ ${S.pack.oversized.length} part(s) won’t fit a ${b.join('×')} mm bed`));
    for (const it of S.pack.oversized) ov.append(h('div', { class: 'ver' }, h('span', {}, h('b', {}, it.p.label), h('br'), h('span', { class: 'muted small' }, `best fit ${it.o.rect.w.toFixed(0)}×${it.o.rect.h.toFixed(0)}×${it.o.H.toFixed(0)} mm — fits at ${(it.o.scaleToFit * 100).toFixed(0)}% scale`)),
      h('div', {}, h('button', { class: 'btn small', onclick: () => splitFurther(it.p) }, 'Split further'), h('button', { class: 'btn small', onclick: () => scaleTo(it.o.scaleToFit) }, `Scale model to ${(it.o.scaleToFit * 100).toFixed(0)}%`))));
  }
  el.append(h('p', { class: 'muted small' }, `${S.pack.plates.length} plate(s) · tap a plate to preview it in 3D. Parts are laid ${({ flat: 'on their largest flat face', cut: 'cut-face-down where that face is flat', asis: 'as modelled' })[s.packMode]} and rotated for best fit.`));
  S.pack.plates.forEach((pl, i) => {
    const cv = h('canvas', { width: 600, height: Math.round(600 * b[1] / b[0]) }); const ctx = cv.getContext('2d'); const k = cv.width / b[0];
    ctx.fillStyle = '#1a1e25'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.strokeStyle = '#2c333d';
    for (let g = 0; g <= b[0]; g += 16) { ctx.beginPath(); ctx.moveTo(g * k, 0); ctx.lineTo(g * k, cv.height); ctx.stroke(); }
    for (let g = 0; g <= b[1]; g += 16) { ctx.beginPath(); ctx.moveTo(0, cv.height - g * k); ctx.lineTo(cv.width, cv.height - g * k); ctx.stroke(); }
    for (const it of pl.items) {
      ctx.beginPath(); it.hullPlaced.forEach(([x, y], j) => (j ? ctx.lineTo(x * k, cv.height - y * k) : ctx.moveTo(x * k, cv.height - y * k))); ctx.closePath();
      ctx.fillStyle = partColor(it.p) + 'cc'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
      const cx = it.hullPlaced.reduce((a, q) => a + q[0], 0) / it.hullPlaced.length, cy = it.hullPlaced.reduce((a, q) => a + q[1], 0) / it.hullPlaced.length;
      ctx.fillStyle = '#000'; ctx.font = 'bold 26px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(it.p.num).padStart(2, '0'), cx * k, cv.height - cy * k);
    }
    const tot = pl.items.reduce((a, it) => { const e = estimatePart({ volume: it.p.volume, area: it.p.area, height: it.o.H }, partFil(it.p), s.print); return { g: a.g + e.grams, t: a.t + e.seconds }; }, { g: 0, t: 0 });
    el.append(h('div', { class: 'plate', onclick: () => { S.plateView = i; refreshView(); } }, h('h3', {}, `Plate ${i + 1} — ${pl.items.map((it) => it.p.label).join(', ')}`), cv, h('div', { class: 'muted small' }, `≈ ${tot.g.toFixed(0)} g · ≈ ${fmtTime(tot.t)} (estimate)`)));
  });
}
function splitFurther(p) {
  const sz = p.bbox.max.map((v, i) => v - p.bbox.min[i]); const ai = sz.indexOf(Math.max(...sz));
  addCut('xyz'[ai], +((p.bbox.min[ai] + p.bbox.max[ai]) / 2).toFixed(1)); showTab('split'); toast(`Added a cut through ${p.label} — adjust it, then Apply split`);
}
async function scaleTo(f) { st().scale = Math.floor(st().scale * f); applyScale(); renderModelInfo(); syncSettingsUI(); renderCuts(); await runSplit({ version: true }); await doPack(); }

// ---------- export ----------
function renderExport() {
  if (!S.project) return; const s = st();
  $('#fmt').value = s.fmt; $('#expOrient').value = s.expOrient;
  const el = $('#filCheck'); el.innerHTML = '';
  if (!S.result) { el.append(h('p', { class: 'muted' }, 'Apply a split first.')); return; }
  const used = {}; for (const r of costRows()) { if (r.p.kind === 'dowel') continue; const k = r.f.id; (used[k] ||= { f: r.f, parts: [], g: 0, c: 0 }); used[k].parts.push(r.p.label); used[k].g += r.e.grams; used[k].c += r.e.cost; }
  for (const u of Object.values(used)) el.append(h('div', { class: 'part' }, h('span', { class: 'sw', style: `background:${u.f.color}` }), h('span', { class: 'nm' }, `${u.f.name} — ${u.f.material}${s.ams === 'ams' ? ` · AMS slot ${u.f.slot || 1}` : ''}`, h('br'), h('span', { class: 'muted small' }, `${u.parts.join(', ')} · ≈${u.g.toFixed(0)} g · ≈A$${u.c.toFixed(2)}`))));
  const mats = [...new Set(Object.values(used).map((u) => u.f.material))];
  const presetTxt = mats.map((m) => `${m} preset ${MATERIALS[m].clearance} mm`).join(', ');
  el.append(h('p', { class: 'small' }, `Joint clearance used: `, h('b', {}, s.clearance.toFixed(2) + ' mm'), ` (${presetTxt})`, S.dirty ? h('span', { class: 'warn' }, ' — settings changed since last split; re-apply first.') : ''));
  el.append(h('button', { class: 'btn small', onclick: () => showTab('filament') }, 'Change filament'));
  $('#platesOut').disabled = s.ams !== 'ams'; $('#byColour').disabled = false;
  const list = $('#exportList'); list.innerHTML = '';
  for (const p of S.result.parts) list.append(h('div', { class: 'part' }, h('span', { class: 'sw', style: `background:${partColor(p)}` }), h('span', { class: 'nm' }, `${p.name}.${s.fmt}`), h('button', { class: 'btn small', onclick: () => exportOne(p) }, 'Get')));
}
function ensureConfirmed() { if (!$('#filConfirm').checked) { toast('Tick the filament check first'); $('#filConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; } if (S.dirty) { toast('Settings changed — re-apply the split first'); return false; } return true; }
function partMatrix(p) {
  if (st().expOrient !== 'packed') return null;
  if (!S.pack || S.pack.items.length !== S.result.parts.length) S.pack = packParts(S.result.parts, bed(), { mode: st().packMode, spacing: +st().spacing });
  return S.pack.items.find((i) => i.p === p)?.matrix || null;
}
function partFile(p, fmt = st().fmt) {
  const m = partMatrix(p); const arr = m ? placedForFile(p.arrays, m) : p.arrays; const f = partFil(p);
  if (fmt === '3mf') return { name: `${p.name}.3mf`, data: threeMF([{ name: p.name, arrays: arr, color: partColor(p), extruder: f.slot || 1 }], { title: p.name }), mime: 'model/3mf' };
  return { name: `${p.name}.stl`, data: stlBinary(arr, p.name), mime: 'model/stl' };
}
function exportOne(p) { if (!ensureConfirmed()) return; offer([partFile(p)]); }
async function exportZipAll() {
  if (!ensureConfirmed()) return;
  await busy('Building zip…', async () => { const files = {}; for (const p of S.result.parts) { const f = partFile(p); files[f.name] = f.data; } files['README.txt'] = new TextEncoder().encode(readme()); offer([{ name: `${baseName()}_parts.zip`, data: zipFiles(files), mime: 'application/zip' }]); });
}
async function exportPlates() {
  if (!ensureConfirmed()) return;
  await busy('Building plate 3MFs…', async () => {
    if (!S.pack || S.pack.items.length !== S.result.parts.length) S.pack = packParts(S.result.parts, bed(), { mode: st().packMode, spacing: +st().spacing });
    const out = S.pack.plates.map((pl, i) => ({ name: `${baseName()}_plate${i + 1}.3mf`, data: threeMF(pl.items.map((it) => ({ name: it.p.name, arrays: it.p.arrays, matrix: it.matrix, color: partColor(it.p), extruder: partFil(it.p).slot || 1 })), { title: `${baseName()} plate ${i + 1}` }), mime: 'model/3mf' }));
    if (S.pack.oversized.length) toast(`${S.pack.oversized.length} oversized part(s) left out — split or scale them`, 4000);
    if (out.length === 1) offer(out); else { const files = {}; out.forEach((f) => (files[f.name] = f.data)); offer([{ name: `${baseName()}_plates_3mf.zip`, data: zipFiles(files), mime: 'application/zip' }]); }
  });
}
async function exportByColour() {
  if (!ensureConfirmed()) return;
  await busy('Grouping by colour…', async () => {
    const files = {};
    for (const p of S.result.parts) { const f = partFil(p); const dir = p.kind === 'dowel' ? 'dowels' : `${f.material}_${f.name}`.replace(/[^\w\-]+/g, '_'); const pf = partFile(p); files[`${dir}/${pf.name}`] = pf.data; }
    files['README.txt'] = new TextEncoder().encode(readme());
    offer([{ name: `${baseName()}_by_colour.zip`, data: zipFiles(files), mime: 'application/zip' }]);
  });
}
const baseName = () => S.project.name.replace(/[^\w\-]+/g, '_') || 'model';
function readme() {
  const s = st(); const rows = costRows();
  return `${S.project.name} — exported by STL Splitter\n${new Date().toLocaleString('en-AU')}\nPrinter: ${PRINTERS.find((p) => p.id === s.printer)?.name} (${bed().join('x')} mm)\nJoint clearance: ${s.clearance} mm\nCuts: ${s.cuts.map((c, i) => `#${i + 1} ${c.axis.toUpperCase()}=${c.pos}mm tilt ${c.tilt1 || 0}/${c.tilt2 || 0}° ${JOINT_LABELS[c.joint.type]}`).join('; ') || 'none'}\n\n` +
    rows.map((r) => `${r.p.name}: ${r.f.name} (${r.f.material}) ~${r.e.grams.toFixed(0)} g ~A$${r.e.cost.toFixed(2)} ~${fmtTime(r.e.seconds)}`).join('\n') + '\n\nWeights, costs and times are estimates. Slice in Bambu Studio for exact values.\n' + (S.result.log.length ? '\nNotes:\n' + S.result.log.join('\n') + '\n' : '');
}
// iOS-friendly delivery: the file is built first, then the user taps Share (fresh gesture) or Download.
function offer(files) {
  const el = $('#exportReady'); el.innerHTML = '';
  for (const f of files) {
    const blob = new Blob([f.data], { type: f.mime }); const url = URL.createObjectURL(blob);
    const file = new File([blob], f.name, { type: f.mime });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    el.append(h('div', { class: 'ready' }, h('div', {}, h('b', {}, f.name), ` · ${(blob.size / 1024).toFixed(0)} KB`),
      h('div', { class: 'row gap wrap' },
        canShare ? h('button', { class: 'btn primary', onclick: async () => { try { await navigator.share({ files: [file], title: f.name }); } catch (e) { if (e.name !== 'AbortError') toast('Share failed — use Download'); } } }, 'Share / Save to Files…') : null,
        h('a', { class: 'btn', href: url, download: f.name, id: 'dl-' + f.name.replace(/\W/g, '_') }, 'Download'))));
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- library & photos ----------
async function renderLibrary() {
  const el = $('#library'); el.innerHTML = '';
  const all = (await DB.listProjects()).sort((a, b) => b.updated - a.updated);
  if (!all.length) el.append(h('p', { class: 'muted' }, 'No saved projects yet.'));
  for (const p of all) el.append(h('div', { class: 'lib' }, h('img', { src: p.thumb || 'icons/icon-192.png', alt: '' }),
    h('div', { class: 'grow' }, h('b', {}, p.name), h('br'), h('span', { class: 'muted small' }, `${new Date(p.updated).toLocaleDateString('en-AU')} · ${p.file?.name} · ${p.settings.cuts.length} cut(s) · ${p.versions.length} version(s) · ${p.photos.length} photo(s)`)),
    h('div', { class: 'col' }, p.id === S.project?.id ? h('span', { class: 'pill' }, 'open') : h('button', { class: 'btn small', onclick: () => openProject(p.id) }, 'Open'),
      h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Delete “${p.name}”? This removes its file, versions and photos from this device.`)) { await DB.deleteProject(p.id); if (p.id === S.project?.id) location.reload(); else renderLibrary(); } } }, 'Delete'))));
  renderPhotos();
}
async function openProject(id) { const p = await DB.getProject(id); if (!p) return; S.project = p; p.settings = { ...defaults(), ...p.settings }; await openModel(); await DB.putSetting('lastProject', id); showTab('split'); }
function renderPhotos() {
  const el = $('#photos'); el.innerHTML = ''; if (!S.project) return;
  for (const ph of S.project.photos) { const url = URL.createObjectURL(ph.blob); el.append(h('div', {}, h('img', { src: url, alt: 'print photo' }), h('button', { onclick: () => { S.project.photos = S.project.photos.filter((q) => q !== ph); renderPhotos(); autosave(); } }, '✕'))); }
}
async function addPhotos(files) {
  for (const f of files) {
    const bmp = await createImageBitmap(f); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)); S.project.photos.push({ id: uid(), ts: Date.now(), blob });
  }
  renderPhotos(); await saveProject(); toast('Photo saved to project');
}

// ---------- samples ----------
function sampleSTL(kind) {
  const W = G.M(); let m;
  if (kind === 'bar') m = W.Manifold.cube([300, 40, 25]).subtract(W.Manifold.cylinder(30, 6).translate([40, 20, -2])).subtract(W.Manifold.cylinder(30, 6).translate([260, 20, -2]));
  else m = W.Manifold.union(W.Manifold.cube([60, 60, 40]), W.Manifold.cylinder(50, 22, 22, 64).translate([110, 30, 0]));
  return stlBinary(G.manifoldToArrays(m), kind).buffer;
}

// ---------- settings sync ----------
function syncSettingsUI() {
  const s = st(); $('#clearance').value = s.clearance; $('#clrVal').textContent = s.clearance.toFixed(2);
  const f = filById(s.defFil); const m = MATERIALS[f.material];
  $('#clrNote').innerHTML = `Default filament ${f.name}: ${f.material} preset ${m.clearance} mm. ${s.clearanceAuto ? 'Following the material preset.' : '<b>Custom</b> — <a href="#" id="clrReset">reset to preset</a>'}<br>Presets: ${Object.entries(MATERIALS).map(([k, v]) => `${k} ${v.clearance}`).join(' · ')}`;
  const rs = $('#clrReset'); if (rs) rs.onclick = (e) => { e.preventDefault(); s.clearanceAuto = true; applyMaterialClearance(); markDirty(); };
  $('#numMode').value = s.numbering.mode; $('#numFace').value = s.numbering.face; $('#numDepth').value = s.numbering.depth;
  $('#scalePct').value = s.scale;
}

// ---------- boot ----------
async function boot() {
  V = new Viewer($('#viewer'));
  V.onGizmo = (id, n, point) => {
    const c = st().cuts.find((q) => q.id === id); if (!c) return;
    const ai = 'xyz'.indexOf(c.axis);
    if (V.gizmoMode === 'rotate') { const t = G.tiltsFromNormal(c.axis, n); c.tilt1 = +t.tilt1.toFixed(1); c.tilt2 = +t.tilt2.toFixed(1); }
    else { const d = G.dot(n, point); const nn = G.cutNormal(c); const base = S.center.slice(); base[ai] = 0; c.pos = +((d - G.dot(nn, base)) / (nn[ai] || 1)).toFixed(1); }
    markDirty();
  };
  V.onGizmoEnd = () => { renderCuts(); updateCutViz(); };
  V.onPick = (id) => { S.selected = id; V.highlight(id); const p = S.result?.parts.find((q) => q.num === id); $('#vInfo').textContent = p ? `${p.name} · ${(p.volume / 1000).toFixed(1)} cm³` : S.size.map((v) => v.toFixed(1)).join(' × ') + ' mm'; };
  await G.initManifold();
  S.filaments = (await DB.getSetting('filaments')) || clone(DEFAULT_FILAMENTS);
  $('#printer').innerHTML = ''; PRINTERS.forEach((p) => $('#printer').append(h('option', { value: p.id }, `${p.name}${p.id !== 'custom' ? ` — ${p.bed.join('×')}` : ''}`)));
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#fileIn').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; const buf = await f.arrayBuffer(); await newProjectFromFile(f.name, buf); e.target.value = ''; showTab('split'); });
  $('#sampleBar').onclick = async () => { await newProjectFromFile('bar300.stl', sampleSTL('bar')); showTab('split'); };
  $('#sampleTwo').onclick = async () => { await newProjectFromFile('two_bodies.stl', sampleSTL('two')); showTab('split'); };
  $('#scalePct').onchange = async (e) => { if (!S.project) return; st().scale = Math.max(1, +e.target.value || 100); applyScale(); renderModelInfo(); renderCuts(); await runSplit({ version: false, quiet: true }); };
  $('#inch').onclick = () => { if (!S.project) return; $('#scalePct').value = Math.round(st().scale * 25.4); $('#scalePct').dispatchEvent(new Event('change')); };
  $('#suggestBtn').onclick = () => S.project && busy('Scanning cross-sections…', async () => renderSuggestions(G.suggestSplits(S.bodies, bed())));
  $('#autoFitBtn').onclick = () => S.project && busy('Finding cuts to fit bed…', async () => { const sg = G.suggestSplits(S.bodies, bed()).filter((q) => q.fit); if (!sg.length) toast('Model already fits the bed'); sg.forEach((q) => addCut(q.axis, q.pos)); });
  $('#addCutBtn').onclick = () => addCut();
  $('#applyBtn').onclick = () => runSplit();
  $('#clearance').oninput = (e) => { st().clearance = +e.target.value; st().clearanceAuto = false; syncSettingsUI(); markDirty(); };
  $('#numMode').onchange = (e) => { st().numbering.mode = e.target.value; markDirty(); };
  $('#numFace').onchange = (e) => { st().numbering.face = e.target.value; markDirty(); };
  $('#numDepth').onchange = (e) => { st().numbering.depth = +e.target.value; markDirty(); };
  $('#defFil').onchange = async (e) => { st().defFil = e.target.value; await DB.putSetting('lastDefFil', e.target.value); applyMaterialClearance(); if (st().clearanceAuto && S.result) markDirty(); renderCost(); refreshView(); autosave(); };
  $('#amsMode').onchange = (e) => { st().ams = e.target.value; autosave(); };
  for (const [id, k] of [['psLayer', 'layer'], ['psWalls', 'walls'], ['psInfill', 'infill']]) $('#' + id).onchange = (e) => { st().print[k] = +e.target.value; renderCost(); autosave(); };
  $('#addFil').onclick = () => { S.filaments.push({ id: uid(), name: 'New filament', material: 'PLA', color: '#888888', price: 30, slot: 1 }); saveFils(); renderFilament(); };
  $('#printer').onchange = (e) => { st().printer = e.target.value; S.pack = null; renderPlates(); renderModelInfo(); autosave(); };
  for (const [id, i] of [['bedX', 0], ['bedY', 1], ['bedZ', 2]]) $('#' + id).onchange = (e) => { st().customBed[i] = +e.target.value; S.pack = null; autosave(); };
  $('#packMode').onchange = (e) => { st().packMode = e.target.value; S.pack = null; autosave(); };
  $('#spacing').onchange = (e) => { st().spacing = +e.target.value; S.pack = null; autosave(); };
  $('#packBtn').onclick = doPack;
  $('#fmt').onchange = (e) => { st().fmt = e.target.value; renderExport(); autosave(); };
  $('#expOrient').onchange = (e) => { st().expOrient = e.target.value; autosave(); };
  $('#zipAll').onclick = exportZipAll; $('#platesOut').onclick = exportPlates; $('#byColour').onclick = exportByColour;
  $('#saveProj').onclick = async () => { await saveProject(); toast('Saved'); renderLibrary(); };
  $('#newProj').onclick = () => { showTab('model'); $('#fileIn').click(); };
  $('#photoIn').onchange = (e) => { if (S.project) addPhotos([...e.target.files]); else toast('Open a project first'); e.target.value = ''; };
  $('#projName').onchange = autosave; $('#projNotes').onchange = autosave;
  $('#vFrame').onclick = () => V.frame();
  $('#vExplode').onclick = (e) => { S.explode = !S.explode; e.currentTarget.classList.toggle('on', S.explode); V.setExplode(S.explode ? 0.35 : 0); };
  $('#vBed').onclick = (e) => { e.currentTarget.classList.toggle('on'); refreshView(); };
  $('#vMove').onclick = (e) => { const on = V.gizmoMode !== 'translate'; $('#vRotate').classList.remove('on'); e.currentTarget.classList.toggle('on', on); if (on && !S.activeCut && st()?.cuts[0]) S.activeCut = st().cuts[0].id; V.gizmoMode = on ? 'translate' : null; updateCutViz(); V.setGizmoMode(V.gizmoMode); };
  $('#vRotate').onclick = (e) => { const on = V.gizmoMode !== 'rotate'; $('#vMove').classList.remove('on'); e.currentTarget.classList.toggle('on', on); if (on && !S.activeCut && st()?.cuts[0]) S.activeCut = st().cuts[0].id; V.gizmoMode = on ? 'rotate' : null; updateCutViz(); V.setGizmoMode(V.gizmoMode); };
  showTab('model');
  const last = await DB.getSetting('lastProject');
  if (last && await DB.getProject(last)) { try { await openProject(last); } catch (e) { console.error(e); } }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  S.ready = true; document.body.dataset.ready = '1';
}
window.__app = { S, runSplit, addCut, doPack, showTab, get V() { return V; } };
boot();
