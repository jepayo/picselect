/* ---------- DOM refs ---------- */
const groupsEl = document.getElementById('groups');
const pickDirBtn = document.getElementById('pickDir');
const pickFilesInput = document.getElementById('pickFiles');
const minutesInput = document.getElementById('minutes');
const exportBtn = document.getElementById('exportSel');
const moveBtn = document.getElementById('moveTrash');
const moveIdeasBtn = document.getElementById('moveIdeas');
const moveSelectedBtn = document.getElementById('moveSelected');
const toggleManagedInput = document.getElementById('toggleManaged');
// Contadores
const countPendingEl = document.getElementById('countPending');
const countStarEl    = document.getElementById('countStar');
const countIdeaEl    = document.getElementById('countIdea');
const countTrashEl   = document.getElementById('countTrash');
const countTotalEl   = document.getElementById('countTotal');
// Pager
const firstBtn = document.getElementById('firstPage');
const prevBtn  = document.getElementById('prevPage');
const nextBtn  = document.getElementById('nextPage');
const lastBtn  = document.getElementById('lastPage');
const pageInput = document.getElementById('pageInput');
const pageTotalSpan = document.getElementById('pageTotal');
const progressEl = document.getElementById('progress');
// Overlay
const overlay = document.getElementById('bucketOverlay');
const overlayGrid = document.getElementById('overlayGrid');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMeta = document.getElementById('overlayMeta');
const overlayClose = document.getElementById('closeOverlay');
const overlayPrev = document.getElementById('overlayPrev');
const overlayNext = document.getElementById('overlayNext');
// Viewer
const viewer = document.getElementById('photoViewer');
const viewerImg = document.getElementById('viewerImg');
const viewerCaption = document.getElementById('viewerCaption');
const viewerBtnTrash = document.getElementById('viewerTrash');
const viewerBtnStar  = document.getElementById('viewerStar');
const viewerBtnIdea  = document.getElementById('viewerIdea');

const groupTpl = document.getElementById('groupTpl');
const itemTpl = document.getElementById('itemTpl');

/* ---------- Estado ---------- */
let allItems = [];          // [{file, name, size, ts, fileHandle?, dirHandle?, relPath?, managed?: 'trash'|'ideas'|null}]
let groups = [];            // [{startTs, endTs, items:[...] }]
let trashSet = new Set();   // nuevas selecciones para trash
let starSet  = new Set();   // nuevas selecciones para star
let ideaSet  = new Set();   // nuevas selecciones para ideas
let currentPage = 1;
const BUCKETS_PER_PAGE = 3;

let rootDirHandle = null;
let itemByKey = new Map();

let activeListURLs = new Set();
let activeOverlayURLs = new Set();

/* Selección en LISTA */
let listMode = 'bucket';         // 'bucket' | 'photo'
let selBucketAbsIndex = 0;
let selPhotoIndex = 0;

/* OVERLAY */
let currentOverlayIndex = null;
let overlaySelIdx = 0;
let lastOpenAbsIndex = null;
let overlayEdgeIntent = null;

/* Mostrar/ocultar gestionadas (/trash, /ideas) */
let showManaged = true;

/* ---------- Utilidades ---------- */
function msPerBucket() { const m = Math.max(1, parseInt(minutesInput.value || '5', 10)); return m * 60 * 1000; }
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function fmtSpan(startMs, endMs) {
  const start = new Date(startMs), end = new Date(endMs);
  const sameDay = start.toDateString() === end.toDateString();
  const d = start.toLocaleDateString();
  const s = start.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const e = end.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  return sameDay ? `${d} · ${s} – ${e}` : `${start.toLocaleString()} – ${end.toLocaleString()}`;
}
function keyFor(it){ return `${it.name}|${it.size}|${it.ts}`; }
function isManaged(it){ return it?.managed === 'trash' || it?.managed === 'ideas' || it?.managed === 'selected'; }
function visibleItemsForBucket(absIndex){
  const g = groups[absIndex];
  if (!g) return [];
  return showManaged ? g.items : g.items.filter(it => !isManaged(it));
}
function currentVisibleOverlayItems(){
  if (currentOverlayIndex === null) return [];
  return visibleItemsForBucket(currentOverlayIndex);
}

/* ---------- HEIC/HEIF helpers (preview-only) ---------- */
function isHeicName(name=''){ return /\.(heic|heif)$/i.test(name); }
function isHeicFile(f){ return (f?.type && /image\/hei[cf]/i.test(f.type)) || isHeicName(f?.name); }

const heicListURLCache    = new Map();  // key -> blobURL JPEG (lista)
const heicOverlayURLCache = new Map();  // key -> blobURL JPEG (overlay)

