/* ---------- DOM refs ---------- */
const groupsEl       = document.getElementById('groups');
const pickDirBtn     = document.getElementById('pickDir');
const toggleManagedBtn = document.getElementById('toggleManaged');
const moveBtn        = document.getElementById('moveTrash');
const moveIdeasBtn   = document.getElementById('moveIdeas');
const moveSelectedBtn= document.getElementById('moveSelected');
// Contadores en botones
const countStarEl    = document.getElementById('countStar');
const countIdeaEl    = document.getElementById('countIdea');
const countTrashEl   = document.getElementById('countTrash');
// Contadores en barra
const countPendingEl = document.getElementById('countPending');
const countTotalEl   = document.getElementById('countTotal');
// Pager
const firstBtn      = document.getElementById('firstPage');
const prevBtn       = document.getElementById('prevPage');
const nextBtn       = document.getElementById('nextPage');
const lastBtn       = document.getElementById('lastPage');
const pageInput     = document.getElementById('pageInput');
const pageTotalSpan = document.getElementById('pageTotal');
const progressEl    = document.getElementById('progress');
// Overlay
const overlay      = document.getElementById('bucketOverlay');
const overlayGrid  = document.getElementById('overlayGrid');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMeta  = document.getElementById('overlayMeta');
const overlayClose = document.getElementById('closeOverlay');
const overlayPrev  = document.getElementById('overlayPrev');
const overlayNext  = document.getElementById('overlayNext');
// Viewer
const viewer        = document.getElementById('photoViewer');
const viewerImg     = document.getElementById('viewerImg');
const viewerCaption = document.getElementById('viewerCaption');
const viewerBtnTrash= document.getElementById('viewerTrash');
const viewerBtnStar = document.getElementById('viewerStar');
const viewerBtnIdea = document.getElementById('viewerIdea');

const groupTpl = document.getElementById('groupTpl');
const itemTpl  = document.getElementById('itemTpl');

/* ---------- Estado ---------- */
let allItems  = [];
let groups    = [];
let trashSet  = new Set();
let starSet   = new Set();
let ideaSet   = new Set();
let currentPage = 1;
let currentMins = 5;
const BUCKETS_PER_PAGE = 3;

let rootDirHandle = null;
let itemByKey = new Map();

let activeListURLs    = new Set();
let activeOverlayURLs = new Set();

let listMode = 'bucket';
let selBucketAbsIndex = 0;
let selPhotoIndex = 0;

let currentOverlayIndex = null;
let overlaySelIdx = 0;
let lastOpenAbsIndex = null;
let overlayEdgeIntent = null;

let showManaged = true;

/* ---------- Utilidades ---------- */
function msPerBucket() { return currentMins * 60 * 1000; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmtSpan(startMs, endMs) {
  const start = new Date(startMs), end = new Date(endMs);
  const sameDay = start.toDateString() === end.toDateString();
  const d = start.toLocaleDateString();
  const s = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const e = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `${d} · ${s} – ${e}` : `${start.toLocaleString()} – ${end.toLocaleString()}`;
}
function keyFor(it) { return `${it.name}|${it.size}|${it.ts}`; }
function isManaged(it) { return it?.managed === 'trash' || it?.managed === 'ideas' || it?.managed === 'selected'; }
function visibleItemsForBucket(absIndex) {
  const g = groups[absIndex];
  if (!g) return [];
  return showManaged ? g.items : g.items.filter(it => !isManaged(it));
}
function currentVisibleOverlayItems() {
  if (currentOverlayIndex === null) return [];
  return visibleItemsForBucket(currentOverlayIndex);
}

/* ---------- HEIC helpers ---------- */
function isHeicName(name = '') { return /\.(heic|heif)$/i.test(name); }
function isHeicFile(f) { return (f?.type && /image\/hei[cf]/i.test(f.type)) || isHeicName(f?.name); }

const heicListURLCache    = new Map();
const heicOverlayURLCache = new Map();
const HEIC_MAX_CONCURRENCY = 2;
let heicActive = 0;
const heicQueue = [];

function enqueueHeicConversion(file) {
  return new Promise((resolve, reject) => {
    heicQueue.push({ file, resolve, reject });
    pumpHeicQueue();
  });
}
async function pumpHeicQueue() {
  if (heicActive >= HEIC_MAX_CONCURRENCY || heicQueue.length === 0) return;
  const job = heicQueue.shift();
  heicActive++;
  try {
    const outBlob = await window.heic2any({ blob: job.file, toType: 'image/jpeg', quality: 0.92 });
    job.resolve(outBlob);
  } catch (err) {
    job.reject(err);
  } finally {
    heicActive--;
    pumpHeicQueue();
  }
}
async function getDisplayURL(it, level) {
  const key = keyFor(it);
  const cache = (level === 'overlay') ? heicOverlayURLCache : heicListURLCache;
  if (!isHeicFile(it.file)) {
    const url = URL.createObjectURL(it.file);
    (level === 'overlay' ? activeOverlayURLs : activeListURLs).add(url);
    return url;
  }
  if (cache.has(key)) return cache.get(key);
  const blob = await enqueueHeicConversion(it.file);
  const url = URL.createObjectURL(blob);
  cache.set(key, url);
  (level === 'overlay' ? activeOverlayURLs : activeListURLs).add(url);
  return url;
}

/* ---------- Contadores ---------- */
function computeCounts() {
  const total  = allItems.length;
  const nStar  = starSet.size;
  const nTrash = trashSet.size;
  const nIdea  = ideaSet.size;
  let managedTrash = 0, managedIdeas = 0;
  for (const it of allItems) {
    if (it.managed === 'trash') managedTrash++;
    else if (it.managed === 'ideas') managedIdeas++;
  }
  const nPending = total - (managedTrash + managedIdeas) - nStar - nTrash - nIdea;
  return { total, nStar, nTrash, nIdea, nPending };
}
function updateCountersUI() {
  const { total, nStar, nTrash, nIdea, nPending } = computeCounts();
  countTotalEl.textContent   = `Total: ${total}`;
  countPendingEl.textContent = `Pendientes: ${Math.max(0, nPending)}`;
  countStarEl.textContent    = nStar;
  countIdeaEl.textContent    = nIdea;
  countTrashEl.textContent   = nTrash;
}

/* ---------- Carga ---------- */
async function getTimestamp(file) {
  try {
    const exif = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const dt = exif?.DateTimeOriginal || exif?.CreateDate;
    if (dt instanceof Date && !isNaN(dt)) return dt.getTime();
  } catch (_) {}
  return file.lastModified || Date.now();
}

async function scanDir(dirHandle, relPrefix = '', managed = null) {
  const entries = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory') {
      const lname = name.toLowerCase();
      const nextManaged = managed ?? (lname === 'trash' ? 'trash' : lname === 'ideas' ? 'ideas' : lname === 'selected' ? 'selected' : null);
      const sub = await scanDir(h, relPrefix + name + '/', nextManaged);
      entries.push(...sub);
    } else if (h.kind === 'file') {
      const file = await h.getFile();
      if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) continue;
      entries.push({ file, fileHandle: h, dirHandle, relPath: relPrefix + name, managed });
    }
  }
  return entries;
}

