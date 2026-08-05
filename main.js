/**
 * main_tobesusedingithub.js
 * ─────────────────────────────────────────────────────────────────────────
 * Bundle único (sin ES modules) que combina:
 *   - shared/state.js
 *   - APP/backend-local.js
 *   - shared/core.js
 *   - APP/main.js
 * Generado para poder servirse como <script> normal (sin type="module"),
 * evitando problemas de CORS al abrir index.html directamente (file://)
 * o al publicarlo en GitHub Pages.
 *
 * Depende de globals CDN cargadas en index.html: exifr, heic2any, piexif.
 * ─────────────────────────────────────────────────────────────────────────
 */

/* ════════════════════════════════════════════════════════════════════════
 * shared/state.js — funciones puras compartidas entre UI desktop y móvil.
 * Sin DOM, sin backend, sin estado global.
 * ════════════════════════════════════════════════════════════════════════ */

function isManaged(it) {
  return it?.managed === 'trash' || it?.managed === 'ideas' || it?.managed === 'selected' || it?.managed === 'low';
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function fmtSpan(startMs, endMs) {
  const start = new Date(startMs), end = new Date(endMs);
  const sameDay = start.toDateString() === end.toDateString();
  const d = start.toLocaleDateString();
  const s = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const e = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return startMs === endMs ? `${d} · ${s}` : `${d} · ${s} – ${e}`;
  return `${start.toLocaleString()} – ${end.toLocaleString()}`;
}

/**
 * Agrupa items por ventana temporal.
 * @returns {Array<{startTs, endTs, items}>}
 */
function buildGroups(allItems, showManaged, currentMins) {
  const source = showManaged ? allItems : allItems.filter(it => !isManaged(it));
  const sorted = [...source].sort((a, b) => a.ts - b.ts);
  const win = currentMins * 60 * 1000;
  const groups = [];
  if (!sorted.length) return groups;
  let start = sorted[0].ts, end = sorted[0].ts, prev = sorted[0].ts, items = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    if (it.ts - prev <= win) { items.push(it); prev = it.ts; end = it.ts; }
    else { groups.push({ startTs: start, endTs: end, items }); start = end = prev = it.ts; items = [it]; }
  }
  groups.push({ startTs: start, endTs: end, items });
  return groups;
}

/**
 * Construye las estructuras de datos a partir de los datos crudos del backend.
 * @returns {{ allItems, itemByKey, trashSet, starSet, ideaSet, lowSet }}
 */
function populateItems(photos, backend) {
  const allItems  = [];
  const itemByKey = new Map();
  const trashSet  = new Set();
  const starSet   = new Set();
  const ideaSet   = new Set();
  const lowSet    = new Set();

  for (const p of photos) {
    const item = {
      relPath: p.relPath,
      name:    p.name,
      size:    p.size    || 0,
      ts:      p.ts,
      managed: p.managed || null,
      model:   p.model   || null,
      hasGPS:  p.hasGPS  ?? null,
      hdLevel: p.hdLevel || null,
      lat:     p.lat     ?? null,
      lng:     p.lng     ?? null,
      pixW:    p.pixW    || 0,
      pixH:    p.pixH    || 0,
      ...(p._extra || {}),
    };
    allItems.push(item);
    itemByKey.set(backend.keyFor(item), item);
    if (p.mark === 'trash') trashSet.add(backend.keyFor(item));
    else if (p.mark === 'star')  starSet.add(backend.keyFor(item));
    else if (p.mark === 'idea')  ideaSet.add(backend.keyFor(item));
    const shorter = Math.min(item.pixW, item.pixH);
    if (shorter > 0 && (item.hdLevel === 'sd' || item.hdLevel === '1k') && !item.managed)
      lowSet.add(backend.keyFor(item));
  }
  return { allItems, itemByKey, trashSet, starSet, ideaSet, lowSet };
}

/**
 * Calcula contadores de estado.
 * @returns {{ total, nStar, nTrash, nIdea, nLow, nNoGps, nPending }}
 */
function computeCounts(allItems, trashSet, starSet, ideaSet, lowSet) {
  const total = allItems.length, nStar = starSet.size, nTrash = trashSet.size, nIdea = ideaSet.size;
  let mTrash = 0, mIdeas = 0, mLow = 0, nNoGps = 0;
  for (const it of allItems) {
    if (it.managed === 'trash') mTrash++;
    else if (it.managed === 'ideas') mIdeas++;
    else if (it.managed === 'low') mLow++;
    if (!isManaged(it) && it.hasGPS === false) nNoGps++;
  }
  return {
    total, nStar, nTrash, nIdea, nLow: lowSet.size, nNoGps,
    nPending: total - (mTrash + mIdeas + mLow) - nStar - nTrash - nIdea,
  };
}

/* Alias equivalentes a los renombrados en el `import { … as … }` original de core.js */
const buildGroupsFn    = buildGroups;
const populateItemsFn  = populateItems;
const computeCountsFn  = computeCounts;

/* ════════════════════════════════════════════════════════════════════════
 * APP/backend-local.js — backend para File System Access API (modo local).
 * Depende de globals CDN: exifr, heic2any, piexif (cargadas en index.html).
 * ════════════════════════════════════════════════════════════════════════ */

/* ── Utilidades ─────────────────────────────────────────────────────────────── */
function isJpeg(it) { return /\.(jpe?g)$/i.test(it.name) || it.file?.type === 'image/jpeg'; }
function isHeicName(name = '') { return /\.(heic|heif)$/i.test(name); }
function isHeicFile(f) { return (f?.type && /image\/hei[cf]/i.test(f.type)) || isHeicName(f?.name); }

/* ── pHash / histograma ───────────────────────────────────────────────────── */
const PHASH_SIZE = 32;
const DCT_SIZE   = 16;
const pHashCache = new Map();
const histCache  = new Map();

let phashDB = null;

function openPhashDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('phash_cache_v2', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('hashes', { keyPath: 'k' });
    req.onsuccess = e => { phashDB = e.target.result; res(phashDB); };
    req.onerror = () => rej(req.error);
  });
}
async function dbGetHash(key) {
  if (!phashDB) return null;
  return new Promise(res => {
    const tx = phashDB.transaction('hashes', 'readonly');
    const req = tx.objectStore('hashes').get(key);
    req.onsuccess = () => res(req.result ? BigInt('0x' + req.result.h) : null);
    req.onerror = () => res(null);
  });
}
async function dbSetHash(key, hash) {
  if (!phashDB) return;
  return new Promise(res => {
    const tx = phashDB.transaction('hashes', 'readwrite');
    tx.objectStore('hashes').put({ k: key, h: hash.toString(16) });
    tx.oncomplete = res; tx.onerror = res;
  });
}

function dct8(row) {
  const N = row.length, out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += row[n] * Math.cos(Math.PI * k * (2*n+1) / (2*N));
    out[k] = (k === 0 ? Math.SQRT1_2 : 1) * s;
  }
  return out;
}
function computePHash(imgEl) {
  const c = document.createElement('canvas');
  c.width = c.height = PHASH_SIZE;
  const ctx = c.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, PHASH_SIZE, PHASH_SIZE);
  const { data } = ctx.getImageData(0, 0, PHASH_SIZE, PHASH_SIZE);
  const gray = [];
  for (let i = 0; i < PHASH_SIZE; i++) {
    gray.push([]);
    for (let j = 0; j < PHASH_SIZE; j++) {
      const p = (i * PHASH_SIZE + j) * 4;
      gray[i].push(0.299*data[p] + 0.587*data[p+1] + 0.114*data[p+2]);
    }
  }
  const dctRows = gray.slice(0, DCT_SIZE).map(r => dct8(r.slice(0, DCT_SIZE)));
  const dctCols = [];
  for (let j = 0; j < DCT_SIZE; j++) dctCols.push(dct8(dctRows.map(r => r[j])));
  const vals = [];
  for (let i = 0; i < DCT_SIZE; i++)
    for (let j = 0; j < DCT_SIZE; j++)
      if (!(i===0 && j===0)) vals.push(dctCols[i][j]);
  const mean = vals.reduce((a,b) => a+b, 0) / vals.length;
  let hash = 0n;
  for (let i = 0; i < vals.length; i++) if (vals[i] >= mean) hash |= (1n << BigInt(i));
  return hash;
}
function computeColorHistogram(imgEl) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const H_BINS = 16, S_BINS = 8, V_BINS = 8;
  const hist = new Float32Array(H_BINS + S_BINS + V_BINS);
  const n = size * size;
  for (let i = 0; i < n; i++) {
    const r = data[i*4]/255, g = data[i*4+1]/255, b = data[i*4+2]/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    const v = max, s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g-b)/d + 6) % 6;
      else if (max === g) h = (b-r)/d + 2;
      else h = (r-g)/d + 4;
      h /= 6;
    }
    hist[Math.min(H_BINS-1, Math.floor(h * H_BINS))]++;
    hist[H_BINS + Math.min(S_BINS-1, Math.floor(s * S_BINS))]++;
    hist[H_BINS + S_BINS + Math.min(V_BINS-1, Math.floor(v * V_BINS))]++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return hist;
}
function hammingDistance(a, b) {
  let x = a ^ b, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}
function histogramDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}
function combinedDistance(hashA, hashB, histA, histB) {
  const maxHamming = DCT_SIZE * DCT_SIZE - 1;
  return Math.round((hammingDistance(hashA, hashB) / maxHamming * 0.6 + histogramDistance(histA, histB) * 0.4) * 100);
}