const HEIC_MAX_CONCURRENCY = 2;
let heicActive = 0;
const heicQueue = [];
function enqueueHeicConversion(file){
  return new Promise((resolve, reject)=>{
    heicQueue.push({ file, resolve, reject });
    pumpHeicQueue();
  });
}
async function pumpHeicQueue(){
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
async function getDisplayURL(it, level /* 'list' | 'overlay' */){
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

/* ---------- Contadores (solo nuevas selecciones, no gestionadas) ---------- */
function computeCounts() {
  const total = allItems.length;

  // NOTA: nStar/nTrash/nIdea = solo nuevas selecciones (sets), como acordamos
  const nStar  = starSet.size;
  const nTrash = trashSet.size;
  const nIdea  = ideaSet.size;

  // Pendientes = total - nuevas selecciones - (ya gestionadas, que no contamos en sets)
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
  countStarEl.textContent    = `⭐ ${nStar}`;
  countIdeaEl.textContent    = `💡 ${nIdea}`;
  countTrashEl.textContent   = `🗑 ${nTrash}`;
  countPendingEl.textContent = `Pendientes: ${Math.max(0, nPending)}`;
}

/* ---------- Carga & agrupado ---------- */
async function getTimestamp(file) {
  try {
    const exif = await exifr.parse(file, ['DateTimeOriginal','CreateDate','OffsetTime','OffsetTimeOriginal']);
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
      entries.push({
        file, fileHandle: h, dirHandle: dirHandle,
        relPath: relPrefix + name, managed
      });
    }
  }
  return entries;
}

async function loadFromDirectory() {
  if (!('showDirectoryPicker' in window)) {
    alert('Tu navegador no soporta abrir carpetas. Usa "elegir archivos".');
    return;
  }
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
      fileHandle: e.fileHandle, dirHandle: e.dirHandle ?? rootDirHandle, relPath: e.relPath,
      managed: e.managed ?? null
    };
    allItems.push(item);
    itemByKey.set(keyFor(item), item);
    i++;
    if (i % 25 === 0 || i === entries.length) {
      progressEl.textContent = `Leyendo metadatos… ${i} / ${entries.length}`;
    }
  }
  buildGroups(); currentPage = 1; updatePagerState(); renderPage(currentPage);
  progressEl.textContent = `Listo: ${allItems.length} fotos → ${groups.length} buckets`;
  listMode = 'bucket'; selBucketAbsIndex = 0; selPhotoIndex = 0;
  updateListSelectionUI(); updateActionButtons(); updateCountersUI();
}