async function loadFromDirectory() {
  if (!('showDirectoryPicker' in window)) { alert('Tu navegador no soporta abrir carpetas.'); return; }
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  rootDirHandle = dir;
  const entries = await scanDir(dir);
  await loadEntriesWithHandles(entries);
}

async function loadEntriesWithHandles(entries) {
  resetState(false);
  progressEl.textContent = `Leyendo metadatos… 0 / ${entries.length}`;
  let i = 0;
  for (const e of entries) {
    const ts = await getTimestamp(e.file);
    const item = {
      file: e.file, name: e.file.name, size: e.file.size || 0, ts,
      fileHandle: e.fileHandle, dirHandle: e.dirHandle ?? rootDirHandle,
      relPath: e.relPath, managed: e.managed ?? null
    };
    allItems.push(item);
    itemByKey.set(keyFor(item), item);
    i++;
    if (i % 25 === 0 || i === entries.length)
      progressEl.textContent = `Leyendo metadatos… ${i} / ${entries.length}`;
  }
  buildGroups(); currentPage = 1; updatePagerState(); renderPage(currentPage);
  progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
  listMode = 'bucket'; selBucketAbsIndex = 0; selPhotoIndex = 0;
  updateListSelectionUI(); updateActionButtons(); updateCountersUI();
}

function resetState(clearRoot = true) {
  revokeListURLs(); revokeOverlayURLs();
  allItems = []; groups = []; itemByKey.clear(); trashSet.clear(); starSet.clear(); ideaSet.clear();
  currentPage = 1;
  listMode = 'bucket'; selBucketAbsIndex = 0; selPhotoIndex = 0;
  currentOverlayIndex = null; overlaySelIdx = 0; lastOpenAbsIndex = null; overlayEdgeIntent = null;
  moveBtn.disabled = true; moveIdeasBtn.disabled = true; moveSelectedBtn.disabled = true;
  if (clearRoot) rootDirHandle = null;
  groupsEl.textContent = '';
  pageInput.disabled = true;
  firstBtn.disabled = prevBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
  hideOverlay(true);
  updateCountersUI();
}

function buildGroups() {
  const source = showManaged ? allItems : allItems.filter(it => !isManaged(it));
  const sorted = [...source].sort((a, b) => a.ts - b.ts);
  const win = msPerBucket();
  groups = [];
  if (sorted.length === 0) return;
  let start = sorted[0].ts, end = sorted[0].ts, prev = sorted[0].ts, items = [sorted[0]];
  for (let idx = 1; idx < sorted.length; idx++) {
    const it = sorted[idx];
    if (it.ts - prev <= win) { items.push(it); prev = it.ts; end = it.ts; }
    else { groups.push({ startTs: start, endTs: end, items }); start = end = prev = it.ts; items = [it]; }
  }
  groups.push({ startTs: start, endTs: end, items });
}

