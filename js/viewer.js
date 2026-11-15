// three.js viewer: Z-up scene, parts, cut planes with gizmo, bed, plate preview.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x15181d);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000); this.camera.position.set(300, -400, 300);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1, -1.5, 2); this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.5); dl2.position.set(-1, 1, -0.5); this.scene.add(dl2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true;
    this.parts = new THREE.Group(); this.scene.add(this.parts);
    this.cuts = new THREE.Group(); this.scene.add(this.cuts);
    this.bed = new THREE.Group(); this.scene.add(this.bed);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('local'); this.gizmo.setSize(1.1);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; if (!e.value && this.onGizmoEnd) this.onGizmoEnd(); });
    this.gizmo.addEventListener('objectChange', () => { const o = this.gizmo.object; if (o && this.onGizmo) { const n = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion); this.onGizmo(o.userData.cutId, [n.x, n.y, n.z], [o.position.x, o.position.y, o.position.z]); } });
    this.explode = 0; this.center = new THREE.Vector3(); this.radius = 100;
    new ResizeObserver(() => this.resize()).observe(el); this.resize();
    this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); });
    // tap to select part
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || this.gizmo.dragging) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObjects(this.parts.children, false)[0];
      if (this.onPick) this.onPick(hit ? hit.object.userData.id : null);
    });
  }
  resize() { const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1; this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%'; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  clearGroup(g) { while (g.children.length) { const c = g.children.pop(); c.traverse((o) => { o.geometry?.dispose?.(); }); } }
  // list: [{id, arrays:{pos,tri}, color, matrix?(column-major)}]
  setMeshes(list, { frame = true } = {}) {
    this.clearGroup(this.parts);
    const box = new THREE.Box3();
    for (const it of list) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(it.arrays.pos, 3)); g.setIndex(new THREE.BufferAttribute(it.arrays.tri, 1));
      const ng = g.toNonIndexed(); ng.computeVertexNormals(); g.dispose();
      const mat = new THREE.MeshStandardMaterial({ color: it.color || '#9aa4b1', roughness: 0.65, metalness: 0.05, flatShading: false });
      const mesh = new THREE.Mesh(ng, mat); mesh.userData.id = it.id;
      if (it.matrix) { mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(it.matrix); }
      ng.computeBoundingBox(); const c = new THREE.Vector3(); ng.boundingBox.getCenter(c); mesh.userData.c = c;
      this.parts.add(mesh); mesh.updateMatrixWorld(); box.expandByObject(mesh);
    }
    if (!box.isEmpty()) { box.getCenter(this.center); this.radius = box.getSize(new THREE.Vector3()).length() / 2; this.minZ = box.min.z; }
    this.applyExplode();
    if (frame) this.frame();
  }
  highlight(id) { for (const m of this.parts.children) { m.material.emissive = new THREE.Color(m.userData.id === id ? 0x334455 : 0x000000); } }
  setExplode(f) { this.explode = f; this.applyExplode(); }
  applyExplode() {
    for (const m of this.parts.children) { if (!m.matrixAutoUpdate) continue; const d = m.userData.c.clone().sub(this.center); m.position.copy(d.multiplyScalar(this.explode)); }
  }
  frame() { const r = Math.max(this.radius, 20); const dir = new THREE.Vector3(0.6, -1, 0.75).normalize(); this.controls.target.copy(this.center); this.camera.position.copy(this.center).add(dir.multiplyScalar(r * 2.6)); this.camera.near = r / 100; this.camera.far = r * 100; this.camera.updateProjectionMatrix(); }
  // cuts: [{id, n:[..], point:[..]}]
  setCuts(cuts, activeId, size) {
    const keepAttached = this.gizmo.object?.userData.cutId;
    this.gizmo.detach(); this.clearGroup(this.cuts);
    for (const c of cuts) {
      const active = c.id === activeId;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: active ? 0xff9a2e : 0x3fa7ff, transparent: true, opacity: active ? 0.32 : 0.16, side: THREE.DoubleSide, depthWrite: false }));
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: active ? 0xff9a2e : 0x3fa7ff }));
      m.add(edge);
      m.position.set(...c.point); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...c.n));
      m.userData.cutId = c.id; this.cuts.add(m);
      if (active && this.gizmoMode) this.attach(m);
    }
  }
  attach(m) { this.gizmo.attach(m); this.setGizmoMode(this.gizmoMode); }
  setGizmoMode(mode) {
    this.gizmoMode = mode; const g = this.gizmo;
    if (!mode) { g.detach(); return; }
    if (!g.object) { const a = this.cuts.children.find((c) => c.material.opacity > 0.3); if (a) g.attach(a); }
    g.setMode(mode === 'rotate' ? 'rotate' : 'translate');
    g.showX = mode === 'rotate'; g.showY = mode === 'rotate'; g.showZ = mode !== 'rotate';
  }
  showCuts(v) { this.cuts.visible = v; this.gizmo.getHelper().visible = v; this.gizmo.enabled = v; }
  setBed(bed, visible, plateMode) {
    this.clearGroup(this.bed); this.bed.visible = visible; if (!bed) return;
    const [x, y, z] = bed;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(x, y), new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.9, transparent: true, opacity: 0.85 }));
    const grid = new THREE.GridHelper(Math.max(x, y), Math.round(Math.max(x, y) / 16), 0x4a5260, 0x363c46); grid.rotation.x = Math.PI / 2; grid.position.z = 0.05;
    const vol = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)), new THREE.LineBasicMaterial({ color: 0x55606e }));
    vol.position.z = z / 2; const grp = new THREE.Group(); grp.add(plate, grid, vol);
    if (plateMode) grp.position.set(x / 2, y / 2, 0); else grp.position.set(this.center.x, this.center.y, (this.minZ ?? 0) - 0.1);
    this.bed.add(grp);
  }
  snapshot() { return this.renderer.domElement.toDataURL('image/jpeg', 0.8); }
}