async function loadFiles(fileList) {
  rootDirHandle = null;
  resetState();
  const files = Array.from(fileList);
  files.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  progressEl.textContent = `Leyendo metadatos… 0 / ${files.length}`;
  let i = 0;
  for (const file of files) {
    const ts = await getTimestamp(file);
    const item = { file, name: file.name, size: file.size || 0, ts, managed: null };
    allItems.push(item);
    itemByKey.set(keyFor(item), item);
    i++;
    if (i % 25 === 0 || i === files.length) {
      progressEl.textContent = `Leyendo metadatos… ${i} / ${files.length}`;
    }
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
  exportBtn.disabled = true; moveBtn.disabled = true; moveIdeasBtn.disabled = true; moveSelectedBtn.disabled = true;
  if (clearRoot) rootDirHandle = null;
  groupsEl.textContent = '';
  pageInput.disabled = true;
  firstBtn.disabled = prevBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
  hideOverlay(true);
  updateCountersUI();
}

function buildGroups() {
  const source = showManaged ? allItems : allItems.filter(it => !isManaged(it));
  const sorted = [...source].sort((a,b)=> a.ts - b.ts);
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

/* ---------- Paginación & render lista ---------- */
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
  const total = totalPages();
  currentPage = clamp(n, 1, total);
  updatePagerState();
  renderPage(currentPage);
  updateListSelectionUI();
  updateCountersUI();
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

function applyItemClasses(fig, it){
  fig.classList.toggle('locked', isManaged(it));
  if (isManaged(it)) {
    fig.dataset.locked = (it.managed === 'trash' ? 'TRASH' : it.managed === 'ideas' ? 'IDEAS' : 'SELECTED');
    fig.classList.remove('trashed', 'starred', 'idea');
    return;
  }
  const key = keyFor(it);
  fig.classList.toggle('trashed', trashSet.has(key));
  fig.classList.toggle('starred', starSet.has(key));
  fig.classList.toggle('idea',   ideaSet.has(key));
}

function makeExclusive(toSet, otherSet1, otherSet2, key) {
  if (toSet.has(key)) toSet.delete(key);
  else { toSet.add(key); otherSet1.delete(key); otherSet2.delete(key); }
}
function toggleTrash(key, fig){
  const it = itemByKey.get(key);
  if (isManaged(it)) return;
  makeExclusive(trashSet, starSet, ideaSet, key);
  applyItemClasses(fig, it);
  updateActionButtons(); updateCountersUI();
}
function toggleStar(key, fig){
  const it = itemByKey.get(key);
  if (isManaged(it)) return;
  makeExclusive(starSet, trashSet, ideaSet, key);
  applyItemClasses(fig, it);
  updateActionButtons(); updateCountersUI();
}
function toggleIdea(key, fig){
  const it = itemByKey.get(key);
  if (isManaged(it)) return;
  makeExclusive(ideaSet, trashSet, starSet, key);
  applyItemClasses(fig, it);
  updateActionButtons(); updateCountersUI();
}

function renderPage(pageNum) {
  revokeListURLs();
  groupsEl.innerHTML = '';
  if (groups.length === 0) {
    groupsEl.innerHTML = '<p style="padding:16px;color:#666">No hay imágenes cargadas.</p>';
    return;
  }
  const startIdx = (pageNum - 1) * BUCKETS_PER_PAGE;
  const endIdx = Math.min(startIdx + BUCKETS_PER_PAGE, groups.length);
  const slice = groups.slice(startIdx, endIdx);

  slice.forEach((g, iLocal) => {
    const absIndex = startIdx + iLocal;
    const itemsToShow = visibleItemsForBucket(absIndex);

    const sectionFrag = groupTpl.content.cloneNode(true);
    const section = sectionFrag.querySelector('.group');
    section.dataset.absIndex = String(absIndex);
    section.querySelector('.gtitle').textContent = `${fmtSpan(g.startTs, g.endTs)} · ${itemsToShow.length} foto(s)`;

    const ghit = sectionFrag.querySelector('.ghit');
    ghit.addEventListener('click', () => { openBucket(absIndex); });
    ghit.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); openBucket(absIndex); }
    });

    section.addEventListener('click', (ev) => {
      if (ev.target.closest('.ghit, .btn-trash, .btn-star, .btn-idea, figure.item')) return;
      listMode = 'bucket';
      setSelectedBucket(absIndex);
      updateListSelectionUI();
    });

    const grid = sectionFrag.querySelector('.grid');
    for (const it of itemsToShow) {
      const node = itemTpl.content.cloneNode(true);
      const fig = node.querySelector('.item');
      const img = node.querySelector('img');
      const cap = node.querySelector('.caption');
      const btnTrash = node.querySelector('.btn-trash');
      const btnStar  = node.querySelector('.btn-star');
      const btnIdea  = node.querySelector('.btn-idea');

      img.alt = it.name; cap.textContent = it.name;

      getDisplayURL(it, 'list').then(url => { img.src = url; })
        .catch(() => { img.alt = it.name + ' (sin previsualización)'; });

      applyItemClasses(fig, it);

      if (!isManaged(it)) {
        const key = keyFor(it);
        btnTrash.setAttribute('aria-pressed', trashSet.has(key) ? 'true' : 'false');
        btnStar .setAttribute('aria-pressed',  starSet.has(key)  ? 'true' : 'false');
        btnIdea .setAttribute('aria-pressed',  ideaSet.has(key)  ? 'true' : 'false');

        btnTrash.addEventListener('click', (e)=>{ e.stopPropagation(); toggleTrash(key, fig);
          btnTrash.setAttribute('aria-pressed', trashSet.has(key)+''); btnStar.setAttribute('aria-pressed', starSet.has(key)+''); btnIdea.setAttribute('aria-pressed', ideaSet.has(key)+''); });
        btnStar .addEventListener('click', (e)=>{ e.stopPropagation(); toggleStar(key,  fig);
          btnTrash.setAttribute('aria-pressed', trashSet.has(key)+''); btnStar.setAttribute('aria-pressed', starSet.has(key)+''); btnIdea.setAttribute('aria-pressed', ideaSet.has(key)+''); });
        btnIdea .addEventListener('click', (e)=>{ e.stopPropagation(); toggleIdea(key,  fig);
          btnTrash.setAttribute('aria-pressed', trashSet.has(key)+''); btnStar.setAttribute('aria-pressed', starSet.has(key)+''); btnIdea.setAttribute('aria-pressed', ideaSet.has(key)+''); });
      } else {
        btnTrash.remove(); btnStar.remove(); btnIdea.remove();
      }

      grid.appendChild(node);
    }
    groupsEl.appendChild(sectionFrag);
  });
}

/* ---------- Selección en LISTA ---------- */
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
  if (sec) sec.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function getGridCols(container){
  const children = Array.from(container?.children || []);
  if (children.length <= 1) return 1;
  const top0 = children[0].offsetTop; let cols = 0;
  for (const el of children) { if (el.offsetTop !== top0) break; cols++; }
  return Math.max(1, cols);
}
function setSelectedPhoto(newIdx) {
  const vis = visibleItemsForBucket(selBucketAbsIndex);
  if (vis.length === 0) return;
  selPhotoIndex = clamp(newIdx, 0, vis.length - 1);
  updateListSelectionUI(true);
  const grid = getBucketGrid(selBucketAbsIndex);
  const fig = grid?.children[selPhotoIndex];
  if (fig) fig.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
      if (vis.length === 0) return;
      const fig = grid?.children[selPhotoIndex];
      if (fig?.classList?.contains('item')) fig.classList.add('selected');
      else fig?.querySelector('.item')?.classList.add('selected');
    }
  }
}