async function getPHashForItem(it, enqueueHeic) {
  const key = it.relPath;
  if (pHashCache.has(key) && histCache.has(key)) return pHashCache.get(key);
  let hash = pHashCache.get(key) ?? null;
  if (!hash) { const cached = await dbGetHash(key); if (cached !== null) hash = cached; }
  if (!histCache.has(key) || !hash) {
    const src = isHeicFile(it.file) ? await enqueueHeic(it.file) : it.file;
    const url = URL.createObjectURL(src);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    if (!hash) { hash = computePHash(img); dbSetHash(key, hash); }
    histCache.set(key, computeColorHistogram(img));
  }
  pHashCache.set(key, hash);
  return hash;
}

/* ── Análisis de imagen ──────────────────────────────────────────────────────── */
async function analyzeImage(file) {
  let ts = file.lastModified || Date.now();
  let hasGPS = false, pixW = 0, pixH = 0, model = null, lat = null, lng = null;

  if (isHeicFile(file)) return { ts, isLowQuality: false, model: null, hasGPS: null, hdLevel: null, lat: null, lng: null, pixW: 0, pixH: 0 };

  try {
    const exif = await exifr.parse(file, { tiff: true, exif: true, gps: true, interop: false, iptc: false, icc: false, thumbnail: false });
    if (exif) {
      const dt = exif.DateTimeOriginal || exif.CreateDate;
      if (dt instanceof Date && !isNaN(dt)) ts = dt.getTime();
      hasGPS = (exif.latitude != null) || (exif.GPSLatitude != null);
      if (hasGPS) { lat = exif.latitude ?? null; lng = exif.longitude ?? null; }
      pixW = exif.PixelXDimension || exif.ExifImageWidth  || exif.ImageWidth  || 0;
      pixH = exif.PixelYDimension || exif.ExifImageHeight || exif.ImageHeight || 0;
      const raw = (exif.Model || exif.Make || '').trim();
      if (raw) model = raw.replace(/^Apple\s*/i, '').slice(0, 18);
    }
  } catch (_) {}

  if (/\.png$/i.test(file.name) || file.type === 'image/png') { pixW = 0; pixH = 0; }
  if (!pixW || !pixH) {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      URL.revokeObjectURL(url); pixW = img.naturalWidth; pixH = img.naturalHeight;
    } catch (_) {}
  }

  const shorter = Math.min(pixW, pixH);
  const hdLevel = shorter >= 3900 ? '4k' : shorter >= 2900 ? '3k' : shorter >= 1900 ? '2k' : shorter >= 900 ? '1k' : 'sd';
  return { ts, isLowQuality: hdLevel === 'sd' || hdLevel === '1k', model, hasGPS, hdLevel, lat, lng, pixW, pixH };
}

async function scanDir(dirHandle, relPrefix = '', managed = null) {
  const entries = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory') {
      const lname = name.toLowerCase();
      const next = managed ?? (['trash','ideas','selected','low'].includes(lname) ? lname : null);
      entries.push(...await scanDir(h, relPrefix + name + '/', next));
    } else if (h.kind === 'file') {
      const file = await h.getFile();
      if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) continue;
      entries.push({ file, fileHandle: h, dirHandle, relPath: relPrefix + name, managed });
    }
  }
  return entries;
}

/* ── GPS edit ────────────────────────────────────────────────────────────────── */
let _gpsTarget = null;

function _toDMSRational(deg) {
  const d = Math.floor(deg), m = Math.floor((deg - d) * 60);
  const s = Math.round(((deg - d) * 60 - m) * 60 * 1e6);
  return [[d, 1], [m, 1], [s, 1000000]];
}
async function writeGpsToFile(it, lat, lng) {
  const ab = await it.file.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  let exifObj;
  try { exifObj = piexif.load(bin); } catch (_) { exifObj = {}; }
  exifObj.GPS = exifObj.GPS ?? {};
  exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
  exifObj.GPS[piexif.GPSIFD.GPSLatitude]     = _toDMSRational(Math.abs(lat));
  exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  exifObj.GPS[piexif.GPSIFD.GPSLongitude]    = _toDMSRational(Math.abs(lng));
  const newBin = piexif.insert(piexif.dump(exifObj), bin);
  const newU8 = Uint8Array.from({ length: newBin.length }, (_, i) => newBin.charCodeAt(i));
  const ws = await it.fileHandle.createWritable();
  await ws.write(new Blob([newU8], { type: 'image/jpeg' }));
  await ws.close();
  it.file = await it.fileHandle.getFile();
  it.size = it.file.size; it.hasGPS = true; it.lat = lat; it.lng = lng;
}

function exitGpsEditMode() {
  if (!_gpsTarget) return;
  _gpsTarget.fig.classList.remove('gps-editing');
  _gpsTarget.fig.querySelector('.gps-edit-panel')?.remove();
  _gpsTarget = null;
  document.querySelectorAll('.item.gps-copyable').forEach(el => el.classList.remove('gps-copyable'));
}

function enterGpsEditMode(it, fig, onFlagsChange) {
  exitGpsEditMode();
  _gpsTarget = { it, fig };
  fig.classList.add('gps-editing');

  const panel = document.createElement('div');
  panel.className = 'gps-edit-panel';
  panel.innerHTML =
    `<input class="gps-ei gps-ei-lat" type="number" step="any" min="-90" max="90" placeholder="Lat">` +
    `<input class="gps-ei gps-ei-lng" type="number" step="any" min="-180" max="180" placeholder="Lng">` +
    `<div class="gps-edit-btns">` +
    `<button class="gps-eo gps-eo-ok" title="Guardar (Enter)">✓ Guardar</button>` +
    `<button class="gps-eo gps-eo-x" title="Cancelar (Esc)">✕</button>` +
    `</div>`;
  fig.appendChild(panel);

  const latEl = panel.querySelector('.gps-ei-lat');
  const lngEl = panel.querySelector('.gps-ei-lng');
  if (it.lat != null) { latEl.value = it.lat; lngEl.value = it.lng; }
  latEl.focus(); latEl.select();

  const tryCommit = async () => {
    const la = parseFloat(latEl.value), lo = parseFloat(lngEl.value);
    if (!isFinite(la) || !isFinite(lo)) return;
    try {
      await writeGpsToFile(it, la, lo);
      exitGpsEditMode();
      onFlagsChange?.(fig, it);
    } catch (err) {
      const prog = document.getElementById('progress');
      if (prog) prog.textContent = `Error al escribir GPS: ${err.message ?? err}`;
    }
  };

  panel.querySelector('.gps-eo-ok').addEventListener('click', e => { e.stopPropagation(); tryCommit(); });
  panel.querySelector('.gps-eo-x').addEventListener('click',  e => { e.stopPropagation(); exitGpsEditMode(); });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.stopPropagation(); tryCommit(); }
    if (e.key === 'Escape') { e.stopPropagation(); exitGpsEditMode(); }
  });

  document.querySelectorAll('.item[data-gps-lat]').forEach(xFig => {
    if (xFig === fig) return;
    xFig.classList.add('gps-copyable');
  });
}

/* ── HEIC helpers ────────────────────────────────────────────────────────────── */
const HEIC_MAX_CONCURRENCY = 2;
let heicActive = 0;
const heicQueue = [];
function enqueueHeicConversion(file) {
  return new Promise((resolve, reject) => { heicQueue.push({ file, resolve, reject }); pumpHeicQueue(); });
}
async function pumpHeicQueue() {
  if (heicActive >= HEIC_MAX_CONCURRENCY || heicQueue.length === 0) return;
  const job = heicQueue.shift(); heicActive++;
  try { job.resolve(await window.heic2any({ blob: job.file, toType: 'image/jpeg', quality: 0.92 })); }
  catch (err) { job.reject(err); }
  finally { heicActive--; pumpHeicQueue(); }
}