/* ---------- Paginación ---------- */
function totalPages() { return Math.max(1, Math.ceil(groups.length / BUCKETS_PER_PAGE)); }
function updatePagerState() {
  const total = totalPages();
  pageTotalSpan.textContent = `/ ${total}`;
  pageInput.value = String(currentPage);
  pageInput.min = '1'; pageInput.max = String(total);
  pageInput.disabled = (groups.length === 0);
  firstBtn.disabled = prevBtn.disabled = (currentPage <= 1);
  nextBtn.disabled = lastBtn.disabled = (currentPage >= total);
}
function goToPage(n) {
  currentPage = clamp(n, 1, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI(); updateCountersUI();
}
function revokeListURLs() {
  for (const url of activeListURLs) URL.revokeObjectURL(url);
  activeListURLs.clear();
  for (const url of heicListURLCache.values()) URL.revokeObjectURL(url);
  heicListURLCache.clear();
}
function revokeOverlayURLs() {
  for (const url of activeOverlayURLs) URL.revokeObjectURL(url);
  activeOverlayURLs.clear();
  for (const url of heicOverlayURLCache.values()) URL.revokeObjectURL(url);
  heicOverlayURLCache.clear();
}

/* ---------- Render lista ---------- */
function applyItemClasses(fig, it) {
  fig.classList.toggle('locked', isManaged(it));
  if (isManaged(it)) {
    fig.dataset.locked = (it.managed === 'trash' ? 'TRASH' : it.managed === 'ideas' ? 'IDEAS' : 'SELECTED');
    fig.classList.remove('trashed', 'starred', 'idea');
    return;
  }
  const key = keyFor(it);
  fig.classList.toggle('trashed', trashSet.has(key));
  fig.classList.toggle('starred', starSet.has(key));
  fig.classList.toggle('idea',    ideaSet.has(key));
}

function makeExclusive(toSet, o1, o2, key) {
  if (toSet.has(key)) toSet.delete(key);
  else { toSet.add(key); o1.delete(key); o2.delete(key); }
}
function toggleTrash(key, fig) { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(trashSet, starSet, ideaSet, key); applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }
function toggleStar(key, fig)  { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(starSet, trashSet, ideaSet, key);  applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }
function toggleIdea(key, fig)  { const it = itemByKey.get(key); if (isManaged(it)) return; makeExclusive(ideaSet, trashSet, starSet, key);   applyItemClasses(fig, it); updateActionButtons(); updateCountersUI(); }

function renderPage(pageNum) {
  revokeListURLs();
  groupsEl.innerHTML = '';
  if (groups.length === 0) { groupsEl.innerHTML = '<p style="padding:16px;color:#666">No hay imágenes cargadas.</p>'; return; }
  const startIdx = (pageNum - 1) * BUCKETS_PER_PAGE;
  const slice = groups.slice(startIdx, Math.min(startIdx + BUCKETS_PER_PAGE, groups.length));

  slice.forEach((g, iLocal) => {
    const absIndex = startIdx + iLocal;
    const itemsToShow = visibleItemsForBucket(absIndex);
    const sectionFrag = groupTpl.content.cloneNode(true);
    const section = sectionFrag.querySelector('.group');
    section.dataset.absIndex = String(absIndex);
    section.querySelector('.gtitle').textContent = `${fmtSpan(g.startTs, g.endTs)} · ${itemsToShow.length} foto(s)`;

    const ghit = sectionFrag.querySelector('.ghit');
    ghit.addEventListener('click', () => openBucket(absIndex));
    ghit.addEventListener('keydown', ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); openBucket(absIndex); } });
    section.addEventListener('click', ev => {
      if (ev.target.closest('.ghit, .btn-trash, .btn-star, .btn-idea, figure.item')) return;
      listMode = 'bucket'; setSelectedBucket(absIndex); updateListSelectionUI();
    });

    const grid = sectionFrag.querySelector('.grid');
    for (const it of itemsToShow) {
      const node = itemTpl.content.cloneNode(true);
      const fig = node.querySelector('.item');
      const img = node.querySelector('img');
      const cap = node.querySelector('.caption');
      const btnTrash  = node.querySelector('.btn-trash');
      const btnStar   = node.querySelector('.btn-star');
      const btnIdea   = node.querySelector('.btn-idea');
      const btnRotate = node.querySelector('.btn-rotate');
      img.alt = it.name; cap.textContent = it.name;
      getDisplayURL(it, 'list').then(url => { img.src = url; }).catch(() => { img.alt = it.name + ' (sin preview)'; });
      applyItemClasses(fig, it);
      // Rotar solo visible en overlay, ocultar en lista
      if (btnRotate) btnRotate.style.display = 'none';
      if (!isManaged(it)) {
        const key = keyFor(it);
        btnTrash.setAttribute('aria-pressed', trashSet.has(key) + '');
        btnStar .setAttribute('aria-pressed', starSet.has(key)  + '');
        btnIdea .setAttribute('aria-pressed', ideaSet.has(key)  + '');
        const sync = () => {
          btnTrash.setAttribute('aria-pressed', trashSet.has(key) + '');
          btnStar .setAttribute('aria-pressed', starSet.has(key)  + '');
          btnIdea .setAttribute('aria-pressed', ideaSet.has(key)  + '');
        };
        btnTrash.addEventListener('click', e => { e.stopPropagation(); toggleTrash(key, fig); sync(); });
        btnStar .addEventListener('click', e => { e.stopPropagation(); toggleStar(key, fig);  sync(); });
        btnIdea .addEventListener('click', e => { e.stopPropagation(); toggleIdea(key, fig);  sync(); });
      } else { btnTrash.remove(); btnStar.remove(); btnIdea.remove(); }
      grid.appendChild(node);
    }
    groupsEl.appendChild(sectionFrag);
  });
}

