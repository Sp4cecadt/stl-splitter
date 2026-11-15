// IndexedDB: projects (original file, settings, versions, photos) + app settings.
const DB = 'stl-splitter', VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' }); if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && 'result' in r ? r.result : undefined); t.onerror = () => rej(t.error); }); };
export const putProject = (p) => tx('projects', 'readwrite', (s) => s.put(p));
export const getProject = (id) => tx('projects', 'readonly', (s) => s.get(id));
export const deleteProject = (id) => tx('projects', 'readwrite', (s) => s.delete(id));
export const listProjects = () => tx('projects', 'readonly', (s) => s.getAll());
export const getSetting = (k) => tx('settings', 'readonly', (s) => s.get(k));
export const putSetting = (k, v) => tx('settings', 'readwrite', (s) => s.put(v, k));