/* ── Rotación JPEG ───────────────────────────────────────────────────────────── */
async function rotateJpeg90cw(it) {
  if (!it.fileHandle) throw new Error('Sin handle de escritura');
  const srcFile  = await it.fileHandle.getFile();
  const arrayBuf = await srcFile.arrayBuffer();
  const srcBytes = new Uint8Array(arrayBuf);
  const binStr   = srcBytes.reduce((s, b) => s + String.fromCharCode(b), '');
  let exifObj;
  try { exifObj = piexif.load(binStr); } catch (_) { exifObj = {}; }
  const blob = new Blob([srcBytes], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const img  = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  URL.revokeObjectURL(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalHeight; canvas.height = img.naturalWidth;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const rotatedBlob  = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
  const rotatedBuf   = await rotatedBlob.arrayBuffer();
  const rotatedBytes = new Uint8Array(rotatedBuf);
  if (exifObj) {
    if (exifObj['0th']) { exifObj['0th'][piexif.ImageIFD.Orientation] = 1; exifObj['0th'][piexif.ImageIFD.ImageWidth] = canvas.width; exifObj['0th'][piexif.ImageIFD.ImageLength] = canvas.height; }
    if (exifObj['Exif']) { exifObj['Exif'][piexif.ExifIFD.PixelXDimension] = canvas.width; exifObj['Exif'][piexif.ExifIFD.PixelYDimension] = canvas.height; }
    try {
      const exifBytes = piexif.dump(exifObj);
      const rotBin = rotatedBytes.reduce((s, b) => s + String.fromCharCode(b), '');
      const withExif = piexif.insert(exifBytes, rotBin);
      const finalBytes = new Uint8Array(withExif.length);
      for (let i = 0; i < withExif.length; i++) finalBytes[i] = withExif.charCodeAt(i);
      const ws = await it.fileHandle.createWritable(); await ws.write(finalBytes.buffer); await ws.close();
    } catch (_) { const ws = await it.fileHandle.createWritable(); await ws.write(rotatedBuf); await ws.close(); }
  } else { const ws = await it.fileHandle.createWritable(); await ws.write(rotatedBuf); await ws.close(); }
  const newFile = await it.fileHandle.getFile();
  it.file = newFile; it.size = newFile.size;
}

/* ── Helpers de carpetas ─────────────────────────────────────────────────────── */
async function ensureUniqueName(dirHandle, name) {
  const m = name.match(/^(.*?)(\.[^.]*)?$/), base = m?.[1] ?? name, ext = m?.[2] ?? '';
  let candidate = name, i = 1;
  while (true) {
    try { await dirHandle.getFileHandle(candidate, { create: false }); candidate = `${base} (${i++})${ext}`; }
    catch { return candidate; }
  }
}
async function moveOne(it, targetDir) {
  const dstName = await ensureUniqueName(targetDir, it.name);
  if (typeof it.fileHandle?.move === 'function') {
    await it.fileHandle.move(targetDir, dstName);
  } else {
    const sf = await it.fileHandle.getFile();
    const dh = await targetDir.getFileHandle(dstName, { create: true });
    const ws = await dh.createWritable();
    await ws.write(await sf.arrayBuffer());
    await ws.close();
    await it.dirHandle.removeEntry(it.name);
  }
  return dstName;
}

/* ── Export ──────────────────────────────────────────────────────────────────── */
function createLocalBackend() {
  let rootDirHandle = null;
  const heicListURLCache    = new Map();
  const heicOverlayURLCache = new Map();
  const activeListURLs      = new Set();
  const activeOverlayURLs   = new Set();

  // GPS click capture — set up once
  document.addEventListener('click', e => {
    if (!_gpsTarget) return;
    const copyable = e.target.closest('.item.gps-copyable');
    if (copyable) {
      e.stopPropagation(); e.preventDefault();
      const la = parseFloat(copyable.dataset.gpsLat);
      const lo = parseFloat(copyable.dataset.gpsLng);
      if (isFinite(la) && isFinite(lo)) {
        const { it, fig } = _gpsTarget;
        writeGpsToFile(it, la, lo).then(() => {
          exitGpsEditMode();
          // rebuild meta-flags on that fig
          backend.buildMetaFlagsExtra?.(fig, it);
        }).catch(err => {
          const prog = document.getElementById('progress');
          if (prog) prog.textContent = `Error al escribir GPS: ${err.message}`;
        });
      }
      return;
    }
    if (!e.target.closest('.item.gps-editing')) exitGpsEditMode();
  }, true);

  // self-reference used in GPS handlers
  const backend = {
    pickDirLabel: '📁 Abrir carpeta',
    autoLoad: false,

    keyFor(it) { return it.relPath; },

    getDisplayURL(it, level) {
      const key = it.relPath;
      const cache = level === 'overlay' ? heicOverlayURLCache : heicListURLCache;
      const urlSet = level === 'overlay' ? activeOverlayURLs : activeListURLs;
      if (!isHeicFile(it.file)) {
        const url = URL.createObjectURL(it.file);
        urlSet.add(url); return Promise.resolve(url);
      }
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      return enqueueHeicConversion(it.file).then(blob => {
        const url = URL.createObjectURL(blob);
        cache.set(key, url); urlSet.add(url); return url;
      });
    },

    async load(onProgress) {
      if (!('showDirectoryPicker' in window)) { alert('Tu navegador no soporta abrir carpetas.'); return { items: null, scanning: false }; }
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      rootDirHandle = dir;
      return _doScan(onProgress);
    },

    async rescan(onProgress) {
      if (!rootDirHandle) return backend.load(onProgress);
      return _doScan(onProgress);
    },

    hasWriteSupport() { return !!rootDirHandle; },
    persistMark(_key, _mark) {},
    persistMarkBatch(_marks) {},

    async moveFiles(movable, folderName) {
      const targetDir = await rootDirHandle.getDirectoryHandle(folderName, { create: true });
      const results = [], errors = [];
      for (const it of movable) {
        try {
          const oldRelPath = it.relPath;
          const dstName = await moveOne(it, targetDir);
          const dh = await targetDir.getFileHandle(dstName, { create: false });
          const df = await dh.getFile();
          // mutate internal fields — core.js will update relPath/name/managed after
          it.file = df; it.fileHandle = dh; it.dirHandle = targetDir;
          results.push({ from: oldRelPath, to: `${folderName}/${dstName}` });
        } catch (err) {
          errors.push({ relPath: it.relPath, error: err.message });
        }
      }
      return { results, errors };
    },

    async rotateFile(it) {
      if (!isJpeg(it)) throw new Error('Solo se pueden rotar archivos JPEG');
      // Invalidate HEIC caches (not applicable to JPEG but harmless)
      const key = it.relPath;
      const lu = heicListURLCache.get(key); if (lu) { URL.revokeObjectURL(lu); heicListURLCache.delete(key); }
      const ou = heicOverlayURLCache.get(key); if (ou) { URL.revokeObjectURL(ou); heicOverlayURLCache.delete(key); }
      // Also clear pHash cache since image changed
      pHashCache.delete(key); histCache.delete(key);
      await rotateJpeg90cw(it);
      return ''; // new blob URL is always different since it.file changed
    },

    async findSimilar(srcItem, allItems) {
      const srcKey = srcItem.relPath;
      let srcHash;
      try { srcHash = await getPHashForItem(srcItem, enqueueHeicConversion); }
      catch { return []; }
      const srcHist = histCache.get(srcKey) ?? new Float32Array(32);
      const results = [];
      for (const it of allItems) {
        if (it.relPath === srcKey) continue;
        try {
          const h = await getPHashForItem(it, enqueueHeicConversion);
          const hist = histCache.get(it.relPath) ?? new Float32Array(32);
          results.push({ relPath: it.relPath, dist: combinedDistance(srcHash, h, srcHist, hist) });
        } catch (_) {}
      }
      results.sort((a, b) => a.dist - b.dist);
      return results.slice(0, 5);
    },

    onItemsLoaded(items, onProgress) {
      (async () => {
        if (!phashDB) { try { await openPhashDB(); } catch (_) {} }
        let n = 0;
        for (const it of items) {
          try { await getPHashForItem(it, enqueueHeicConversion); n++; } catch (_) {}
          if (n % 50 === 0) onProgress?.(`Precalculando hashes… ${n} / ${items.length}`);
        }
        onProgress?.(`Listo: ${items.length} fotos · ${n} hashes calculados`);
      })();
    },

    releaseURLs(level) {
      if (level === 'list') {
        for (const u of activeListURLs) URL.revokeObjectURL(u);
        activeListURLs.clear();
        for (const u of heicListURLCache.values()) URL.revokeObjectURL(u);
        heicListURLCache.clear();
      } else if (level === 'overlay') {
        for (const u of activeOverlayURLs) URL.revokeObjectURL(u);
        activeOverlayURLs.clear();
        for (const u of heicOverlayURLCache.values()) URL.revokeObjectURL(u);
        heicOverlayURLCache.clear();
      }
    },

    buildMetaFlagsExtra(fig, it) {
      // GPS data attrs para que el modo copia los detecte por query DOM
      if (it.lat != null) { fig.dataset.gpsLat = it.lat; fig.dataset.gpsLng = it.lng; }
      else { delete fig.dataset.gpsLat; delete fig.dataset.gpsLng; }

      if (!isJpeg(it) || it.hdLevel === null) return;
      const gpsSeg = fig.querySelector('.mf-seg[data-ok]');
      if (!gpsSeg) return;
      gpsSeg.title = it.hasGPS ? 'GPS ✓ · clic para cambiar' : 'Sin GPS · clic para asignar';
      gpsSeg.dataset.clickable = 'true';
      gpsSeg.addEventListener('click', e => {
        e.stopPropagation();
        enterGpsEditMode(it, fig, (f, item) => {
          // Re-build meta-flags on the fig after GPS update
          backend.buildMetaFlagsExtra?.(f, item);
        });
      });
    },
  };

  return backend;

  /* ── Internal helpers ─────────────────────────────────────────────────────── */
  async function _doScan(onProgress) {
    const entries = await scanDir(rootDirHandle);
    onProgress?.(`Analizando calidad… 0 / ${entries.length}`);
    const items = [];
    let i = 0;
    for (const e of entries) {
      const { ts, isLowQuality, model, hasGPS, hdLevel, lat, lng, pixW, pixH } = await analyzeImage(e.file);
      items.push({
        relPath: e.relPath,
        name:    e.file.name,
        size:    e.file.size || 0,
        ts, managed: e.managed ?? null, model, hasGPS, hdLevel, lat, lng, pixW, pixH,
        mark: null,
        _extra: { file: e.file, fileHandle: e.fileHandle, dirHandle: e.dirHandle ?? rootDirHandle },
        _lowQuality: isLowQuality,
      });
      i++;
      if (i % 25 === 0 || i === entries.length) onProgress?.(`Analizando calidad… ${i} / ${entries.length}`);
    }
    return { items, scanning: false };
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * shared/core.js
 * ════════════════════════════════════════════════════════════════════════ */

function startApp(backend) {

/* ---------- DOM refs ---------- */
const groupsEl         = document.getElementById('groups');
const pickDirBtn       = document.getElementById('pickDir');
const rescanBtn        = document.getElementById('rescanBtn');
const toggleDarkBtn    = document.getElementById('toggleDark');
const toggleManagedBtn = document.getElementById('toggleManaged');
const toggleExpressBtn = document.getElementById('toggleExpress');
const moveBtn          = document.getElementById('moveTrash');
const moveIdeasBtn     = document.getElementById('moveIdeas');
const moveSelectedBtn  = document.getElementById('moveSelected');
const countStarEl      = document.getElementById('countStar');
const countIdeaEl      = document.getElementById('countIdea');
const countTrashEl     = document.getElementById('countTrash');
const countPendingEl   = document.getElementById('countPending');
const countTotalEl     = document.getElementById('countTotal');
const firstBtn         = document.getElementById('firstPage');
const prevBtn          = document.getElementById('prevPage');
const nextBtn          = document.getElementById('nextPage');
const lastBtn          = document.getElementById('lastPage');
const pageInput        = document.getElementById('pageInput');
const pageTotalSpan    = document.getElementById('pageTotal');
const progressEl       = document.getElementById('progress');
const overlay          = document.getElementById('bucketOverlay');
const overlayGrid      = document.getElementById('overlayGrid');
const overlayTitle     = document.getElementById('overlayTitle');
const overlayMeta      = document.getElementById('overlayMeta');
const overlayClose     = document.getElementById('closeOverlay');
const overlayPrev      = document.getElementById('overlayPrev');
const overlayNext      = document.getElementById('overlayNext');
const viewer           = document.getElementById('photoViewer');
const viewerImg        = document.getElementById('viewerImg');
const viewerBtnTrash   = document.getElementById('viewerTrash');
const viewerBtnStar    = document.getElementById('viewerStar');
const viewerBtnIdea    = document.getElementById('viewerIdea');
const groupTpl         = document.getElementById('groupTpl');
const itemTpl          = document.getElementById('itemTpl');
const dupesPanel       = document.getElementById('dupesPanel');
const dupesList        = document.getElementById('dupesList');
const dupesClose       = document.getElementById('dupesClose');
const moveLowBtn       = document.getElementById('moveLow');
const countLowEl       = document.getElementById('countLow');
const filterAllBtn     = document.getElementById('filterAll');
const filterNoGpsBtn   = document.getElementById('filterNoGps');
const filterLowResBtn  = document.getElementById('filterLowRes');
const countNoGpsEl     = document.getElementById('countNoGps');
const countLowResEl    = document.getElementById('countLowRes');
const viewerCaptionMain = document.getElementById('viewerCaptionMain');
const viewerFilenameEl  = document.getElementById('viewerFilename');
const viewerFolderEl    = document.getElementById('viewerFolder');
const viewerCopyPathBtn = document.getElementById('viewerCopyPath');
const viewerGps         = document.getElementById('viewerGps');
const viewerDimsEl      = document.getElementById('viewerDims');

/* ---------- Estado ---------- */
let allItems  = [];
let groups    = [];
let trashSet  = new Set();
let starSet   = new Set();
let ideaSet   = new Set();
let lowSet    = new Set();
let filterNoGps  = false;
let filterLowRes = false;
let currentPage = 1;
let currentMins = (() => { const t = parseInt(new URLSearchParams(location.search).get('t'), 10); return [2,5,10].includes(t) ? t : 5; })();
let expressMode = false;
const EXPRESS_MAX      = 8;
const BUCKETS_PER_PAGE = 3;
let itemByKey = new Map();
let listMode = 'bucket';
let selBucketAbsIndex = 0;
let selPhotoIndex = 0;
let currentOverlayIndex = null;
let overlaySelIdx = 0;
let lastOpenAbsIndex = null;
let overlayEdgeIntent = null;
let showManaged = new URLSearchParams(location.search).get('m') !== '0';

/* ---------- Utilidades ---------- */
function keyFor(it) { return backend.keyFor(it); }

function buildURL(g, p) {
  const params = new URLSearchParams();
  if (!showManaged) params.set('m', '0');
  if (currentMins !== 5) params.set('t', String(currentMins));
  if (document.documentElement.classList.contains('dark')) params.set('d', '1');
  if (g != null) params.set('g', String(g));
  if (p != null && p > 0) params.set('p', String(p));
  const qs = params.toString();
  return qs ? `?${qs}` : location.pathname;
}

/* Carga de imagen — soporta getDisplayURL síncrono o async */
function loadImg(img, it, level) {
  Promise.resolve(backend.getDisplayURL(it, level))
    .then(url  => { img.src = url; })
    .catch(()  => { img.removeAttribute('src'); img.alt = it.name + ' (sin preview)'; });
}

function visibleItemsForBucket(absIndex) {
  const g = groups[absIndex];
  if (!g) return [];
  let items = showManaged ? g.items : g.items.filter(it => !isManaged(it));
  if (filterNoGps || filterLowRes) {
    items = items.filter(it => {
      if (isManaged(it)) return false;
      const matchGps = filterNoGps  && it.hasGPS === false;
      const matchRes = filterLowRes && lowSet.has(keyFor(it));
      return matchGps || matchRes;
    });
  }
  return items;
}
function currentVisibleOverlayItems() {
  if (currentOverlayIndex === null) return [];
  return visibleItemsForBucket(currentOverlayIndex);
}
function filteredGroups() {
  if (!filterNoGps && !filterLowRes) return groups.map((g, i) => ({ g, absIndex: i }));
  return groups
    .map((g, i) => ({ g, absIndex: i }))
    .filter(({ absIndex }) => visibleItemsForBucket(absIndex).length > 0);
}

/* ---------- Contadores ---------- */
function computeCountsLocal() { return computeCountsFn(allItems, trashSet, starSet, ideaSet, lowSet); }
function updateCountersUI() {
  const { total, nStar, nTrash, nIdea, nPending, nLow, nNoGps } = computeCountsLocal();
  countTotalEl.textContent   = `Total: ${total}`;
  countPendingEl.textContent = `Pendientes: ${Math.max(0, nPending)}`;
  countStarEl.textContent    = nStar;
  countIdeaEl.textContent    = nIdea;
  countTrashEl.textContent   = nTrash;
  countLowEl.textContent     = nLow;
  if (countNoGpsEl)  countNoGpsEl.textContent  = nNoGps;
  if (countLowResEl) countLowResEl.textContent = nLow;
}
function updateFilterUI() {
  if (!filterAllBtn) return;
  filterAllBtn.classList.toggle('is-on',    !filterNoGps && !filterLowRes);
  filterNoGpsBtn.classList.toggle('is-on',  filterNoGps);
  filterLowResBtn.classList.toggle('is-on', filterLowRes);
}

/* ---------- Carga ---------- */
function populateFromData(photos) {
  resetState();
  ({ allItems, itemByKey, trashSet, starSet, ideaSet, lowSet } = populateItemsFn(photos, backend));
  buildGroupsLocal(); currentPage = 1; updatePagerState(); renderPage(currentPage);
  listMode = 'bucket'; selBucketAbsIndex = 0; selPhotoIndex = 0;
  updateListSelectionUI(); updateActionButtons(); updateCountersUI();
  backend.onItemsLoaded?.(allItems, msg => { progressEl.textContent = msg; });
  restoreFromURL();
}

async function doLoad() {
  progressEl.textContent = 'Cargando…';
  try {
    const { items, scanning } = await backend.load(
      msg      => { progressEl.textContent = msg; },
      newItems => {
        populateFromData(newItems);
        progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
      }
    );
    if (items) populateFromData(items);
    if (!scanning)
      progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
  } catch (err) {
    if (err.name !== 'AbortError')
      progressEl.textContent = `Error: ${err.message}`;
  }
}

async function doRescan() {
  progressEl.textContent = 'Re-escaneando…';
  try {
    const { items, scanning } = await backend.rescan(
      msg      => { progressEl.textContent = msg; },
      newItems => {
        populateFromData(newItems);
        progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
      }
    );
    if (items) populateFromData(items);
    if (!scanning)
      progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
  } catch (err) {
    progressEl.textContent = `Error: ${err.message}`;
  }
}

function resetState() {
  backend.releaseURLs?.('list'); backend.releaseURLs?.('overlay');
  allItems = []; groups = []; itemByKey.clear(); trashSet.clear(); starSet.clear(); ideaSet.clear(); lowSet.clear();
  filterNoGps = filterLowRes = false; updateFilterUI();
  currentPage = 1; listMode = 'bucket'; selBucketAbsIndex = 0; selPhotoIndex = 0;
  currentOverlayIndex = null; overlaySelIdx = 0; lastOpenAbsIndex = null; overlayEdgeIntent = null;
  moveBtn.disabled = true; moveIdeasBtn.disabled = true; moveSelectedBtn.disabled = true;
  groupsEl.textContent = ''; pageInput.disabled = true;
  firstBtn.disabled = prevBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
  hideOverlay(true); updateCountersUI();
}

function buildGroupsLocal() { groups = buildGroupsFn(allItems, showManaged, currentMins); }

/* ---------- Paginación ---------- */
function totalPages() { return Math.max(1, Math.ceil(filteredGroups().length / BUCKETS_PER_PAGE)); }
function updatePagerState() {
  const total = totalPages();
  pageTotalSpan.textContent = `/ ${total}`; pageInput.value = String(currentPage);
  pageInput.min = '1'; pageInput.max = String(total); pageInput.disabled = groups.length === 0;
  firstBtn.disabled = prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = lastBtn.disabled = currentPage >= total;
}
function goToPage(n) { currentPage = clamp(n, 1, totalPages()); updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateCountersUI(); }

/* ---------- Marcado ---------- */
function applyItemClasses(fig, it) {
  fig.classList.toggle('locked', isManaged(it));
  if (isManaged(it)) {
    fig.dataset.locked = it.managed === 'trash' ? 'TRASH' : it.managed === 'ideas' ? 'IDEAS' : it.managed === 'low' ? 'LOW' : 'SELECTED';
    fig.classList.remove('trashed','starred','idea'); return;
  }
  const key = keyFor(it);
  fig.classList.toggle('trashed', trashSet.has(key));
  fig.classList.toggle('starred', starSet.has(key));
  fig.classList.toggle('idea',    ideaSet.has(key));
}

function makeExclusive(toSet, o1, o2, key, markName) {
  if (toSet.has(key)) { toSet.delete(key); backend.persistMark(key, null); }
  else { toSet.add(key); o1.delete(key); o2.delete(key); backend.persistMark(key, markName); }
}
function toggleTrash(key, fig) { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(trashSet, starSet, ideaSet, key, 'trash'); applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }
function toggleStar(key, fig)  { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(starSet, trashSet, ideaSet, key, 'star');  applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }
function toggleIdea(key, fig)  { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(ideaSet, trashSet, starSet, key, 'idea');   applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }

/* ---------- Meta-flags ---------- */
function _modelHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return h % 360;
}
function buildMetaFlags(fig, it) {
  const container = fig.querySelector('.meta-flags');
  if (!container) return;
  container.innerHTML = '';
  if (it.hdLevel === null || it.hdLevel === undefined) return;

  const barEl = document.createElement('div');
  barEl.className = 'mf-bar';

  const gpsSeg = document.createElement('div');
  gpsSeg.className = 'mf-seg';
  gpsSeg.dataset.ok = it.hasGPS ? 'true' : 'false';
  gpsSeg.title = it.hasGPS ? 'GPS ✓' : 'Sin GPS';
  barEl.appendChild(gpsSeg);

  const resLabels = { '4k': '4K ✓', '3k': '3K ✓', '2k': '2K ✓', '1k': '1K ⚠', 'sd': 'SD · resolución muy baja' };
  const resSeg = document.createElement('div');
  resSeg.className = 'mf-seg';
  resSeg.dataset.res = it.hdLevel ?? 'sd';
  resSeg.title = resLabels[it.hdLevel] ?? (it.hdLevel || '').toUpperCase();
  barEl.appendChild(resSeg);
  container.appendChild(barEl);

  if (it.model) {
    const tag = document.createElement('div');
    tag.className = 'mf-model-tag';
    tag.style.setProperty('--mhue', _modelHue(it.model));
    tag.title = it.model;
    tag.textContent = it.model.length > 16 ? it.model.slice(0, 15) + '…' : it.model;
    container.appendChild(tag);
  }
  backend.buildMetaFlagsExtra?.(fig, it);
}

/* ---------- Rotación ---------- */
async function rotateSelected() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it  = vis[overlaySelIdx];
  if (!it || isManaged(it)) return;
  try {
    const bust = await backend.rotateFile(it);
    const fig = overlayGrid.children[overlaySelIdx];
    const img = fig?.querySelector('img');
    if (img) {
      Promise.resolve(backend.getDisplayURL(it, 'overlay'))
        .then(url => { img.src = url + bust; });
    }
    if (isViewerOpen()) {
      Promise.resolve(backend.getDisplayURL(it, 'overlay'))
        .then(url => { viewerImg.src = url + bust; });
    }
    progressEl.textContent = `Rotada: ${it.name}`;
  } catch (err) { progressEl.textContent = `Error al rotar: ${err.message}`; }
}

/* ---------- Similares ---------- */
async function findDuplicates(srcItem) {
  dupesPanel.hidden = false;
  dupesList.innerHTML = '';

  const srcHeader = document.createElement('div');
  srcHeader.className = 'dupe-src-header';
  const srcImg = document.createElement('img');
  srcImg.className = 'dupe-src-img';
  loadImg(srcImg, srcItem, 'list');
  const srcLabel = document.createElement('div');
  srcLabel.className = 'dupe-src-label';
  srcLabel.textContent = `Buscando similares a: ${srcItem.name}`;
  srcHeader.appendChild(srcImg); srcHeader.appendChild(srcLabel);
  dupesList.appendChild(srcHeader);

  const searching = document.createElement('div');
  searching.className = 'dupes-searching';
  searching.textContent = 'Calculando…';
  dupesList.appendChild(searching);

  try {
    const results = await backend.findSimilar(srcItem, allItems);
    searching.remove();
    progressEl.textContent = 'Búsqueda completada · mostrando las 5 fotos más parecidas';

    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'dupes-searching';
      empty.textContent = 'No hay otras fotos para comparar.';
      dupesList.appendChild(empty); return;
    }

    for (const { relPath, dist } of results) {
      const it = itemByKey.get(relPath);
      if (!it) continue;
      const similarity = dist === 0 ? 'Idéntica' : dist <= 5 ? 'Muy parecida' : dist <= 10 ? 'Parecida' : 'Lejana';
      const div = document.createElement('div');
      div.className = 'dupe-item ' + (dist === 0 ? 'dupe-dist-0' : dist <= 5 ? 'dupe-dist-low' : dist <= 10 ? 'dupe-dist-mid' : '');
      const img = document.createElement('img');
      loadImg(img, it, 'list');
      const info = document.createElement('div');
      info.className = 'dupe-info';
      info.innerHTML = `
        <span class="dupe-name" title="${it.name}">${it.name}</span>
        <span class="dupe-meta">${similarity} · distancia ${dist}</span>
        <span class="dupe-meta">${new Date(it.ts).toLocaleString()}</span>
      `;
      const btn = document.createElement('button');
      btn.className = 'dupe-goto'; btn.textContent = 'Ir →';
      btn.addEventListener('click', () => {
        dupesPanel.hidden = true;
        if (!overlay.hidden) { overlay.hidden = true; overlay.setAttribute('aria-hidden','true'); closeViewer(); currentOverlayIndex = null; }
        let bIdx = -1, vIdx = -1;
        for (let bi = 0; bi < groups.length; bi++) {
          const vis = visibleItemsForBucket(bi);
          const vi = vis.findIndex(x => keyFor(x) === relPath);
          if (vi >= 0) { bIdx = bi; vIdx = vi; break; }
        }
        if (bIdx < 0) { progressEl.textContent = 'No se encontró el bucket.'; return; }
        const tp = Math.floor(bIdx / BUCKETS_PER_PAGE) + 1;
        if (tp !== currentPage) goToPage(tp);
        openBucket(bIdx);
        if (vIdx >= 0) setOverlaySelected(vIdx);
      });
      div.appendChild(img); div.appendChild(info); div.appendChild(btn);
      dupesList.appendChild(div);
    }
  } catch (err) { searching.textContent = `Error: ${err.message}`; }
}

/* ---------- Render lista ---------- */
function renderPage(pageNum) {
  backend.releaseURLs?.('list');
  groupsEl.innerHTML = '';
  if (!groups.length) { groupsEl.innerHTML = '<p style="padding:16px;color:#666">No hay imágenes cargadas.</p>'; return; }
  const fg = filteredGroups();
  const startIdx = (pageNum - 1) * BUCKETS_PER_PAGE;
  fg.slice(startIdx, Math.min(startIdx + BUCKETS_PER_PAGE, fg.length)).forEach(({ g, absIndex }) => {
    const allVisible = visibleItemsForBucket(absIndex);
    const toRender   = expressMode && allVisible.length > EXPRESS_MAX ? allVisible.slice(0, EXPRESS_MAX) : allVisible;
    const remaining  = allVisible.length - toRender.length;

    const sectionFrag = groupTpl.content.cloneNode(true);
    const section = sectionFrag.querySelector('.group');
    section.dataset.absIndex = String(absIndex);
    section.querySelector('.gtitle').textContent = `${fmtSpan(g.startTs, g.endTs)} · ${allVisible.length} foto(s)`;
    const ghit = sectionFrag.querySelector('.ghit');
    ghit.addEventListener('click', () => openBucket(absIndex));
    ghit.addEventListener('keydown', ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); openBucket(absIndex); } });
    section.addEventListener('click', ev => { if (ev.target.closest('.ghit,.btn-trash,.btn-star,.btn-idea,figure.item')) return; listMode = 'bucket'; setSelectedBucket(absIndex); updateListSelectionUI(); });
    const grid = sectionFrag.querySelector('.grid');

    for (const it of toRender) {
      const node = itemTpl.content.cloneNode(true);
      const fig  = node.querySelector('.item');
      const img  = node.querySelector('img');
      const cap  = node.querySelector('.caption');
      const btnRotate = node.querySelector('.btn-rotate');
      const btnDupes  = node.querySelector('.btn-dupes');
      const btnTrash  = node.querySelector('.btn-trash');
      const btnStar   = node.querySelector('.btn-star');
      const btnIdea   = node.querySelector('.btn-idea');
      img.alt = it.name; cap.textContent = it.name;
      loadImg(img, it, 'list');
      applyItemClasses(fig, it);
      buildMetaFlags(fig, it);

      if (btnRotate) {
        if (!isManaged(it)) {
          btnRotate.addEventListener('click', async e => {
            e.stopPropagation();
            try {
              const bust = await backend.rotateFile(it);
              Promise.resolve(backend.getDisplayURL(it, 'list')).then(url => { img.src = url + bust; });
              progressEl.textContent = `Rotada: ${it.name}`;
            } catch (err) { progressEl.textContent = `Error al rotar: ${err.message}`; }
          });
        } else { btnRotate.style.display = 'none'; }
      }
      if (btnDupes) {
        if (!isManaged(it)) {
          btnDupes.addEventListener('click', async e => { e.stopPropagation(); await findDuplicates(it); });
        } else { btnDupes.style.display = 'none'; }
      }
      if (!isManaged(it)) {
        const key = keyFor(it);
        btnTrash.setAttribute('aria-pressed', trashSet.has(key) + '');
        btnStar .setAttribute('aria-pressed', starSet.has(key)  + '');
        btnIdea .setAttribute('aria-pressed', ideaSet.has(key)  + '');
        const sync = () => { btnTrash.setAttribute('aria-pressed', trashSet.has(key)+''); btnStar.setAttribute('aria-pressed', starSet.has(key)+''); btnIdea.setAttribute('aria-pressed', ideaSet.has(key)+''); };
        btnTrash.addEventListener('click', e => { e.stopPropagation(); toggleTrash(key, fig); sync(); });
        btnStar .addEventListener('click', e => { e.stopPropagation(); toggleStar(key, fig);  sync(); });
        btnIdea .addEventListener('click', e => { e.stopPropagation(); toggleIdea(key, fig);  sync(); });
      } else { btnRotate?.remove(); btnDupes?.remove(); btnTrash.remove(); btnStar.remove(); btnIdea.remove(); }
      grid.appendChild(node);
    }

    if (remaining > 0) {
      const more = document.createElement('div');
      more.className = 'item-more';
      more.innerHTML = `<span class="more-count">+${remaining}</span><span class="more-label">fotos más</span><span class="more-label">Abrir bucket para ver todas</span>`;
      more.addEventListener('click', () => openBucket(absIndex));
      grid.appendChild(more);
    }
    groupsEl.appendChild(sectionFrag);
  });
}