/* ---------- Selección en lista ---------- */
function ensureBucketVisible(absIndex) {
  const targetPage = Math.floor(absIndex / BUCKETS_PER_PAGE) + 1;
  if (targetPage !== currentPage) goToPage(targetPage); else updateListSelectionUI();
}
function getBucketSection(absIndex) { return groupsEl.querySelector(`.group[data-abs-index="${absIndex}"]`); }
function getBucketGrid(absIndex) { const sec = getBucketSection(absIndex); return sec ? sec.querySelector('.grid') : null; }
function setSelectedBucket(absIndex) {
  selBucketAbsIndex = clamp(absIndex, 0, groups.length - 1);
  ensureBucketVisible(selBucketAbsIndex);
  const sec = getBucketSection(selBucketAbsIndex);
  if (sec) sec.scrollIntoView({ block: 'nearest' });
}
function getGridCols(container) {
  const children = Array.from(container?.children || []);
  if (children.length <= 1) return 1;
  const top0 = children[0].offsetTop; let cols = 0;
  for (const el of children) { if (el.offsetTop !== top0) break; cols++; }
  return Math.max(1, cols);
}
function setSelectedPhoto(newIdx) {
  const vis = visibleItemsForBucket(selBucketAbsIndex);
  if (!vis.length) return;
  selPhotoIndex = clamp(newIdx, 0, vis.length - 1);
  updateListSelectionUI(true);
  const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex];
  if (fig) fig.scrollIntoView({ block: 'nearest' });
}
function clearAllListSelections() {
  groupsEl.querySelectorAll('.group').forEach(sec => {
    sec.classList.remove('bucket-selected', 'photo-mode');
    sec.querySelectorAll('.item.selected').forEach(f => f.classList.remove('selected'));
  });
}
function updateListSelectionUI(onlyPhoto = false) {
  const sec = getBucketSection(selBucketAbsIndex);
  if (!onlyPhoto) clearAllListSelections();
  if (sec) {
    sec.classList.add('bucket-selected');
    if (listMode === 'photo') sec.classList.add('photo-mode');
    const grid = sec.querySelector('.grid');
    grid?.querySelectorAll('.item.selected').forEach(f => f.classList.remove('selected'));
    if (listMode === 'photo') {
      const vis = visibleItemsForBucket(selBucketAbsIndex);
      if (!vis.length) return;
      const fig = grid?.children[selPhotoIndex];
      if (fig?.classList?.contains('item')) fig.classList.add('selected');
    }
  }
}

/* ---------- Overlay ---------- */
function openBucket(index) {
  currentOverlayIndex = clamp(index, 0, groups.length - 1);
  lastOpenAbsIndex = currentOverlayIndex;
  overlaySelIdx = 0; overlayEdgeIntent = null;
  renderOverlay();
  overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false');
}
function hideOverlay(skipFocusReturn = false) {
  overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true');
  revokeOverlayURLs(); closeViewer();
  if (lastOpenAbsIndex !== null) {
    goToPage(Math.floor(lastOpenAbsIndex / BUCKETS_PER_PAGE) + 1);
    listMode = 'bucket'; setSelectedBucket(lastOpenAbsIndex);
  }
  currentOverlayIndex = null; overlayEdgeIntent = null;
  updateCountersUI();
}
function getOverlayFig(idx) { return overlayGrid.children[idx] || null; }
function setOverlaySelected(newIdx) {
  const vis = currentVisibleOverlayItems();
  if (!vis.length) return;
  const idx = clamp(newIdx, 0, vis.length - 1);
  getOverlayFig(overlaySelIdx)?.classList.remove('selected');
  overlaySelIdx = idx;
  const fig = getOverlayFig(overlaySelIdx);
  if (fig) { fig.classList.add('selected'); fig.scrollIntoView({ block: 'nearest' }); }
  overlayEdgeIntent = null;
  if (isViewerOpen()) updateViewerImage();
}
function syncOverlayAria(idx) {
  const figWrap = overlayGrid.children[idx];
  if (!figWrap) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[idx];
  if (!it || isManaged(it)) return;
  const key = keyFor(it);
  figWrap.querySelector('.btn-trash')?.setAttribute('aria-pressed', trashSet.has(key) + '');
  figWrap.querySelector('.btn-star')?.setAttribute('aria-pressed',  starSet.has(key)  + '');
  figWrap.querySelector('.btn-idea')?.setAttribute('aria-pressed',  ideaSet.has(key)  + '');
}
function renderOverlay() {
  revokeOverlayURLs();
  overlayGrid.innerHTML = '';
  const g = groups[currentOverlayIndex];
  const vis = currentVisibleOverlayItems();
  overlayTitle.textContent = `Bucket ${currentOverlayIndex + 1} de ${groups.length}`;
  overlayMeta.textContent  = `${fmtSpan(g.startTs, g.endTs)} · ${vis.length} foto(s)`;
  overlayPrev.disabled = (currentOverlayIndex <= 0);
  overlayNext.disabled = (currentOverlayIndex >= groups.length - 1);

  vis.forEach((it, idx) => {
    const node = itemTpl.content.cloneNode(true);
    const fig = node.querySelector('.item');
    const img = node.querySelector('img');
    const cap = node.querySelector('.caption');
    const btnTrash  = node.querySelector('.btn-trash');
    const btnStar   = node.querySelector('.btn-star');
    const btnIdea   = node.querySelector('.btn-idea');
    const btnRotate = node.querySelector('.btn-rotate');
    fig.tabIndex = -1;
    img.alt = it.name; cap.textContent = it.name;
    getDisplayURL(it, 'overlay').then(url => { img.src = url; }).catch(() => { img.alt = it.name + ' (sin preview)'; });
    applyItemClasses(fig, it);

    // Botón rotar — solo JPEG no gestionado
    if (btnRotate) {
      if (!isManaged(it) && isJpeg(it)) {
        btnRotate.addEventListener('click', async e => {
          e.stopPropagation();
          setOverlaySelected(idx);
          await rotateSelected();
          // refrescar imagen de esta miniatura
          const newUrl = await getDisplayURL(it, 'overlay');
          img.src = newUrl;
        });
      } else {
        btnRotate.style.display = 'none';
      }
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
    } else {
      btnTrash.remove(); btnStar.remove(); btnIdea.remove();
      fig.addEventListener('click', () => setOverlaySelected(idx));
    }
    overlayGrid.appendChild(node);
  });
  if (vis.length > 0) setOverlaySelected(Math.min(overlaySelIdx, vis.length - 1));
}