/* ---------- Rebucket ---------- */
function reBucketOnWindowChange() {
  if (allItems.length === 0) return;
  buildGroups();
  currentPage = 1;
  listMode = 'bucket';
  selBucketAbsIndex = 0;
  selPhotoIndex = 0;
  updatePagerState();
  renderPage(currentPage);
  updateListSelectionUI();
  updateCountersUI();
}

/* ---------- Overlay (bucket) ---------- */
function openBucket(index) {
  currentOverlayIndex = clamp(index, 0, groups.length - 1);
  lastOpenAbsIndex = currentOverlayIndex;
  overlaySelIdx = 0;
  overlayEdgeIntent = null;
  renderOverlay();
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
}
function hideOverlay(skipFocusReturn = false) {
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  revokeOverlayURLs();
  closeViewer();
  if (lastOpenAbsIndex !== null) {
    const targetPage = Math.floor(lastOpenAbsIndex / BUCKETS_PER_PAGE) + 1;
    goToPage(targetPage);
    listMode = 'bucket';
    setSelectedBucket(lastOpenAbsIndex);
  }
  currentOverlayIndex = null;
  overlayEdgeIntent = null;
  updateCountersUI();
}
function getOverlayFig(idx){ return overlayGrid.children[idx] || null; }
function setOverlaySelected(newIdx){
  const vis = currentVisibleOverlayItems();
  if (vis.length === 0) return;
  const idx = clamp(newIdx, 0, vis.length - 1);
  const prevFig = getOverlayFig(overlaySelIdx);
  if (prevFig) prevFig.classList.remove('selected');
  overlaySelIdx = idx;
  const fig = getOverlayFig(overlaySelIdx);
  if (fig) { fig.classList.add('selected'); fig.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  overlayEdgeIntent = null;
  if (isViewerOpen()) updateViewerImage();
}
function syncOverlayAria(idx){
  const figWrap = overlayGrid.children[idx];
  if (!figWrap) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[idx];
  if (!it || isManaged(it)) return;
  const btnTrash = figWrap.querySelector('.btn-trash');
  const btnStar  = figWrap.querySelector('.btn-star');
  const btnIdea  = figWrap.querySelector('.btn-idea');
  const key = keyFor(it);
  btnTrash.setAttribute('aria-pressed', trashSet.has(key) ? 'true' : 'false');
  btnStar .setAttribute('aria-pressed',  starSet.has(key)  ? 'true' : 'false');
  btnIdea .setAttribute('aria-pressed',  ideaSet.has(key)  ? 'true' : 'false');
}
function renderOverlay() {
  revokeOverlayURLs();
  overlayGrid.innerHTML = '';
  const g = groups[currentOverlayIndex];
  const vis = currentVisibleOverlayItems();

  overlayTitle.textContent = `Bucket ${currentOverlayIndex + 1} de ${groups.length}`;
  overlayMeta.textContent = `${fmtSpan(g.startTs, g.endTs)} · ${vis.length} foto(s)`;
  overlayPrev.disabled = (currentOverlayIndex <= 0);
  overlayNext.disabled = (currentOverlayIndex >= groups.length - 1);

  vis.forEach((it, idx) => {
    const node = itemTpl.content.cloneNode(true);
    const fig = node.querySelector('.item');
    const img = node.querySelector('img');
    const cap = node.querySelector('.caption');
    const btnTrash = node.querySelector('.btn-trash');
    const btnStar  = node.querySelector('.btn-star');
    const btnIdea  = node.querySelector('.btn-idea');
    fig.tabIndex = -1;

    img.alt = it.name; cap.textContent = it.name;
    getDisplayURL(it, 'overlay').then(url => { img.src = url; })
      .catch(()=> { img.alt = it.name + ' (sin previsualización)'; });

    applyItemClasses(fig, it);

    if (!isManaged(it)) {
      const key = keyFor(it);
      btnTrash.setAttribute('aria-pressed', trashSet.has(key) ? 'true' : 'false');
      btnStar .setAttribute('aria-pressed',  starSet.has(key)  ? 'true' : 'false');
      btnIdea .setAttribute('aria-pressed',  ideaSet.has(key)  ? 'true' : 'false');

      fig.addEventListener('click', ()=> setOverlaySelected(idx));
      btnTrash.addEventListener('click', (e)=>{ e.stopPropagation(); toggleTrash(key, fig); syncOverlayAria(idx); updateViewerButtonsState(); });
      btnStar .addEventListener('click', (e)=>{ e.stopPropagation(); toggleStar(key,  fig); syncOverlayAria(idx); updateViewerButtonsState(); });
      btnIdea .addEventListener('click', (e)=>{ e.stopPropagation(); toggleIdea(key,  fig); syncOverlayAria(idx); updateViewerButtonsState(); });
    } else {
      btnTrash.remove(); btnStar.remove(); btnIdea.remove();
      fig.addEventListener('click', ()=> setOverlaySelected(idx));
    }

    overlayGrid.appendChild(node);
  });
  if (vis.length > 0) setOverlaySelected(Math.min(overlaySelIdx, vis.length - 1));
}

/* ---------- Export TXT (trash) ---------- */
async function exportSelection() {
  if (trashSet.size === 0) return;
  const items = [...allItems].sort((a,b)=>a.ts-b.ts);
  const lines = [];
  for (const it of items) {
    const key = keyFor(it);
    if (!isManaged(it) && trashSet.has(key)) lines.push(it.relPath || it.name);
  }
  const blob = new Blob([lines.join('\n')], {type:'text/plain'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'seleccion_trash.txt'; a.click();
}

/* ---------- Viewer ---------- */
function isViewerOpen(){ return !viewer.hidden; }
function openViewer() { updateViewerImage(); viewer.hidden = false; viewer.setAttribute('aria-hidden', 'false'); updateViewerButtonsState(); }
function closeViewer() { viewer.hidden = true; viewer.setAttribute('aria-hidden', 'true'); }

async function updateViewerImage() {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  if (!it) return;

  const fig = overlayGrid.children[overlaySelIdx];
  const img = fig?.querySelector('img');

  viewerImg.src = '';
  if (img?.src) viewerImg.src = img.src;
  else {
    try { viewerImg.src = await getDisplayURL(it, 'overlay'); }
    catch { viewerImg.removeAttribute('src'); }
  }

  const pos = `${overlaySelIdx + 1}/${vis.length}`;
  viewerCaption.textContent = `${it.name} · ${pos}`;
  updateViewerButtonsState();
}
function updateViewerButtonsState(){
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  if (!it) return;

  const key = keyFor(it);
  const isTrash = (it.managed === 'trash') || trashSet.has(key);
  const isStar  = starSet.has(key);
  const isIdea  = (it.managed === 'ideas') || ideaSet.has(key);
  const locked  = isManaged(it);

  viewerBtnTrash.setAttribute('aria-pressed', isTrash ? 'true' : 'false');
  viewerBtnStar .setAttribute('aria-pressed',  isStar ? 'true' : 'false');
  viewerBtnIdea .setAttribute('aria-pressed',  isIdea ? 'true' : 'false');

  viewerBtnTrash.disabled = locked;
  viewerBtnStar.disabled  = locked;
  viewerBtnIdea.disabled  = locked;

  viewerBtnTrash.style.display = locked ? 'none' : '';
  viewerBtnStar.style.display  = locked ? 'none' : '';
  viewerBtnIdea.style.display  = locked ? 'none' : '';

  viewer.classList.toggle('viewer-starred', isStar);
  viewer.classList.toggle('viewer-trashed', isTrash && !isStar);
  viewer.classList.toggle('viewer-idea',    isIdea && !isStar && !isTrash);
}

/* ---------- Mover a /trash y /ideas (FS Access) ---------- */
function hasWriteSupport(){ return !!rootDirHandle; }

function countMovable(set){
  let n = 0;
  for (const k of set) {
    const it = itemByKey.get(k);
    if (it?.dirHandle && it?.fileHandle && !isManaged(it)) n++;
  }
  return n;
}
function updateActionButtons() {
  exportBtn.disabled = trashSet.size === 0;
  moveBtn.disabled = !(hasWriteSupport() && countMovable(trashSet) > 0);
  moveIdeasBtn.disabled = !(hasWriteSupport() && countMovable(ideaSet) > 0);
  moveSelectedBtn.disabled = !(hasWriteSupport() && countMovable(starSet) > 0);
}

async function ensureUniqueName(dirHandle, name) {
  const m = name.match(/^(.*?)(\.[^.]*)?$/);
  const base = m?.[1] ?? name;
  const ext  = m?.[2] ?? '';
  let candidate = name;
  let i = 1;
  while (true) {
    try {
      await dirHandle.getFileHandle(candidate, { create: false });
      candidate = `${base} (${i})${ext}`;
      i++;
    } catch { return candidate; }
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
  if (!hasWriteSupport()) {
    alert(`Para mover archivos necesitas abrir una CARPETA con "Abrir carpeta".`);
    return;
  }
  const movable = [];
  for (const k of set) {
    const it = itemByKey.get(k);
    if (it?.dirHandle && it?.fileHandle && !isManaged(it)) movable.push(it);
  }
  if (movable.length === 0) {
    alert('No hay elementos marcados con permisos de escritura (o ya están gestionados). Usa "Abrir carpeta".');
    return;
  }

  const targetDir = await rootDirHandle.getDirectoryHandle(folderName, { create: true });

  let ok = 0, fail = 0;
  progressEl.textContent = `Moviendo ${movable.length} foto(s) a /${folderName}…`;

  for (let i = 0; i < movable.length; i++) {
    const it = movable[i];
    try {
      progressEl.textContent = `Moviendo (${i+1}/${movable.length}): ${it.relPath || it.name}`;

      const oldKey = keyFor(it);
      const dstName = await moveOne(it, targetDir);

      const dstHandle = await targetDir.getFileHandle(dstName, { create: false });
      const dstFile = await dstHandle.getFile();

      it.file = dstFile;
      it.name = dstName;
      it.size = dstFile.size || it.size;
      it.fileHandle = dstHandle;
      it.dirHandle = targetDir;
      it.relPath = `${folderName}/${dstName}`;
      it.managed = (folderName === 'trash') ? 'trash' : (folderName === 'ideas') ? 'ideas' : 'selected';

      itemByKey.delete(oldKey);
      const newKey = keyFor(it);
      itemByKey.set(newKey, it);
      trashSet.delete(oldKey);
      starSet.delete(oldKey);
      ideaSet.delete(oldKey);

      ok++;
    } catch (err) {
      console.error('Fallo moviendo', it.name, err); fail++;
    }
  }

  buildGroups();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState();
  renderPage(currentPage);
  updateListSelectionUI();
  updateActionButtons();
  updateCountersUI();

  progressEl.textContent = `Listo: movidas ${ok} foto(s) a /${folderName}` + (fail ? ` · ${fail} fallida(s)` : '');
}

async function moveMarkedToTrash() { return moveMarkedTo('trash', trashSet); }
async function moveMarkedToIdeas() { return moveMarkedTo('ideas', ideaSet); }
async function moveMarkedToSelected() { return moveMarkedTo('selected', starSet); }

/* ---------- Eventos UI ---------- */
pickDirBtn.addEventListener('click', loadFromDirectory);
pickFilesInput.addEventListener('change', (e)=> loadFiles(e.target.files));
minutesInput.addEventListener('change', reBucketOnWindowChange);
exportBtn.addEventListener('click', exportSelection);
moveBtn.addEventListener('click', moveMarkedToTrash);
moveIdeasBtn.addEventListener('click', moveMarkedToIdeas);
moveSelectedBtn.addEventListener('click', moveMarkedToSelected);

toggleManagedInput.addEventListener('change', () => {
  showManaged = !!toggleManagedInput.checked;
  // Regenerar buckets respetando el filtro y refrescar
  buildGroups();
  currentPage = Math.min(currentPage, totalPages());
  updatePagerState();
  renderPage(currentPage);
  updateListSelectionUI();
  // Si el overlay estaba abierto, refrescarlo
  if (!overlay.hidden && currentOverlayIndex !== null) {
    const vis = currentVisibleOverlayItems();
    if (vis.length === 0) { // el bucket visible se ha quedado vacío
      // mantenemos el overlay abierto mostrando 0 elementos
      overlaySelIdx = 0;
      renderOverlay();
    } else {
      overlaySelIdx = Math.min(overlaySelIdx, vis.length - 1);
      renderOverlay();
    }
  }
});

firstBtn.addEventListener('click', ()=> goToPage(1));
prevBtn.addEventListener('click', ()=> goToPage(currentPage - 1));
nextBtn.addEventListener('click', ()=> goToPage(currentPage + 1));
lastBtn.addEventListener('click', ()=> goToPage(totalPages()));
pageInput.addEventListener('change', ()=> {
  const n = parseInt(pageInput.value || '1', 10);
  goToPage(isNaN(n) ? 1 : n);
});

/* ---------- Teclado global ---------- */
function isOverlayOpen(){ return !overlay.hidden; }

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  if (isViewerOpen()) { viewerKeydown(e); return; }
  if (isOverlayOpen()) { overlayKeydown(e); return; }

  const vis = visibleItemsForBucket(selBucketAbsIndex);
  switch (e.key) {
    case ' ': e.preventDefault(); openBucket(selBucketAbsIndex); break;
    case 'ArrowUp':
      if (listMode === 'bucket') { e.preventDefault(); setSelectedBucket(selBucketAbsIndex - 1); }
      else { const grid = getBucketGrid(selBucketAbsIndex); const cols = getGridCols(grid); e.preventDefault(); if (vis.length) setSelectedPhoto(selPhotoIndex - cols); }
      break;
    case 'ArrowDown':
      if (listMode === 'bucket') { e.preventDefault(); setSelectedBucket(selBucketAbsIndex + 1); }
      else { const grid = getBucketGrid(selBucketAbsIndex); const cols = getGridCols(grid); e.preventDefault(); if (vis.length) setSelectedPhoto(selPhotoIndex + cols); }
      break;
    case 'ArrowLeft':
      if (vis) { e.preventDefault(); if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); } else if (vis.length) { setSelectedPhoto(selPhotoIndex - 1); } }
      break;
    case 'ArrowRight':
      if (vis) { e.preventDefault(); if (listMode === 'bucket') { listMode = 'photo'; selPhotoIndex = 0; updateListSelectionUI(); } else if (vis.length) { setSelectedPhoto(selPhotoIndex + 1); } }
      break;
    case 'Escape':
      if (listMode === 'photo') { e.preventDefault(); listMode = 'bucket'; updateListSelectionUI(); }
      break;
    case 'x': case 'X':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault();
        const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const grid = getBucketGrid(selBucketAbsIndex);
        const fig = grid?.children[selPhotoIndex];
        const node = (fig?.classList?.contains('item')) ? fig : fig?.querySelector('.item');
        if (node) { const key = keyFor(it); toggleTrash(key, node); updateListSelectionUI(true); }
      } break;
    case 'z': case 'Z':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault();
        const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const grid = getBucketGrid(selBucketAbsIndex);
        const fig = grid?.children[selPhotoIndex];
        const node = (fig?.classList?.contains('item')) ? fig : fig?.querySelector('.item');
        if (node) { const key = keyFor(it); toggleStar(key, node); updateListSelectionUI(true); }
      } break;
    case 'i': case 'I':
      if (listMode === 'photo' && vis.length) {
        e.preventDefault();
        const it = vis[selPhotoIndex]; if (!it || isManaged(it)) break;
        const grid = getBucketGrid(selBucketAbsIndex);
        const fig = grid?.children[selPhotoIndex];
        const node = (fig?.classList?.contains('item')) ? fig : fig?.querySelector('.item');
        if (node) { const key = keyFor(it); toggleIdea(key, node); updateListSelectionUI(true); }
      } break;
    case 'r': case 'R':
      if (vis.length) {
        e.preventDefault();
        vis.forEach((it, idx) => {
          if (isManaged(it)) return;
          const key = keyFor(it);
          if (!starSet.has(key)) {
            trashSet.add(key); starSet.delete(key); ideaSet.delete(key);
            const grid = getBucketGrid(selBucketAbsIndex);
            const fig = grid?.children[idx];
            const node = (fig?.classList?.contains('item')) ? fig : fig?.querySelector('.item');
            if (node) applyItemClasses(node, it);
          }
        });
        updateActionButtons();
        updateListSelectionUI(true);
        updateCountersUI();
      }
      break;
    case 'p': case 'P':
      if (vis.length) {
        e.preventDefault();
        vis.forEach((it, idx) => {
          if (isManaged(it)) return;
          const key = keyFor(it);
          if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) {
            starSet.add(key); trashSet.delete(key); ideaSet.delete(key);
            const grid = getBucketGrid(selBucketAbsIndex);
            const fig = grid?.children[idx];
            const node = (fig?.classList?.contains('item')) ? fig : fig?.querySelector('.item');
            if (node) applyItemClasses(node, it);
          }
        });
        updateActionButtons();
        updateListSelectionUI(true);
        updateCountersUI();
      }
      break;
  }
});