/* ---------- Selección en lista ---------- */
function ensureBucketVisible(absIndex) {
  const fg = filteredGroups();
  const fgIdx = fg.findIndex(({ absIndex: ai }) => ai === absIndex);
  const tp = fgIdx >= 0 ? Math.floor(fgIdx / BUCKETS_PER_PAGE) + 1 : currentPage;
  if (tp !== currentPage) goToPage(tp); else updateListSelectionUI();
}
function getBucketSection(absIndex) { return groupsEl.querySelector(`.group[data-abs-index="${absIndex}"]`); }
function getBucketGrid(absIndex) { const s = getBucketSection(absIndex); return s ? s.querySelector('.grid') : null; }
function setSelectedBucket(absIndex) { selBucketAbsIndex = clamp(absIndex, 0, groups.length - 1); ensureBucketVisible(selBucketAbsIndex); getBucketSection(selBucketAbsIndex)?.scrollIntoView({ block: 'nearest' }); }
function getGridCols(container) { const ch = Array.from(container?.children || []); if (ch.length <= 1) return 1; const top0 = ch[0].offsetTop; let cols = 0; for (const el of ch) { if (el.offsetTop !== top0) break; cols++; } return Math.max(1, cols); }
function setSelectedPhoto(newIdx) { const vis = visibleItemsForBucket(selBucketAbsIndex); if (!vis.length) return; selPhotoIndex = clamp(newIdx, 0, vis.length - 1); updateListSelectionUI(true); getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex]?.scrollIntoView({ block: 'nearest' }); }
function clearAllListSelections() { groupsEl.querySelectorAll('.group').forEach(s => { s.classList.remove('bucket-selected','photo-mode'); s.querySelectorAll('.item.selected').forEach(f => f.classList.remove('selected')); }); }
function updateListSelectionUI(onlyPhoto = false) {
  const sec = getBucketSection(selBucketAbsIndex);
  if (!onlyPhoto) clearAllListSelections();
  if (sec) {
    sec.classList.add('bucket-selected');
    if (listMode === 'photo') sec.classList.add('photo-mode');
    const grid = sec.querySelector('.grid');
    grid?.querySelectorAll('.item.selected').forEach(f => f.classList.remove('selected'));
    if (listMode === 'photo') { const vis = visibleItemsForBucket(selBucketAbsIndex); if (!vis.length) return; const fig = grid?.children[selPhotoIndex]; if (fig?.classList?.contains('item')) fig.classList.add('selected'); }
  }
}