/* ---------- Rotación JPEG ---------- */
function isJpeg(it) { return /\.(jpe?g)$/i.test(it.name) || it.file?.type === 'image/jpeg'; }

async function rotateJpeg90cw(it) {
  if (!it.fileHandle || !it.dirHandle) throw new Error('Sin handle de escritura');

  // Leer el archivo original como ArrayBuffer
  const srcFile = await it.fileHandle.getFile();
  const arrayBuf = await srcFile.arrayBuffer();
  const srcBytes = new Uint8Array(arrayBuf);

  // Extraer EXIF con piexifjs (trabaja con dataURL/binary string)
  const binStr = srcBytes.reduce((s, b) => s + String.fromCharCode(b), '');
  let exifObj = null;
  try { exifObj = piexif.load(binStr); } catch (_) { exifObj = {}; }

  // Dibujar imagen rotada en canvas
  const blob = new Blob([srcBytes], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const img  = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  URL.revokeObjectURL(url);

  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalHeight;
  canvas.height = img.naturalWidth;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

  // Exportar como JPEG blob
  const rotatedBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
  const rotatedBuf  = await rotatedBlob.arrayBuffer();
  const rotatedBytes = new Uint8Array(rotatedBuf);

  // Reinyectar EXIF — corregir orientación a 1 (normal) y actualizar dimensiones
  if (exifObj) {
    if (exifObj['0th']) {
      exifObj['0th'][piexif.ImageIFD.Orientation] = 1;
      exifObj['0th'][piexif.ImageIFD.ImageWidth]  = canvas.width;
      exifObj['0th'][piexif.ImageIFD.ImageLength] = canvas.height;
    }
    if (exifObj['Exif']) {
      exifObj['Exif'][piexif.ExifIFD.PixelXDimension] = canvas.width;
      exifObj['Exif'][piexif.ExifIFD.PixelYDimension] = canvas.height;
    }
    try {
      const exifBytes = piexif.dump(exifObj);
      const rotatedBin = rotatedBytes.reduce((s, b) => s + String.fromCharCode(b), '');
      const withExif   = piexif.insert(exifBytes, rotatedBin);
      const finalBytes = new Uint8Array(withExif.length);
      for (let i = 0; i < withExif.length; i++) finalBytes[i] = withExif.charCodeAt(i);

      // Escribir en disco
      const ws = await it.fileHandle.createWritable();
      await ws.write(finalBytes.buffer);
      await ws.close();
    } catch (_) {
      // Si piexif falla, escribir sin EXIF antes de tirar el error
      const ws = await it.fileHandle.createWritable();
      await ws.write(rotatedBuf);
      await ws.close();
    }
  } else {
    const ws = await it.fileHandle.createWritable();
    await ws.write(rotatedBuf);
    await ws.close();
  }

  // Actualizar el item en memoria con el nuevo File
  const newFile = await it.fileHandle.getFile();
  it.file = newFile;
  it.size = newFile.size;

  // Limpiar caches de URL para esta foto
  const key = keyFor(it);
  const listURL = heicListURLCache.get(key);
  if (listURL) { URL.revokeObjectURL(listURL); heicListURLCache.delete(key); }
  const ovURL = heicOverlayURLCache.get(key);
  if (ovURL) { URL.revokeObjectURL(ovURL); heicOverlayURLCache.delete(key); }
}

async function rotateSelected() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it  = vis[overlaySelIdx];
  if (!it || isManaged(it) || !isJpeg(it)) return;

  try {
    await rotateJpeg90cw(it);
    const fig = overlayGrid.children[overlaySelIdx];
    const img = fig?.querySelector('img');
    if (img) {
      const newUrl = await getDisplayURL(it, 'overlay');
      img.src = newUrl;
    }
    if (isViewerOpen()) await updateViewerImage();
    progressEl.textContent = `Rotada: ${it.name}`;
  } catch (err) {
    console.error('Error rotando', err);
    progressEl.textContent = `Error al rotar: ${err.message}`;
  }
}