/* --- Overlay key handling --- */
function overlayKeydown(e) {
  if (currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const total = vis.length;
  const cols = getGridCols(overlayGrid);

  switch (e.key) {
    case 'Escape': hideOverlay(); break;
    case ' ': e.preventDefault(); if (isViewerOpen()) closeViewer(); else openViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;

    case 'ArrowDown': {
      e.preventDefault();
      const next = overlaySelIdx + cols;
      if (next <= total - 1) setOverlaySelected(next);
      else {
        if (overlaySelIdx !== total - 1) { setOverlaySelected(total - 1); overlayEdgeIntent = 'down'; }
        else {
          if (overlayEdgeIntent === 'down' && currentOverlayIndex < groups.length - 1) {
            currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay();
          } else overlayEdgeIntent = 'down';
        }
      }
      break;
    }
    case 'ArrowUp': {
      e.preventDefault();
      const prev = overlaySelIdx - cols;
      if (prev >= 0) setOverlaySelected(prev);
      else {
        if (overlaySelIdx !== 0) { setOverlaySelected(0); overlayEdgeIntent = 'up'; }
        else {
          if (overlayEdgeIntent === 'up' && currentOverlayIndex > 0) {
            currentOverlayIndex--; const len = visibleItemsForBucket(currentOverlayIndex).length;
            overlaySelIdx = Math.max(0, len - 1); overlayEdgeIntent = null; renderOverlay();
          } else overlayEdgeIntent = 'up';
        }
      }
      break;
    }

    case 'x': case 'X': {
      e.preventDefault();
      const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break;
      const key = keyFor(it);
      const fig = overlayGrid.children[overlaySelIdx];
      toggleTrash(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState();
      overlayEdgeIntent = null;
      break;
    }
    case 'z': case 'Z': {
      e.preventDefault();
      const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break;
      const key = keyFor(it);
      const fig = overlayGrid.children[overlaySelIdx];
      toggleStar(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState();
      overlayEdgeIntent = null;
      break;
    }
    case 'i': case 'I': {
      e.preventDefault();
      const it = vis[overlaySelIdx]; if (!it || isManaged(it)) break;
      const key = keyFor(it);
      const fig = overlayGrid.children[overlaySelIdx];
      toggleIdea(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState();
      overlayEdgeIntent = null;
      break;
    }
    case 'r': case 'R': {
      e.preventDefault();
      vis.forEach((it, idx) => {
        if (isManaged(it)) return;
        const key = keyFor(it);
        if (!starSet.has(key)) {
          trashSet.add(key); starSet.delete(key); ideaSet.delete(key);
          const fig = overlayGrid.children[idx];
          if (fig) applyItemClasses(fig, it);
        }
      });
      updateActionButtons();
      overlayEdgeIntent = null;
      updateViewerButtonsState();
      updateCountersUI();
      break;
    }
    case 'p': case 'P': {
      e.preventDefault();
      vis.forEach((it, idx) => {
        if (isManaged(it)) return;
        const key = keyFor(it);
        if (!trashSet.has(key) && !ideaSet.has(key) && !starSet.has(key)) {
          starSet.add(key); trashSet.delete(key); ideaSet.delete(key);
          const fig = overlayGrid.children[idx];
          if (fig) applyItemClasses(fig, it);
        }
      });
      updateActionButtons();
      overlayEdgeIntent = null;
      updateViewerButtonsState();
      updateCountersUI();
      break;
    }
  }
}

/* --- Viewer key handling --- */
function viewerKeydown(e){
  if (!isViewerOpen() || currentOverlayIndex === null) return;
  const vis = currentVisibleOverlayItems();
  const it = vis[overlaySelIdx];
  const locked = it ? isManaged(it) : true;

  switch (e.key) {
    case ' ': e.preventDefault(); closeViewer(); break;
    case 'ArrowLeft': e.preventDefault(); setOverlaySelected(overlaySelIdx - 1); break;
    case 'ArrowRight': e.preventDefault(); setOverlaySelected(overlaySelIdx + 1); break;

    case 'x': case 'X':
      if (!locked && it) {
        e.preventDefault();
        const key = keyFor(it);
        const fig = overlayGrid.children[overlaySelIdx];
        toggleTrash(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI();
      }
      break;
    case 'z': case 'Z':
      if (!locked && it) {
        e.preventDefault();
        const key = keyFor(it);
        const fig = overlayGrid.children[overlaySelIdx];
        toggleStar(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI();
      }
      break;
    case 'i': case 'I':
      if (!locked && it) {
        e.preventDefault();
        const key = keyFor(it);
        const fig = overlayGrid.children[overlaySelIdx];
        toggleIdea(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState();
      }
      break;
    case 'r': case 'R':
      if (!locked && vis.length) {
        e.preventDefault();
        vis.forEach((it2, idx) => {
          if (isManaged(it2)) return;
          const key = keyFor(it2);
          if (!starSet.has(key)) {
            trashSet.add(key); starSet.delete(key); ideaSet.delete(key);
            const fig = overlayGrid.children[idx];
            if (fig) applyItemClasses(fig, it2);
          }
        });
        updateActionButtons();
        updateViewerButtonsState();
        updateCountersUI();
      }
      break;
    case 'Escape': e.preventDefault(); closeViewer(); break;
  }
}

/* ---------- Botones overlay ---------- */
overlayClose.addEventListener('click', () => hideOverlay());
overlayPrev .addEventListener('click', () => {
  if (currentOverlayIndex > 0) { currentOverlayIndex--; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); }
});
overlayNext .addEventListener('click', () => {
  if (currentOverlayIndex < groups.length - 1) { currentOverlayIndex++; overlaySelIdx = 0; overlayEdgeIntent = null; renderOverlay(); }
});

/* ---------- Botones visor ---------- */
viewerBtnTrash.addEventListener('click', () => {
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx];
  if (!it || isManaged(it)) return;
  const key = keyFor(it);
  const fig = overlayGrid.children[overlaySelIdx];
  toggleTrash(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI();
});
viewerBtnStar.addEventListener('click', () => {
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx];
  if (!it || isManaged(it)) return;
  const key = keyFor(it);
  const fig = overlayGrid.children[overlaySelIdx];
  toggleStar(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState(); updateCountersUI();
});
viewerBtnIdea.addEventListener('click', () => {
  const vis = currentVisibleOverlayItems(); const it = vis[overlaySelIdx];
  if (!it || isManaged(it)) return;
  const key = keyFor(it);
  const fig = overlayGrid.children[overlaySelIdx];
  toggleIdea(key, fig); syncOverlayAria(overlaySelIdx); updateViewerButtonsState();
});

/* ---------- Inicial ---------- */
renderPage(currentPage);
updateListSelectionUI();
updateActionButtons();
updateCountersUI();

/* utilidades consola */
Object.assign(window, { allItems, groups, openBucket, moveMarkedToTrash, moveMarkedToIdeas });