/* ---------- Overlay ---------- */
function openBucket(index, { push = true } = {}) {
  currentOverlayIndex = clamp(index, 0, groups.length - 1); lastOpenAbsIndex = currentOverlayIndex;
  overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay();
  overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false');
  const url = buildURL(currentOverlayIndex);
  push ? history.pushState({ overlay: true, g: currentOverlayIndex }, '', url)
       : history.replaceState({ overlay: true, g: currentOverlayIndex }, '', url);
}
function _hideOverlayInternal(skipFocusReturn = false) {
  overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true');
  backend.releaseURLs?.('overlay');
  _closeViewerInternal();
  const returnIdx = currentOverlayIndex ?? lastOpenAbsIndex;
  if (!skipFocusReturn && returnIdx !== null) { listMode = 'bucket'; setSelectedBucket(returnIdx); }
  currentOverlayIndex = null; overlayEdgeIntent = null; updateCountersUI();
}
function hideOverlay(skipFocusReturn = false) {
  if (skipFocusReturn || overlay.hidden) { _hideOverlayInternal(skipFocusReturn); return; }
  history.back();
}
function getOverlayFig(idx) { return overlayGrid.children[idx] || null; }
function setOverlaySelected(newIdx) {
  const vis = currentVisibleOverlayItems(); if (!vis.length) return;
  const idx = clamp(newIdx, 0, vis.length - 1);
  getOverlayFig(overlaySelIdx)?.classList.remove('selected');
  overlaySelIdx = idx;
  const fig = getOverlayFig(overlaySelIdx);
  if (fig) { fig.classList.add('selected'); fig.scrollIntoView({ block: 'nearest' }); }
  overlayEdgeIntent = null;
  if (isViewerOpen()) {
    updateViewerImage();
    history.replaceState({ overlay: true, g: currentOverlayIndex, p: overlaySelIdx }, '', buildURL(currentOverlayIndex, overlaySelIdx));
  }
}
function syncOverlayAria(idx) {
  const figWrap = overlayGrid.children[idx]; if (!figWrap) return;
  const vis = currentVisibleOverlayItems(); const it = vis[idx]; if (!it || isManaged(it)) return;
  const key = keyFor(it);
  figWrap.querySelector('.btn-trash')?.setAttribute('aria-pressed', trashSet.has(key) + '');
  figWrap.querySelector('.btn-star')?.setAttribute('aria-pressed',  starSet.has(key)  + '');
  figWrap.querySelector('.btn-idea')?.setAttribute('aria-pressed',  ideaSet.has(key)  + '');
}
function renderOverlay() {
  backend.releaseURLs?.('overlay');
  overlayGrid.innerHTML = '';
  const g = groups[currentOverlayIndex]; const vis = currentVisibleOverlayItems();
  overlayTitle.textContent = `Bucket ${currentOverlayIndex + 1} de ${groups.length}`;
  overlayMeta.textContent  = `${fmtSpan(g.startTs, g.endTs)} · ${vis.length} foto(s)`;
  overlayPrev.disabled = currentOverlayIndex <= 0;
  overlayNext.disabled = currentOverlayIndex >= groups.length - 1;

  vis.forEach((it, idx) => {
    const node = itemTpl.content.cloneNode(true);
    const fig  = node.querySelector('.item');
    const img  = node.querySelector('img');
    const cap  = node.querySelector('.caption');
    const btnRotate = node.querySelector('.btn-rotate');
    const btnDupes  = node.querySelector('.btn-dupes');
    const btnTrash  = node.querySelector('.btn-trash');
    const btnStar   = node.querySelector('.btn-star');
    const btnIdea   = node.querySelector('.btn-idea');
    fig.tabIndex = -1; img.alt = it.name; cap.textContent = it.name;
    loadImg(img, it, 'overlay');
    applyItemClasses(fig, it);
    buildMetaFlags(fig, it);

    if (btnRotate) {
      if (!isManaged(it)) {
        btnRotate.addEventListener('click', async e => { e.stopPropagation(); setOverlaySelected(idx); await rotateSelected(); });
      } else { btnRotate.style.display = 'none'; }
    }
    if (btnDupes) {
      if (!isManaged(it)) {
        btnDupes.addEventListener('click', async e => { e.stopPropagation(); setOverlaySelected(idx); await findDuplicates(it); });
      } else { btnDupes.style.display = 'none'; }
    }
    if (!isManaged(it)) {
      const key = keyFor(it);
      btnTrash.setAttribute('aria-pressed', trashSet.has(key) + '');
      btnStar .setAttribute('aria-pressed', starSet.has(key)  + '');
      btnIdea .setAttribute('aria-pressed', ideaSet.has(key)  + '');
      fig.addEventListener('click', () => setOverlaySelected(idx));
      btnTrash.addEventListener('click', e => { e.stopPropagation(); toggleTrash(key, fig); syncOverlayAria(idx); updateViewerButtonsState(); });
      btnStar .addEventListener('click', e => { e.stopPropagation(); toggleStar(key, fig);  syncOverlayAria(idx); updateViewerButtonsState(); });
      btnIdea .addEventListener('click', e => { e.stopPropagation(); toggleIdea(key, fig);  syncOverlayAria(idx); updateViewerButtonsState(); });
    } else { btnRotate?.remove(); btnDupes?.remove(); btnTrash.remove(); btnStar.remove(); btnIdea.remove(); fig.addEventListener('click', () => setOverlaySelected(idx)); }
    overlayGrid.appendChild(node);
  });
  if (vis.length > 0) setOverlaySelected(Math.min(overlaySelIdx, vis.length - 1));
}

