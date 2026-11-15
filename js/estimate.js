// Filament, tolerance, cost and print-time heuristics. All values are editable estimates.
export const MATERIALS = {
  PLA: { density: 1.24, clearance: 0.18, flow: 11, note: 'PLA 0.15–0.2 mm' },
  'PLA-CF': { density: 1.30, clearance: 0.2, flow: 9, note: 'CF-filled 0.2 mm' },
  PETG: { density: 1.27, clearance: 0.28, flow: 8, note: 'PETG 0.25–0.3 mm' },
  ABS: { density: 1.04, clearance: 0.25, flow: 9, note: 'ABS 0.25 mm' },
  ASA: { density: 1.07, clearance: 0.25, flow: 9, note: 'ASA 0.25 mm' },
  TPU: { density: 1.21, clearance: 0.4, flow: 3.5, note: 'TPU 0.4 mm' },
  PA: { density: 1.12, clearance: 0.3, flow: 6, note: 'Nylon 0.3 mm' },
};
// Editable defaults (AUD/kg) — rough starting points, NOT verified current prices.
export const DEFAULT_FILAMENTS = [
  { id: 'f1', name: 'Bambu PLA Basic White', material: 'PLA', color: '#f2f2f2', price: 30, slot: 1 },
  { id: 'f2', name: 'Bambu PLA Basic Black', material: 'PLA', color: '#222222', price: 30, slot: 2 },
  { id: 'f3', name: 'Bambu PLA Basic Red', material: 'PLA', color: '#d0312d', price: 30, slot: 3 },
  { id: 'f4', name: 'Bambu PLA Basic Blue', material: 'PLA', color: '#2a6fdb', price: 30, slot: 4 },
  { id: 'f5', name: 'Bambu PETG HF Grey', material: 'PETG', color: '#8a8f96', price: 30, slot: 1 },
  { id: 'f6', name: 'Bambu ABS Black', material: 'ABS', color: '#1d1d1d', price: 35, slot: 1 },
  { id: 'f7', name: 'Bambu ASA White', material: 'ASA', color: '#eeeeee', price: 40, slot: 1 },
  { id: 'f8', name: 'Bambu TPU 95A Black', material: 'TPU', color: '#333333', price: 55, slot: 1 },
  { id: 'f9', name: 'Bambu PLA-CF Black', material: 'PLA-CF', color: '#2b2b2b', price: 45, slot: 1 },
];
export const DEFAULT_PRINT = { layer: 0.2, walls: 2, infill: 15, lineWidth: 0.42, topBottom: 5 };

// part: {volume mm³, area mm², height mm}; fil: {material, price}; ps: print settings
export function estimatePart(part, fil, ps = DEFAULT_PRINT, flowOverride) {
  const mat = MATERIALS[fil?.material] || MATERIALS.PLA;
  const V = Math.max(0, part.volume), A = Math.max(0, part.area), H = part.height || 10;
  const shellT = Math.max(ps.walls * ps.lineWidth, ps.topBottom * ps.layer * 0.6); // effective skin thickness
  const shell = Math.min(V, A * shellT);
  const extruded = shell + (V - shell) * (ps.infill / 100);
  const grams = extruded / 1000 * mat.density;
  const cost = grams / 1000 * (fil?.price ?? 30);
  const flow = (flowOverride || mat.flow) * (ps.layer / 0.2) ** 0.5; // mm³/s average incl. slower outer walls
  const layers = Math.ceil(H / ps.layer);
  const seconds = extruded / flow * 1.12 /* travel/accel */ + layers * 1.2 /* layer change */;
  return { grams, cost, seconds, extruded, layers };
}
export function fmtTime(s) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; }
export const PRINTERS = [
  { id: 'p2s', name: 'Bambu Lab P2S', bed: [256, 256, 256], ams: true },
  { id: 'p1s', name: 'Bambu Lab P1S', bed: [256, 256, 256], ams: true },
  { id: 'x1c', name: 'Bambu Lab X1C', bed: [256, 256, 256], ams: true },
  { id: 'a1', name: 'Bambu Lab A1', bed: [256, 256, 256], ams: true },
  { id: 'a1mini', name: 'Bambu Lab A1 mini', bed: [180, 180, 180], ams: true },
  { id: 'mk4', name: 'Prusa MK4', bed: [250, 210, 220], ams: false },
  { id: 'ender3', name: 'Creality Ender 3', bed: [220, 220, 250], ams: false },
  { id: 'custom', name: 'Custom…', bed: [200, 200, 200], ams: false },
];