/* ---------- Viewer ---------- */
function isViewerOpen() { return !viewer.hidden; }
function openViewer() { updateViewerImage(); viewer.hidden = false; viewer.setAttribute('aria-hidden', 'false'); updateViewerButtonsState(); }
function closeViewer() { viewer.hidden = true; viewer.setAttribute('aria-hidden', 'true'); }

async function updateViewerImage() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  if (!it) return;
  const img = overlayGrid.children[overlaySelIdx]?.querySelector('img');
  viewerImg.src = '';
  if (img?.src) viewerImg.src = img.src;
  else { try { viewerImg.src = await getDisplayURL(it, 'overlay'); } catch { viewerImg.removeAttribute('src'); } }
  viewerCaption.textContent = `${it.name} · ${overlaySelIdx + 1}/${vis.length}`;
  updateViewerButtonsState();
}
function updateViewerButtonsState() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  if (!it) return;
  const key = keyFor(it);
  const isTrash = (it.managed === 'trash') || trashSet.has(key);
  const isStar  = starSet.has(key);
  const isIdea  = (it.managed === 'ideas') || ideaSet.has(key);
  const locked  = isManaged(it);
  viewerBtnTrash.setAttribute('aria-pressed', isTrash + '');
  viewerBtnStar .setAttribute('aria-pressed', isStar  + '');
  viewerBtnIdea .setAttribute('aria-pressed', isIdea  + '');
  viewerBtnTrash.disabled = viewerBtnStar.disabled = viewerBtnIdea.disabled = locked;
  viewerBtnTrash.style.display = viewerBtnStar.style.display = viewerBtnIdea.style.display = locked ? 'none' : '';
  viewer.classList.toggle('viewer-starred', isStar);
  viewer.classList.toggle('viewer-trashed', isTrash && !isStar);
  viewer.classList.toggle('viewer-idea',    isIdea && !isStar && !isTrash);
}

/* ---------- Mover archivos ---------- */
function hasWriteSupport() { return !!rootDirHandle; }
function countMovable(set) {
  let n = 0;
  for (const k of set) { const it = itemByKey.get(k); if (it?.dirHandle && it?.fileHandle && !isManaged(it)) n++; }
  return n;
}
function updateActionButtons() {
  moveBtn.disabled        = !(hasWriteSupport() && countMovable(trashSet) > 0);
  moveIdeasBtn.disabled   = !(hasWriteSupport() && countMovable(ideaSet)  > 0);
  moveSelectedBtn.disabled= !(hasWriteSupport() && countMovable(starSet)  > 0);
}

async function ensureUniqueName(dirHandle, name) {
  const m = name.match(/^(.*?)(\.[^.]*)?$/);
  const base = m?.[1] ?? name, ext = m?.[2] ?? '';
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
    const srcFile = await it.fileHandle.getFile();
    const dstHandle = await targetDir.getFileHandle(dstName, { create: true });
    const ws = await dstHandle.createWritable();
    await ws.write(await srcFile.arrayBuffer());
    await ws.close();
    await it.dirHandle.removeEntry(it.name);
  }
  return dstName;
}
async function moveMarkedTo(folderName, set) {
  if (!hasWriteSupport()) { alert('Necesitas abrir una carpeta con "Abrir carpeta".'); return; }
  const movable = [];
  for (const k of set) { const it = itemByKey.get(k); if (it?.dirHandle && it?.fileHandle && !isManaged(it)) movable.push(it); }
  if (!movable.length) { alert('No hay elementos con permisos de escritura.'); return; }
  const targetDir = await rootDirHandle.getDirectoryHandle(folderName, { create: true });
  let ok = 0, fail = 0;
  progressEl.textContent = `Moviendo ${movable.length} foto(s) a /${folderName}…`;
  for (let i = 0; i < movable.length; i++) {
    const it = movable[i];
    try {
      progressEl.textContent = `Moviendo (${i + 1}/${movable.length}): ${it.relPath || it.name}`;
      const oldKey = keyFor(it);
      const dstName = await moveOne(it, targetDir);
      const dstHandle = await targetDir.getFileHandle(dstName, { create: false });
      const dstFile = await dstHandle.getFile();
      it.file = dstFile; it.name = dstName; it.size = dstFile.size || it.size;
      it.fileHandle = dstHandle; it.dirHandle = targetDir;
      it.relPath = `${folderName}/${dstName}`;
      it.managed = folderName === 'trash' ? 'trash' : folderName === 'ideas' ? 'ideas' : 'selected';
      itemByKey.delete(oldKey);
      itemByKey.set(keyFor(it), it);
      trashSet.delete(oldKey); starSet.delete(oldKey); ideaSet.delete(oldKey);
      ok++;
    } catch (err) { console.error('Fallo moviendo', it.name, err); fail++; }
  }
  buildGroups();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI();
  updateActionButtons(); updateCountersUI();
  progressEl.textContent = `Listo: movidas ${ok} foto(s) a /${folderName}` + (fail ? ` · ${fail} fallida(s)` : '');
}
async function moveMarkedToTrash()    { return moveMarkedTo('trash', trashSet); }
async function moveMarkedToIdeas()    { return moveMarkedTo('ideas', ideaSet); }
async function moveMarkedToSelected() { return moveMarkedTo('selected', starSet); }