/* ---------- Viewer ---------- */
function isViewerOpen() { return !viewer.hidden; }
function openViewer() {
  const vis = currentVisibleOverlayItems();
  if (!vis[overlaySelIdx]) return;
  updateViewerImage(); viewer.hidden = false; viewer.setAttribute('aria-hidden', 'false'); updateViewerButtonsState();
  history.replaceState({ overlay: true, g: currentOverlayIndex, p: overlaySelIdx }, '', buildURL(currentOverlayIndex, overlaySelIdx));
}
function _closeViewerInternal() { viewer.hidden = true; viewer.setAttribute('aria-hidden', 'true'); }
function closeViewer() {
  if (!isViewerOpen()) return;
  _closeViewerInternal();
  if (currentOverlayIndex != null) history.replaceState({ overlay: true, g: currentOverlayIndex }, '', buildURL(currentOverlayIndex));
}
function updateViewerImage() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it) return;
  viewerImg.src = '';
  Promise.resolve(backend.getDisplayURL(it, 'overlay')).then(url => { viewerImg.src = url; });
  viewerFilenameEl.textContent = it.name;
  const folder = it.relPath.includes('/') ? '/' + it.relPath.split('/').slice(0, -1).join('/') : '';
  viewerFolderEl.textContent     = folder;
  viewerFolderEl.dataset.managed = it.managed ?? '';
  viewerCopyPathBtn.dataset.path = it.relPath;
  viewerCaptionMain.textContent  = `· ${overlaySelIdx + 1}/${vis.length}`;
  viewerGps.textContent = (it.lat != null && it.lng != null)
    ? `📍 ${it.lat.toFixed(6)},  ${it.lng.toFixed(6)}` : '';
  viewerDimsEl.textContent = (it.pixW && it.pixH) ? `${it.pixW} × ${it.pixH}` : '';
  updateViewerButtonsState();
}
function updateViewerButtonsState() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it) return;
  const key = keyFor(it);
  const isTrash = (it.managed === 'trash') || trashSet.has(key);
  const isStar  = starSet.has(key);
  const isIdea  = (it.managed === 'ideas') || ideaSet.has(key);
  const locked  = isManaged(it);
  viewerBtnTrash.setAttribute('aria-pressed', isTrash + ''); viewerBtnStar.setAttribute('aria-pressed', isStar + ''); viewerBtnIdea.setAttribute('aria-pressed', isIdea + '');
  viewerBtnTrash.disabled = viewerBtnStar.disabled = viewerBtnIdea.disabled = locked;
  viewerBtnTrash.style.display = viewerBtnStar.style.display = viewerBtnIdea.style.display = locked ? 'none' : '';
  viewer.classList.toggle('viewer-starred', isStar);
  viewer.classList.toggle('viewer-trashed', isTrash && !isStar);
  viewer.classList.toggle('viewer-idea',    isIdea && !isStar && !isTrash);
}