/* ---------- Eventos UI ---------- */
pickDirBtn.addEventListener('click', loadFromDirectory);

toggleManagedBtn.addEventListener('click', () => {
  showManaged = !showManaged;
  toggleManagedBtn.classList.toggle('is-on', showManaged);
  buildGroups();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState(); renderPage(currentPage); updateListSelectionUI();
  if (!overlay.hidden && currentOverlayIndex !== null) {
    const vis = currentVisibleOverlayItems();
    overlaySelIdx = Math.min(overlaySelIdx, Math.max(0, vis.length - 1));
    renderOverlay();
  }
});

document.querySelectorAll('.btn-mins').forEach(btn => {
  btn.addEventListener('click', () => {
    const newMins = parseInt(btn.dataset.mins, 10);
    if (newMins === currentMins) return;
    currentMins = newMins;
    document.querySelectorAll('.btn-mins').forEach(b => b.classList.toggle('active', b === btn));
    if (rootDirHandle) {
      const savedTrash = new Set(trashSet);
      const savedStar  = new Set(starSet);
      const savedIdea  = new Set(ideaSet);
      scanDir(rootDirHandle).then(entries =>
        loadEntriesWithHandles(entries).then(() => {
          for (const k of savedTrash) if (itemByKey.has(k)) trashSet.add(k);
          for (const k of savedStar)  if (itemByKey.has(k)) starSet.add(k);
          for (const k of savedIdea)  if (itemByKey.has(k)) ideaSet.add(k);
          renderPage(currentPage); updateActionButtons(); updateCountersUI();
        })
      );
    }
  });
});

moveBtn.addEventListener('click', moveMarkedToTrash);
moveIdeasBtn.addEventListener('click', moveMarkedToIdeas);
moveSelectedBtn.addEventListener('click', moveMarkedToSelected);

firstBtn.addEventListener('click', () => goToPage(1));
prevBtn .addEventListener('click', () => goToPage(currentPage - 1));
nextBtn .addEventListener('click', () => goToPage(currentPage + 1));
lastBtn .addEventListener('click', () => goToPage(totalPages()));
pageInput.addEventListener('change', () => { const n = parseInt(pageInput.value || '1', 10); goToPage(isNaN(n) ? 1 : n); });

/* ---------- Teclado global ---------- */
function isOverlayOpen() { return !overlay.hidden; }

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (isViewerOpen()) { viewerKeydown(e); return; }
  if (isOverlayOpen()) { overlayKeydown(e); return; }

  const vis = visibleItemsForBucket(selBucketAbsIndex);
  switch (e.key) {
    case ' ': e.preventDefault(); openBucket(selBucketAbsIndex); break;
    case 'ArrowUp': e.preventDefault();
      if (listMode === 'bucket') setSelectedBucket(selBucketAbsIndex - 1);
      else { const cols = getGridCols(getBucketGrid(selBucketAbsIndex)); if (vis.length) setSelectedPhoto(selPhotoIndex - cols); }
      break;
    case 'ArrowDown': e.preventDefault();
      if (listMode === 'bucket') setSelectedBucket(selBucketAbsIndex + 1);
      else { const cols = getGridCols(getBucketGrid(selBucketAbsIndex)); if (vis.length) setSelectedPhoto(selPhotoIndex + cols); }
      break;
    case 'ArrowLeft': e.preventDefault();
      if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); }
      else if (vis.length) setSelectedPhoto(selPhotoIndex - 1);
      break;
    case 'ArrowRight': e.preventDefault();
      if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); }
      else if (vis.length) setSelectedPhoto(selPhotoIndex + 1);
      break;
    case 'Escape':
      if (listMode === 'photo') { e.preventDefault(); listMode = 'bucket'; updateListSelectionUI(); }
      break;
    case 'x': case 'X':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex];
        const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item');
        if (node) { toggleTrash(keyFor(it), node); updateListSelectionUI(true); }
      } break;
    case 'z': case 'Z':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex];
        const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item');
        if (node) { toggleStar(keyFor(it), node); updateListSelectionUI(true); }
      } break;
    case 'i': case 'I':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault(); const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const fig = getBucketGrid(selBucketAbsIndex)?.children[selPhotoIndex];
        const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item');
        if (node) { toggleIdea(keyFor(it), node); updateListSelectionUI(true); }
      } break;
    case 'r': case 'R':
      if (vis.length) {
        e.preventDefault();
        vis.forEach((it, idx) => {
          if (isManaged(it)) return;
          const key = keyFor(it);
          if (!starSet.has(key)) {
            trashSet.add(key); starSet.delete(key); ideaSet.delete(key);
            const fig = getBucketGrid(selBucketAbsIndex)?.children[idx];
            const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item');
            if (node) applyItemClasses(node, it);
          }
        });
        updateActionButtons(); updateListSelectionUI(true); updateCountersUI();
      } break;
    case 'p': case 'P':
      if (vis.length) {
        e.preventDefault();
        vis.forEach((it, idx) => {
          if (isManaged(it)) return;
          const key = keyFor(it);
          if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) {
            starSet.add(key); trashSet.delete(key); ideaSet.delete(key);
            const fig = getBucketGrid(selBucketAbsIndex)?.children[idx];
            const node = fig?.classList?.contains('item') ? fig : fig?.querySelector('.item');
            if (node) applyItemClasses(node, it);
          }
        });
        updateActionButtons(); updateListSelectionUI(true); updateCountersUI();
      } break;
  }
});

function overlayKeydown(e) {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const total = vis.length;
  const cols = getGridCols(overlayGrid);

  switch (e.key) {
    case 'Escape': hideOverlay(); break;
    case ' ': e.preventDefault(); isViewerOpen() ? closeViewer() : openViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;
    case 'ArrowDown': {
      e.preventDefault();
      const next = overlaySelIdx + cols;
      if (next <= total - 1) setOverlaySelected(next);
      else if (overlaySelIdx !== total - 1) { setOverlaySelected(total - 1); overlayEdgeIntent = 'down'; }
      else if (overlayEdgeIntent === 'down' && currentOverlayIndex < groups.length - 1) { currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); }
      else overlayEdgeIntent = 'down';
      break;
    }
    case 'ArrowUp': {
      e.preventDefault();
      const prev = overlaySelIdx - cols;
      if (prev >= 0) setOverlaySelected(prev);
      else if (overlaySelIdx !== 0) { setOverlaySelected(0); overlayEdgeIntent = 'up'; }
      else if (overlayEdgeIntent === 'up' && currentOverlayIndex > 0) {
        currentOverlayIndex--; overlaySelIdx = Math.max(0, visibleItemsForBucket(currentOverlayIndex).length - 1); overlayEdgeIntent = null; renderOverlay();
      } else overlayEdgeIntent = 'up';
      break;
    }
    case 'x': case 'X': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; const key = keyFor(it); toggleTrash(key, overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'z': case 'Z': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; const key = keyFor(it); toggleStar(key, overlayGrid.children[overlaySelIdx]);  syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'i': case 'I': { e.preventDefault(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break; const key = keyFor(it); toggleIdea(key, overlayGrid.children[overlaySelIdx]);  syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); overlayEdgeIntent = null; break; }
    case 'r': case 'R': {
      e.preventDefault();
      vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!starSet.has(key)) { trashSet.add(key); starSet.delete(key); ideaSet.delete(key); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it); } });
      updateActionButtons(); overlayEdgeIntent = null; updateViewerButtonsState(); updateCountersUI(); break;
    }
    case 'p': case 'P': {
      e.preventDefault();
      vis.forEach((it, idx) => { if (isManaged(it)) return; const key = keyFor(it); if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) { starSet.add(key); trashSet.delete(key); ideaSet.delete(key); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it); } });
      updateActionButtons(); overlayEdgeIntent = null; updateViewerButtonsState(); updateCountersUI(); break;
    }
    case 'j': case 'J': {
      e.preventDefault();
      rotateSelected();
      break;
    }
  }
}

function viewerKeydown(e) {
  if (!isViewerOpen() || currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  const locked = it ? isManaged(it) : true;
  switch (e.key) {
    case ' ': case 'Escape': e.preventDefault(); closeViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;
    case 'x': case 'X': if (!locked && it) { e.preventDefault(); toggleTrash(keyFor(it), overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'z': case 'Z': if (!locked && it) { e.preventDefault(); toggleStar(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); } break;
    case 'i': case 'I': if (!locked && it) { e.preventDefault(); toggleIdea(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); } break;
    case 'r': case 'R': if (!locked && vis.length) {
      e.preventDefault();
      vis.forEach((it2, idx) => { if (isManaged(it2)) return; const key = keyFor(it2); if (!starSet.has(key)) { trashSet.add(key); starSet.delete(key); ideaSet.delete(key); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it2); } });
      updateActionButtons(); updateViewerButtonsState(); updateCountersUI();
    } break;
    case 'p': case 'P': if (!locked && vis.length) {
      e.preventDefault();
      vis.forEach((it2, idx) => { if (isManaged(it2)) return; const key = keyFor(it2); if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) { starSet.add(key); trashSet.delete(key); ideaSet.delete(key); const fig = overlayGrid.children[idx]; if (fig) applyItemClasses(fig, it2); } });
      updateActionButtons(); updateViewerButtonsState(); updateCountersUI();
    } break;
  }
}

/* ---------- Botones overlay ---------- */
overlayClose.addEventListener('click', () => hideOverlay());
overlayPrev.addEventListener('click', () => { if (currentOverlayIndex > 0) { currentOverlayIndex--; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); } });
overlayNext.addEventListener('click', () => { if (currentOverlayIndex < groups.length - 1) { currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); } });

/* ---------- Botones visor ---------- */
viewerBtnTrash.addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleTrash(keyFor(it), overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); });
viewerBtnStar .addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleStar(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI(); });
viewerBtnIdea .addEventListener('click', () => { const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx]; if (!it || isManaged(it)) return; toggleIdea(keyFor(it),  overlayGrid.children[overlaySelIdx]); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); });

/* ---------- Inicial ---------- */
renderPage(currentPage);
updateListSelectionUI();
updateActionButtons();
updateCountersUI();
toggleManagedBtn.classList.toggle('is-on', showManaged);

Object.assign(window, { allItems, groups, openBucket, moveMarkedToTrash, moveMarkedToIdeas, moveMarkedToSelected });