/* ---------- Mover archivos ---------- */
function hasWriteSupport() { return backend.hasWriteSupport(); }
function countMovable(set) {
  let n = 0;
  for (const k of set) { const it = itemByKey.get(k); if (it && !isManaged(it)) n++; }
  return n;
}
function updateActionButtons() {
  const ws = hasWriteSupport();
  moveBtn.disabled         = !ws || countMovable(trashSet) === 0;
  moveIdeasBtn.disabled    = !ws || countMovable(ideaSet)  === 0;
  moveSelectedBtn.disabled = !ws || countMovable(starSet)  === 0;
  moveLowBtn.disabled      = !ws || countMovable(lowSet)   === 0;
}

async function moveMarkedTo(folderName, set) {
  const movable = [];
  for (const k of set) { const it = itemByKey.get(k); if (it && !isManaged(it)) movable.push(it); }
  if (!movable.length) return;

  progressEl.textContent = `Moviendo ${movable.length} foto(s) a /${folderName}…`;
  try {
    const { results, errors } = await backend.moveFiles(movable, folderName);

    for (const { from, to: newRelPath } of results) {
      const it = itemByKey.get(from);
      if (!it) continue;
      itemByKey.delete(from);
      it.relPath = newRelPath;
      it.name    = newRelPath.split('/').pop();
      it.managed = folderName;
      itemByKey.set(newRelPath, it);
      set.delete(from);
      trashSet.delete(from); starSet.delete(from); ideaSet.delete(from); lowSet.delete(from);
    }

    buildGroupsLocal(); currentPage = Math.min(currentPage, totalPages());
    updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateActionButtons(); updateCountersUI();
    progressEl.textContent = `Listo: movidas ${results.length} foto(s) a /${folderName}` + (errors?.length ? ` · ${errors.length} error(es)` : '');
  } catch (err) {
    progressEl.textContent = `Error al mover: ${err.message}`;
  }
}

const moveMarkedToTrash    = () => moveMarkedTo('trash',    trashSet);
const moveMarkedToIdeas    = () => moveMarkedTo('ideas',    ideaSet);
const moveMarkedToSelected = () => moveMarkedTo('selected', starSet);
const moveMarkedToLow      = () => moveMarkedTo('low',      lowSet);

/* ---------- Eventos UI ---------- */
if (backend.pickDirLabel) pickDirBtn.textContent = backend.pickDirLabel;
pickDirBtn.addEventListener('click', doLoad);
rescanBtn?.addEventListener('click', doRescan);

toggleManagedBtn.addEventListener('click', () => {
  showManaged = !showManaged; toggleManagedBtn.classList.toggle('is-on', showManaged);
  buildGroupsLocal(); currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI();
  if (!overlay.hidden && currentOverlayIndex !== null) { const vis = currentVisibleOverlayItems(); overlaySelIdx = Math.min(overlaySelIdx, Math.max(0, vis.length - 1)); renderOverlay(); }
  history.replaceState(history.state ?? {}, '', buildURL(currentOverlayIndex));
});
toggleExpressBtn.addEventListener('click', () => {
  expressMode = !expressMode; toggleExpressBtn.classList.toggle('is-on', expressMode); renderPage(currentPage);
});
document.querySelectorAll('.btn-mins').forEach(btn => {
  btn.addEventListener('click', () => {
    const newMins = parseInt(btn.dataset.mins, 10); if (newMins === currentMins) return;
    currentMins = newMins; document.querySelectorAll('.btn-mins').forEach(b => b.classList.toggle('active', b === btn));
    buildGroupsLocal(); currentPage = Math.min(currentPage, totalPages());
    updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateActionButtons(); updateCountersUI();
    history.replaceState(history.state ?? {}, '', buildURL(currentOverlayIndex));
  });
});
moveBtn.addEventListener('click', moveMarkedToTrash);
moveIdeasBtn.addEventListener('click', moveMarkedToIdeas);
moveSelectedBtn.addEventListener('click', moveMarkedToSelected);
moveLowBtn.addEventListener('click', moveMarkedToLow);
filterAllBtn?.addEventListener('click', () => {
  filterNoGps = filterLowRes = false; updateFilterUI();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateCountersUI();
});
filterNoGpsBtn?.addEventListener('click', () => {
  filterNoGps = !filterNoGps; updateFilterUI();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateCountersUI();
});
filterLowResBtn?.addEventListener('click', () => {
  filterLowRes = !filterLowRes; updateFilterUI();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateCountersUI();
});
firstBtn.addEventListener('click', () => goToPage(1));
prevBtn .addEventListener('click', () => goToPage(currentPage - 1));
nextBtn .addEventListener('click', () => goToPage(currentPage + 1));
lastBtn .addEventListener('click', () => goToPage(totalPages()));
pageInput.addEventListener('change', () => { const n = parseInt(pageInput.value || '1', 10); goToPage(isNaN(n) ? 1 : n); });
dupesClose.addEventListener('click', () => { dupesPanel.hidden = true; dupesList.innerHTML = ''; });

/* ---------- Teclado ---------- */
function isOverlayOpen() { return !overlay.hidden; }
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (isViewerOpen()) { viewerKeydown(e); return; }
  if (isOverlayOpen()) { overlayKeydown(e); return; }
  const vis = visibleItemsForBucket(selBucketAbsIndex);
  switch (e.key) {
    case ' ': e.preventDefault(); openBucket(selBucketAbsIndex); break;
    case 'ArrowUp': e.preventDefault(); if (listMode === 'bucket') { const _fg = filteredGroups(); const _ci = _fg.findIndex(({ absIndex }) => absIndex === selBucketAbsIndex); if (_ci > 0) setSelectedBucket(_fg[_ci - 1].absIndex); else if (_ci < 0 && _fg.length > 0) setSelectedBucket(_fg[0].absIndex); } else { const cols = getGridCols(getBucketGrid(selBucketAbsIndex)); if (vis.length) setSelectedPhoto(selPhotoIndex - cols); } break;
    case 'ArrowDown': e.preventDefault(); if (listMode === 'bucket') { const _fg = filteredGroups(); const _ci = _fg.findIndex(({ absIndex }) => absIndex === selBucketAbsIndex); if (_ci >= 0 && _ci < _fg.length - 1) setSelectedBucket(_fg[_ci + 1].absIndex); else if (_ci < 0 && _fg.length > 0) setSelectedBucket(_fg[_fg.length - 1].absIndex); } else { const cols = getGridCols(getBucketGrid(selBucketAbsIndex)); if (vis.length) setSelectedPhoto(selPhotoIndex + cols); } break;
    case 'ArrowLeft': e.preventDefault(); if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); } else if (vis.length) setSelectedPhoto(selPhotoIndex - 1); break;
    case 'ArrowRight': e.preventDefault(); if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); } else if (vis.length) setSelectedPhoto(selPhotoIndex + 1); break;
    case 'Escape': if (listMode === 'photo') { e.preventDefault(); listMode = 'bucket'; updateListSelectionUI(); } break;
    case 'x': case 'X': if (listMode === 'photo' && vis.length) { e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break; const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex]; const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item'); if (node) { toggleTrash(keyFor(it), node); updateListSelectionUI(true); } } break;
    case 'z': case 'Z': if (listMode === 'photo' && vis.length) { e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break; const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex]; const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item'); if (node) { toggleStar(keyFor(it), node); updateListSelectionUI(true); } } break;
    case 'i': case 'I': if (listMode === 'photo' && vis.length) { e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break; const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex]; const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item'); if (node) { toggleIdea(keyFor(it), node); updateListSelectionUI(true); } } break;
    case 'r': case 'R': if (vis.length) { e.preventDefault(); const batch = []; vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!starSet.has(key)) { trashSet.add(key); starSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'trash' }); const fig = getBucketGrid(selBucketAbsIndex)?.children[idx]; const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item'); if (node) applyItemClasses(node, it); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); updateListSelectionUI(true); updateCountersUI(); } break;
    case 'p': case 'P': if (vis.length) { e.preventDefault(); const batch = []; vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) { starSet.add(key); trashSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'star' }); const fig = getBucketGrid(selBucketAbsIndex)?.children[idx]; const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item'); if (node) applyItemClasses(node, it); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); updateListSelectionUI(true); updateCountersUI(); } break;
  }
});

function overlayKeydown(e) {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems(); const total = vis.length; const cols = getGridCols(overlayGrid);
  switch (e.key) {
    case 'Escape': if (isViewerOpen()) closeViewer(); else hideOverlay(); break;
    case ' ': e.preventDefault(); isViewerOpen() ? closeViewer() : openViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;
    case 'ArrowDown': { e.preventDefault(); const next = overlaySelIdx + cols; if (next <= total - 1) setOverlaySelected(next); else if (overlaySelIdx !== total - 1) { setOverlaySelected(total - 1); overlayEdgeIntent = 'down'; } else if (overlayEdgeIntent === 'down' && currentOverlayIndex < groups.length - 1) { currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); } else overlayEdgeIntent = 'down'; break; }
    case 'ArrowUp': { e.preventDefault(); const prev = overlaySelIdx - cols; if (prev >= 0) setOverlaySelected(prev); else if (overlaySelIdx !== 0) { setOverlaySelected(0); overlayEdgeIntent = 'up'; } else if (overlayEdgeIntent === 'up' && currentOverlayIndex > 0) { currentOverlayIndex--; overlaySelIdx = Math.max(0, visibleItemsForBucket(currentOverlayIndex).length - 1); overlayEdgeIntent = null; renderOverlay(); } else overlayEdgeIntent = 'up'; break; }
    case 'x': case 'X': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; toggleTrash(keyFor(it), overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'z': case 'Z': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; toggleStar(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'i': case 'I': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; toggleIdea(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'r': case 'R': { e.preventDefault(); const batch = []; vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!starSet.has(key)) { trashSet.add(key); starSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'trash' }); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); overlayEdgeIntent = null; updateViewerButtonsState(); updateCountersUI(); break; }
    case 'p': case 'P': { e.preventDefault(); const batch = []; vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) { starSet.add(key); trashSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'star' }); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); overlayEdgeIntent = null; updateViewerButtonsState(); updateCountersUI(); break; }
    case 'j': case 'J': { e.preventDefault(); rotateSelected(); break; }
  }
}

function viewerKeydown(e) {
  if (!isViewerOpen() || currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; const locked = it ? isManaged(it) : true;
  switch (e.key) {
    case ' ': case 'Escape': e.preventDefault(); closeViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;
    case 'x': case 'X': if (!locked && it) { e.preventDefault(); toggleTrash(keyFor(it), overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'z': case 'Z': if (!locked && it) { e.preventDefault(); toggleStar(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'i': case 'I': if (!locked && it) { e.preventDefault(); toggleIdea(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); } break;
    case 'r': case 'R': if (!locked && vis.length) { e.preventDefault(); const batch = []; vis.forEach((it2, idx) => { if (isManaged(it2)) return; const key = keyFor(it2); if (!starSet.has(key)) { trashSet.add(key); starSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'trash' }); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it2); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'p': case 'P': if (!locked && vis.length) { e.preventDefault(); const batch = []; vis.forEach((it2, idx) => { if (isManaged(it2)) return; const key = keyFor(it2); if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) { starSet.add(key); trashSet.delete(key); ideaSet.delete(key); batch.push({ key, mark: 'star' }); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it2); } }); if (batch.length) backend.persistMarkBatch(batch); updateActionButtons(); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'j': case 'J': e.preventDefault(); rotateSelected(); break;
  }
}

/* ---------- Botones overlay y viewer ---------- */
overlayClose.addEventListener('click', () => hideOverlay());
overlayPrev.addEventListener('click', () => { if (currentOverlayIndex > 0) { currentOverlayIndex--; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); history.replaceState({ overlay: true, g: currentOverlayIndex }, '', buildURL(currentOverlayIndex)); } });
overlayNext.addEventListener('click', () => { if (currentOverlayIndex < groups.length - 1) { currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); history.replaceState({ overlay: true, g: currentOverlayIndex }, '', buildURL(currentOverlayIndex)); } });

viewerBtnTrash.addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleTrash(keyFor(it), overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); });
viewerBtnStar .addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleStar(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); });
viewerBtnIdea .addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleIdea(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); });
viewerCopyPathBtn?.addEventListener('click', async e => {
  e.stopPropagation();
  const p = viewerCopyPathBtn.dataset.path || '';
  if (!p) return;
  try { await navigator.clipboard.writeText(p); const o = viewerCopyPathBtn.textContent; viewerCopyPathBtn.textContent = '✓'; setTimeout(() => { viewerCopyPathBtn.textContent = o; }, 1500); }
  catch (_) { progressEl.textContent = `Ruta: ${p}`; }
});

/* ---------- URL state restore ---------- */
let _urlRestored = false;
function restoreFromURL() {
  if (_urlRestored) return;
  _urlRestored = true;
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('g'), 10);
  const p = parseInt(params.get('p'), 10);
  if (Number.isFinite(g) && g >= 0 && g < groups.length) {
    const tp = Math.floor(g / BUCKETS_PER_PAGE) + 1;
    if (tp !== currentPage) goToPage(tp);
    openBucket(g, { push: false });
    if (Number.isFinite(p) && p >= 0 && p < currentVisibleOverlayItems().length) {
      setOverlaySelected(p);
      openViewer();
    }
  }
}

window.addEventListener('popstate', () => { if (!overlay.hidden) _hideOverlayInternal(); });

/* ---------- Inicial ---------- */
renderPage(currentPage); updateListSelectionUI(); updateActionButtons(); updateCountersUI(); updateFilterUI();
toggleManagedBtn.classList.toggle('is-on', showManaged);
toggleExpressBtn.classList.toggle('is-on', expressMode);
document.querySelectorAll('.btn-mins').forEach(b => b.classList.toggle('active', parseInt(b.dataset.mins, 10) === currentMins));

(function () {
  const urlD = new URLSearchParams(location.search).get('d');
  if (urlD === '1') document.documentElement.classList.add('dark');
  const isDark = document.documentElement.classList.contains('dark');
  if (isDark) { toggleDarkBtn.classList.add('is-on'); toggleDarkBtn.textContent = '☀️ Claro'; }
  toggleDarkBtn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    toggleDarkBtn.classList.toggle('is-on', dark);
    toggleDarkBtn.textContent = dark ? '☀️ Claro' : '🌙 Oscuro';
    localStorage.setItem('darkMode', dark ? '1' : '0');
    history.replaceState(history.state ?? {}, '', buildURL(currentOverlayIndex));
  });
})();

if (backend.autoLoad) doLoad();

} // end startApp

/* ════════════════════════════════════════════════════════════════════════
 * APP/main.js
 * ════════════════════════════════════════════════════════════════════════ */

startApp(createLocalBackend());
