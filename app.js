'use strict';
/* =========================================================
   Luthfi Music Web App — core logic
   No fake/mock behavior: every feature below either really
   works client-side, or is clearly labeled as needing your
   own Google credentials / browser support.
========================================================= */

/* ---------- tiny IndexedDB wrapper ---------- */
const DB_NAME = 'luthfi-music-db';
const DB_VERSION = 1;
let dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function idbGet(store, key) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly').objectStore(store).get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => rej(tx.error);
  });
}
async function idbSet(store, key, value) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
    tx.onsuccess = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function idbPut(store, value) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite').objectStore(store).put(value);
    tx.onsuccess = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function idbDelete(store, key) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    tx.onsuccess = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function idbAll(store) {
  const db = await dbPromise;
  return new Promise((res, rej) => {
    const out = [];
    const cursorReq = db.transaction(store, 'readonly').objectStore(store).openCursor();
    cursorReq.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); } else res(out);
    };
    cursorReq.onerror = () => rej(cursorReq.error);
  });
}
async function idbClearAll() {
  const db = await dbPromise;
  ['kv', 'tracks', 'blobs', 'playlists'].forEach(s => db.transaction(s, 'readwrite').objectStore(s).clear());
}

/* ---------- global state ---------- */
let tracks = [];          // unified library: {id, source, title, artist, album, mimeType, coverUrl, fileId, url, addedAt}
let playlists = [];       // {id, name, trackIds:[]}
let queue = [];           // array of track ids, current playback order
let queuePos = -1;
let isPlaying = false;
let isShuffle = false;
let repeatMode = 'off';   // off | one | all
let currentView = 'view-library';
let currentPlaylistId = null;
let objectUrlCache = new Map(); // trackId -> objectURL (revoked on demand)
const audio = new Audio();
audio.preload = 'metadata';

const $ = (id) => document.getElementById(id);

/* =========================================================
   SETTINGS (Google credentials, stored locally only)
========================================================= */
async function loadSettings() {
  const clientId = (await idbGet('kv', 'googleClientId')) || '';
  const apiKey = (await idbGet('kv', 'googleApiKey')) || '';
  const folderId = (await idbGet('kv', 'driveFolderId')) || '';
  const folderName = (await idbGet('kv', 'driveFolderName')) || '';
  $('settings-client-id').value = clientId;
  $('settings-api-key').value = apiKey;
  $('current-folder-name').textContent = folderName || 'None selected';
  return { clientId, apiKey, folderId, folderName };
}

$('save-settings-btn').addEventListener('click', async () => {
  await idbSet('kv', 'googleClientId', $('settings-client-id').value.trim());
  await idbSet('kv', 'googleApiKey', $('settings-api-key').value.trim());
  toast('Settings saved. Reloading…');
  setTimeout(() => location.reload(), 600);
});

$('clear-data-btn').addEventListener('click', async () => {
  if (!confirm('This removes all locally stored songs, playlists and settings from this browser. Continue?')) return;
  await idbClearAll();
  location.reload();
});

/* =========================================================
   TOAST
========================================================= */
function toast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast fixed top-5 left-1/2 -translate-x-1/2 px-5 py-3 rounded-full shadow-2xl z-[90] flex items-center gap-2 border text-sm ' +
    (isError ? 'bg-red-950 border-red-800 text-red-300' : 'bg-gray-800 border-gray-700 text-white');
  t.innerHTML = `<i class="fa-solid ${isError ? 'fa-triangle-exclamation text-red-400' : 'fa-circle-info text-accent'}"></i> ${msg}`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

/* =========================================================
   NAVIGATION
========================================================= */
const views = document.querySelectorAll('.view-section');
const navLinks = document.querySelectorAll('.nav-link');
const sidebar = $('sidebar');
const sidebarBackdrop = $('sidebar-backdrop');

function openSidebar() {
  sidebar.classList.remove('-translate-x-full');
  sidebarBackdrop.classList.add('show');
}
function closeSidebar() {
  sidebar.classList.add('-translate-x-full');
  sidebarBackdrop.classList.remove('show');
}
$('mobile-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  sidebar.classList.contains('-translate-x-full') ? openSidebar() : closeSidebar();
});
sidebarBackdrop.addEventListener('click', closeSidebar);
document.addEventListener('click', (e) => {
  if (window.innerWidth >= 768) return;
  if (sidebar.classList.contains('-translate-x-full')) return;
  if (sidebar.contains(e.target) || e.target === $('mobile-menu-btn') || $('mobile-menu-btn').contains(e.target)) return;
  closeSidebar();
});

function switchView(targetId) {
  currentView = targetId;
  views.forEach(v => v.classList.remove('active'));
  const el = $(targetId);
  if (el) el.classList.add('active');
  navLinks.forEach(l => {
    if (l.dataset.target === targetId) {
      l.classList.remove('text-gray-300');
      l.classList.add('text-accent', 'bg-[#2c2c2e]');
    } else {
      l.classList.add('text-gray-300');
      l.classList.remove('text-accent', 'bg-[#2c2c2e]');
    }
  });
  if (window.innerWidth < 768) closeSidebar();
  if (targetId === 'view-allsongs') renderAllSongs();
  if (targetId === 'view-queue') renderQueueView();
  if (targetId === 'view-tags') updateTagEditorOptions();
}
navLinks.forEach(link => link.addEventListener('click', (e) => { e.preventDefault(); switchView(link.dataset.target); }));

/* =========================================================
   LIBRARY: rendering
========================================================= */
function trackDisplayCover(t) {
  return t.coverUrl || '';
}

function trackRowHTML(t, idx, opts = {}) {
  const cover = trackDisplayCover(t);
  return `
  <div class="track-row group flex items-center gap-3 px-3 py-2 rounded-lg hover-panel cursor-pointer" data-track-id="${t.id}">
    <div class="w-6 text-center text-gray-500 text-sm row-index">${idx + 1}</div>
    <button class="w-6 h-6 items-center justify-center text-white row-play"><i class="fa-solid fa-play text-xs"></i></button>
    <div class="w-10 h-10 rounded bg-gray-800 overflow-hidden flex items-center justify-center flex-shrink-0">
      ${cover ? `<img src="${cover}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-music text-gray-600 text-xs"></i>`}
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium truncate ${opts.highlightPlaying ? '' : ''}">${escapeHtml(t.title)}</p>
      <p class="text-xs text-gray-500 truncate">${escapeHtml(t.artist)} ${t.source === 'drive' ? '· <i class=\"fa-brands fa-google-drive\"></i> Drive' : ''}</p>
    </div>
    <button class="ctx-btn text-gray-500 hover:text-white px-2" data-track-id="${t.id}"><i class="fa-solid fa-ellipsis"></i></button>
  </div>`;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function renderLibraryHome() {
  const empty = $('empty-state');
  const recentWrap = $('recent-tracks-title-wrap');
  const list = $('track-list');
  if (tracks.length === 0) {
    empty.style.display = '';
    recentWrap.classList.add('hidden');
    $('recently-played-wrap').classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  recentWrap.classList.remove('hidden');
  const recentAdded = [...tracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 15);
  list.innerHTML = recentAdded.map((t, i) => trackRowHTML(t, i)).join('');
  attachRowHandlers(list, recentAdded);
  renderRecentlyPlayedStrip();
}

async function renderRecentlyPlayedStrip() {
  const ids = (await idbGet('kv', 'recentlyPlayed')) || [];
  const strip = $('recent-strip');
  const wrap = $('recently-played-wrap');
  const found = ids.map(id => tracks.find(t => t.id === id)).filter(Boolean).slice(0, 12);
  if (found.length === 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  strip.innerHTML = found.map(t => `
    <div class="flex-shrink-0 w-32 cursor-pointer group" data-track-id="${t.id}">
      <div class="w-32 h-32 rounded-lg bg-gray-800 overflow-hidden mb-2 flex items-center justify-center relative">
        ${t.coverUrl ? `<img src="${t.coverUrl}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-music text-gray-600 text-2xl"></i>`}
        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
          <i class="fa-solid fa-play"></i>
        </div>
      </div>
      <p class="text-xs font-medium truncate">${escapeHtml(t.title)}</p>
      <p class="text-[11px] text-gray-500 truncate">${escapeHtml(t.artist)}</p>
    </div>`).join('');
  strip.querySelectorAll('[data-track-id]').forEach(el => {
    el.addEventListener('click', () => playFromList(found, found.findIndex(t => t.id === el.dataset.trackId)));
  });
}

function renderAllSongs() {
  const list = $('all-songs-list');
  const sorted = [...tracks].sort((a, b) => a.title.localeCompare(b.title));
  if (sorted.length === 0) {
    list.innerHTML = `<p class="text-gray-500 text-sm py-10 text-center">No songs yet.</p>`;
    return;
  }
  list.innerHTML = sorted.map((t, i) => trackRowHTML(t, i)).join('');
  attachRowHandlers(list, sorted);
}

function renderQueueView() {
  const list = $('queue-list');
  const qTracks = queue.map(id => tracks.find(t => t.id === id)).filter(Boolean);
  if (qTracks.length === 0) {
    list.innerHTML = `<p class="text-gray-500 text-sm py-10 text-center">Queue is empty.</p>`;
    return;
  }
  list.innerHTML = qTracks.map((t, i) => trackRowHTML(t, i)).join('');
  attachRowHandlers(list, qTracks, true);
}

function attachRowHandlers(container, list, isQueueContext = false) {
  container.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.ctx-btn')) return;
      const id = row.dataset.trackId;
      const idx = list.findIndex(t => t.id === id);
      if (isQueueContext) { queuePos = idx; loadAndPlay(queue[queuePos]); }
      else playFromList(list, idx);
    });
  });
  container.querySelectorAll('.ctx-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openTrackCtxMenu(e, btn.dataset.trackId); });
  });
}

function playFromList(list, startIdx) {
  queue = list.map(t => t.id);
  queuePos = startIdx;
  loadAndPlay(queue[queuePos]);
}

/* =========================================================
   CONTEXT MENU (add to playlist / remove / edit tags)
========================================================= */
function openTrackCtxMenu(evt, trackId) {
  const menu = $('ctx-menu');
  const t = tracks.find(x => x.id === trackId);
  if (!t) return;
  let html = `
    <button class="w-full text-left px-4 py-2 hover:bg-white/10" data-act="play">Play</button>
    <button class="w-full text-left px-4 py-2 hover:bg-white/10" data-act="playnext">Play Next</button>
    <div class="border-t border-gray-700 my-1"></div>
    <div class="px-4 py-1 text-xs text-gray-500">Add to Playlist</div>`;
  playlists.forEach(p => {
    html += `<button class="w-full text-left px-4 py-2 hover:bg-white/10" data-act="addpl" data-pl="${p.id}">${escapeHtml(p.name)}</button>`;
  });
  html += `
    <div class="border-t border-gray-700 my-1"></div>
    <button class="w-full text-left px-4 py-2 hover:bg-white/10" data-act="edittag">Edit Tags</button>
    <button class="w-full text-left px-4 py-2 hover:bg-white/10 text-red-400" data-act="remove">Remove from Library</button>`;
  menu.innerHTML = html;
  menu.classList.remove('hidden');
  const x = Math.min(evt.clientX, window.innerWidth - 230);
  const y = Math.min(evt.clientY, window.innerHeight - menu.offsetHeight - 100);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  menu.querySelectorAll('[data-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'play') playFromList(tracks, tracks.findIndex(x2 => x2.id === trackId));
      if (act === 'playnext') { queue.splice(queuePos + 1, 0, trackId); toast('Added to Up Next'); }
      if (act === 'addpl') { await addTrackToPlaylist(b.dataset.pl, trackId); toast('Added to playlist'); }
      if (act === 'edittag') { switchView('view-tags'); $('tag-track-select').value = trackId; $('tag-track-select').dispatchEvent(new Event('change')); }
      if (act === 'remove') await removeTrack(trackId);
      menu.classList.add('hidden');
    });
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu') && !e.target.closest('.ctx-btn')) $('ctx-menu').classList.add('hidden'); });

async function removeTrack(trackId) {
  tracks = tracks.filter(t => t.id !== trackId);
  await idbDelete('tracks', trackId);
  await idbDelete('blobs', trackId);
  playlists.forEach(p => p.trackIds = p.trackIds.filter(id => id !== trackId));
  for (const p of playlists) await idbPut('playlists', p);
  refreshAllViews();
}

/* =========================================================
   PLAYLISTS
========================================================= */
async function loadPlaylists() {
  playlists = await idbAll('playlists');
  renderPlaylistNav();
}
function renderPlaylistNav() {
  const nav = $('playlist-nav-list');
  nav.innerHTML = playlists.map(p => `
    <a href="#" data-pl="${p.id}" class="playlist-link flex items-center gap-3 px-3 py-2 rounded-md text-gray-400 hover:bg-[#2c2c2e] hover:text-white text-sm transition-colors truncate">
      <i class="fa-solid fa-list w-5 text-center"></i> ${escapeHtml(p.name)}
    </a>`).join('');
  nav.querySelectorAll('.playlist-link').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); openPlaylistDetail(a.dataset.pl); });
  });
}
function openPlaylistDetail(plId) {
  currentPlaylistId = plId;
  const p = playlists.find(x => x.id === plId);
  if (!p) return;
  switchView('view-playlist-detail');
  $('playlist-detail-title').textContent = p.name;
  $('playlist-detail-count').textContent = `${p.trackIds.length} song${p.trackIds.length === 1 ? '' : 's'}`;
  const list = p.trackIds.map(id => tracks.find(t => t.id === id)).filter(Boolean);
  const container = $('playlist-detail-list');
  container.innerHTML = list.length ? list.map((t, i) => trackRowHTML(t, i)).join('') :
    `<p class="text-gray-500 text-sm py-10 text-center">This playlist is empty. Use "Add to Playlist" from any song's menu.</p>`;
  attachRowHandlers(container, list);
}
$('delete-playlist-btn').addEventListener('click', async () => {
  if (!currentPlaylistId) return;
  if (!confirm('Delete this playlist?')) return;
  await idbDelete('playlists', currentPlaylistId);
  playlists = playlists.filter(p => p.id !== currentPlaylistId);
  renderPlaylistNav();
  switchView('view-library');
});
async function addTrackToPlaylist(plId, trackId) {
  const p = playlists.find(x => x.id === plId);
  if (!p) return;
  if (!p.trackIds.includes(trackId)) p.trackIds.push(trackId);
  await idbPut('playlists', p);
}
$('new-playlist-btn').addEventListener('click', () => { $('playlist-modal').classList.remove('hidden'); $('playlist-name-input').value = ''; $('playlist-name-input').focus(); });
$('playlist-modal-cancel').addEventListener('click', () => $('playlist-modal').classList.add('hidden'));
$('playlist-modal-create').addEventListener('click', async () => {
  const name = $('playlist-name-input').value.trim();
  if (!name) return;
  const p = { id: 'pl_' + Date.now(), name, trackIds: [] };
  await idbPut('playlists', p);
  playlists.push(p);
  renderPlaylistNav();
  $('playlist-modal').classList.add('hidden');
});

/* =========================================================
   SEARCH
========================================================= */
$('global-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { refreshAllViews(); return; }
  const filtered = tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q));
  switchView('view-allsongs');
  const list = $('all-songs-list');
  list.innerHTML = filtered.length ? filtered.map((t, i) => trackRowHTML(t, i)).join('') :
    `<p class="text-gray-500 text-sm py-10 text-center">No matches for "${escapeHtml(q)}".</p>`;
  attachRowHandlers(list, filtered);
});

/* =========================================================
   PLAYER CORE
========================================================= */
async function resolvePlayableUrl(track) {
  if (track.source === 'local') {
    if (objectUrlCache.has(track.id)) return objectUrlCache.get(track.id);
    const blob = await idbGet('blobs', track.id);
    if (!blob) throw new Error('Local file data missing — please re-add this file.');
    const url = URL.createObjectURL(blob);
    objectUrlCache.set(track.id, url);
    return url;
  }
  if (track.source === 'url') return track.url;
  if (track.source === 'drive') {
    const token = getAccessToken();
    if (!token) throw new Error('Connect Google Drive to play this track.');
    if (objectUrlCache.has(track.id)) return objectUrlCache.get(track.id);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${track.fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Could not download this file from Drive (token may have expired — reconnect).');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    objectUrlCache.set(track.id, url);
    return url;
  }
  throw new Error('Unknown track source.');
}

async function loadAndPlay(trackId) {
  const t = tracks.find(x => x.id === trackId);
  if (!t) return;
  try {
    const url = await resolvePlayableUrl(t);
    audio.src = url;
    await audio.play();
    isPlaying = true;
    updatePlayIcon();
    updateNowPlayingUI(t);
    updateMediaSession(t);
    pushRecentlyPlayed(t.id);
    idbSet('kv', 'lastTrackId', t.id);
  } catch (err) {
    toast(err.message || 'Could not play this track.', true);
  }
}

async function pushRecentlyPlayed(id) {
  let ids = (await idbGet('kv', 'recentlyPlayed')) || [];
  ids = [id, ...ids.filter(x => x !== id)].slice(0, 20);
  await idbSet('kv', 'recentlyPlayed', ids);
}

function updateNowPlayingUI(t) {
  $('player-title').textContent = t.title;
  $('player-artist').textContent = t.artist;
  const img = $('player-cover'), icon = $('player-cover-icon');
  if (t.coverUrl) { img.src = t.coverUrl; img.classList.remove('hidden'); icon.classList.add('hidden'); }
  else { img.classList.add('hidden'); icon.classList.remove('hidden'); }
}

function updatePlayIcon() {
  const cls = isPlaying ? 'fa-pause' : 'fa-play ml-0.5';
  $('play-icon').className = 'fa-solid ' + cls;
  $('play-icon-m').className = 'fa-solid ' + cls;
}

function togglePlay() {
  if (!audio.src) { if (tracks.length) playFromList(tracks, 0); return; }
  if (audio.paused) { audio.play(); isPlaying = true; } else { audio.pause(); isPlaying = false; }
  updatePlayIcon();
}
[$('btn-play'), $('btn-play-m')].forEach(b => b.addEventListener('click', togglePlay));

function playNext(auto = false) {
  if (queue.length === 0) return;
  if (repeatMode === 'one' && auto) { loadAndPlay(queue[queuePos]); return; }
  if (isShuffle) { queuePos = Math.floor(Math.random() * queue.length); }
  else { queuePos++; }
  if (queuePos >= queue.length) {
    if (repeatMode === 'all') queuePos = 0;
    else { queuePos = queue.length - 1; isPlaying = false; updatePlayIcon(); return; }
  }
  loadAndPlay(queue[queuePos]);
}
function playPrev() {
  if (queue.length === 0) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  queuePos = Math.max(0, queuePos - 1);
  loadAndPlay(queue[queuePos]);
}
[$('btn-next'), $('btn-next-m')].forEach(b => b.addEventListener('click', () => playNext(false)));
[$('btn-prev'), $('btn-prev-m')].forEach(b => b.addEventListener('click', playPrev));

$('btn-shuffle').addEventListener('click', () => { isShuffle = !isShuffle; $('btn-shuffle').classList.toggle('text-accent', isShuffle); });
$('btn-repeat').addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  const btn = $('btn-repeat');
  btn.classList.toggle('text-accent', repeatMode !== 'off');
  btn.innerHTML = repeatMode === 'one' ? '<i class="fa-solid fa-1"></i>' : '<i class="fa-solid fa-repeat"></i>';
});
$('btn-queue').addEventListener('click', () => switchView('view-queue'));
$('btn-add-current-playlist').addEventListener('click', (e) => {
  const t = tracks.find(x => x.id === queue[queuePos]);
  if (t) openTrackCtxMenu({ clientX: e.clientX, clientY: e.clientY }, t.id);
});

audio.addEventListener('timeupdate', () => {
  if (!isFinite(audio.duration)) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('progress-bar').value = pct || 0;
  $('progress-bar').style.background = `linear-gradient(to right, #fff ${pct}%, #444 ${pct}%)`;
  $('time-current').textContent = fmtTime(audio.currentTime);
  $('time-total').textContent = fmtTime(audio.duration);
});
audio.addEventListener('ended', () => playNext(true));
$('progress-bar').addEventListener('input', (e) => {
  if (isFinite(audio.duration)) audio.currentTime = (e.target.value / 100) * audio.duration;
});
$('volume-bar').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/* Media Session — lock screen controls / background metadata */
function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || '',
    artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '512x512', type: 'image/png' }] : []
  });
  navigator.mediaSession.setActionHandler('play', () => togglePlay());
  navigator.mediaSession.setActionHandler('pause', () => togglePlay());
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
  navigator.mediaSession.setActionHandler('seekto', (details) => { if (details.seekTime != null) audio.currentTime = details.seekTime; });
}

function refreshAllViews() {
  renderLibraryHome();
  if (currentView === 'view-allsongs') renderAllSongs();
  if (currentView === 'view-queue') renderQueueView();
  updateTagEditorOptions();
}

/* =========================================================
   LOCAL FILE IMPORT (with real ID3 read via jsmediatags)
========================================================= */
async function ingestLocalFile(file) {
  const id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const meta = await readTagsFromBlob(file).catch(() => null);
  const track = {
    id, source: 'local', title: (meta && meta.title) || stripExt(file.name),
    artist: (meta && meta.artist) || 'Unknown Artist',
    album: (meta && meta.album) || '', mimeType: file.type || 'audio/mpeg',
    fileName: file.name, addedAt: Date.now(), coverUrl: null
  };
  if (meta && meta.pictureBlob) track.coverUrl = URL.createObjectURL(meta.pictureBlob);
  await idbSet('blobs', id, file);
  await idbPut('tracks', track);
  tracks.push(track);
  return track;
}
function stripExt(name) { return name.replace(/\.[^/.]+$/, ''); }

function readTagsFromBlob(blob) {
  return new Promise((resolve, reject) => {
    if (!window.jsmediatags) return reject('no jsmediatags');
    window.jsmediatags.read(blob, {
      onSuccess: (tag) => {
        const t = tag.tags || {};
        let pictureBlob = null;
        if (t.picture) {
          const { data, format } = t.picture;
          pictureBlob = new Blob([new Uint8Array(data)], { type: format });
        }
        resolve({ title: t.title, artist: t.artist, album: t.album, pictureBlob });
      },
      onError: (err) => reject(err)
    });
  });
}

$('local-audio-upload').addEventListener('change', handleLocalUpload);
$('local-audio-upload-2').addEventListener('change', handleLocalUpload);
async function handleLocalUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  toast(`Importing ${files.length} file(s)…`);
  for (const f of files) await ingestLocalFile(f);
  e.target.value = '';
  refreshAllViews();
  toast('Import complete.');
}

/* URL import (legal alternative to a downloader) */
$('url-import-btn').addEventListener('click', async () => {
  const url = $('url-import-input').value.trim();
  if (!url) return;
  const btn = $('url-import-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Importing…';
  btn.disabled = true;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const blob = await res.blob();
    const fakeFile = new File([blob], url.split('/').pop() || 'audio.mp3', { type: blob.type || 'audio/mpeg' });
    await ingestLocalFile(fakeFile);
    refreshAllViews();
    toast('Track imported into your library.');
    $('url-import-input').value = '';
  } catch (err) {
    toast('Import failed — the URL likely blocks cross-origin requests (CORS). ' + err.message, true);
  } finally {
    btn.innerHTML = orig; btn.disabled = false;
  }
});

/* =========================================================
   TAG EDITOR (real read/write)
========================================================= */
let editorCoverBlob = null;
function updateTagEditorOptions() {
  const sel = $('tag-track-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">-- No tracks available --</option>' +
    tracks.map(t => `<option value="${t.id}">${escapeHtml(t.artist)} — ${escapeHtml(t.title)}</option>`).join('');
  if (current) sel.value = current;
}
$('tag-track-select').addEventListener('change', (e) => {
  const t = tracks.find(x => x.id === e.target.value);
  editorCoverBlob = null;
  $('cover-status').classList.add('hidden');
  $('cover-results').innerHTML = '';
  const coverBox = $('editor-cover');
  if (!t) { $('tag-title').value = ''; $('tag-artist').value = ''; $('tag-album').value = ''; coverBox.innerHTML = '<i class="fa-solid fa-compact-disc text-6xl text-gray-600"></i>'; return; }
  $('tag-title').value = t.title;
  $('tag-artist').value = t.artist;
  $('tag-album').value = t.album || '';
  coverBox.innerHTML = t.coverUrl ? `<img src="${t.coverUrl}" class="w-full h-full object-cover">` : '<i class="fa-solid fa-compact-disc text-6xl text-gray-600"></i>';
});

$('cover-upload-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  editorCoverBlob = f;
  $('editor-cover').innerHTML = `<img src="${URL.createObjectURL(f)}" class="w-full h-full object-cover">`;
  $('cover-status').classList.remove('hidden');
});

$('search-cover-btn').addEventListener('click', async () => {
  const artist = $('tag-artist').value.trim();
  const title = $('tag-title').value.trim();
  if (!artist && !title) { toast('Enter an artist or title first.', true); return; }
  const btn = $('search-cover-btn');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Searching…';
  btn.disabled = true;
  try {
    const term = encodeURIComponent(`${artist} ${title}`.trim());
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=6`);
    const data = await res.json();
    const results = (data.results || []).filter(r => r.artworkUrl100);
    if (!results.length) { toast('No cover art found on iTunes for this search.', true); return; }
    $('cover-results').innerHTML = results.map((r, i) => `
      <button class="cover-option rounded overflow-hidden border-2 border-transparent hover:border-accent" data-i="${i}">
        <img src="${r.artworkUrl100}" class="w-full h-full object-cover">
      </button>`).join('');
    $('cover-results').querySelectorAll('.cover-option').forEach(btnEl => {
      btnEl.addEventListener('click', async () => {
        const r = results[btnEl.dataset.i];
        const bigUrl = r.artworkUrl100.replace('100x100bb', '600x600bb');
        $('editor-cover').innerHTML = `<img src="${bigUrl}" class="w-full h-full object-cover">`;
        try {
          const imgRes = await fetch(bigUrl, { mode: 'cors' });
          editorCoverBlob = await imgRes.blob();
        } catch {
          editorCoverBlob = null;
          toast('Cover preview applied, but this image host blocks downloads (CORS) so it can\'t be embedded into the file — try "Upload" instead for embedding.', true);
        }
        $('cover-status').classList.remove('hidden');
      });
    });
  } catch (err) {
    toast('Cover search failed: ' + err.message, true);
  } finally {
    btn.innerHTML = orig; btn.disabled = false;
  }
});

$('save-tags-btn').addEventListener('click', async () => {
  const trackId = $('tag-track-select').value;
  if (!trackId) return;
  const t = tracks.find(x => x.id === trackId);
  if (!t) return;
  const newTitle = $('tag-title').value.trim();
  const newArtist = $('tag-artist').value.trim();
  const newAlbum = $('tag-album').value.trim();
  const statusEl = $('save-tags-status');
  statusEl.textContent = 'Writing tags…';
  try {
    let originalBlob;
    if (t.source === 'local') originalBlob = await idbGet('blobs', t.id);
    else if (t.source === 'drive') {
      const token = getAccessToken();
      if (!token) throw new Error('Reconnect Google Drive to edit this file.');
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${t.fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Could not download original file from Drive.');
      originalBlob = await res.blob();
    } else {
      throw new Error('This track type cannot be re-tagged (imported by URL, not stored as a file).');
    }

    const arrayBuffer = await originalBlob.arrayBuffer();
    const writer = new ID3Writer(arrayBuffer);
    writer.setFrame('TIT2', newTitle).setFrame('TPE1', [newArtist]).setFrame('TALB', newAlbum);
    if (editorCoverBlob) {
      const coverBuf = await editorCoverBlob.arrayBuffer();
      writer.setFrame('APIC', { type: 3, data: coverBuf, description: '', useUnicodeEncoding: false });
    }
    writer.addTag();
    const newBlob = writer.getBlob();

    if (t.source === 'local') {
      const written = await tryWriteLocalFile(t, newBlob);
      await idbSet('blobs', t.id, newBlob);
      if (!written) downloadBlob(newBlob, (t.fileName || newTitle) );
    } else if (t.source === 'drive') {
      await driveUpdateFileMedia(t.fileId, newBlob, originalBlob.type || 'audio/mpeg');
    }

    t.title = newTitle; t.artist = newArtist; t.album = newAlbum;
    if (editorCoverBlob) t.coverUrl = URL.createObjectURL(editorCoverBlob);
    objectUrlCache.delete(t.id);
    await idbPut('tracks', t);
    refreshAllViews();
    if (queue[queuePos] === t.id) updateNowPlayingUI(t);
    statusEl.textContent = 'Saved.';
    toast('Tags written to the file.');
  } catch (err) {
    statusEl.textContent = '';
    toast('Save failed: ' + err.message, true);
  }
});

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.match(/\.mp3$/i) ? filename : filename + '.mp3';
  a.click();
  toast('Your browser can\'t overwrite local files directly, so a corrected copy was downloaded — replace the original with it.');
}

async function tryWriteLocalFile(track, newBlob) {
  // File System Access API (Chrome/Edge desktop) lets us overwrite the exact file the user picked.
  if (!track.fileHandle || !window.showSaveFilePicker) return false;
  try {
    const writable = await track.fileHandle.createWritable();
    await writable.write(newBlob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   GOOGLE DRIVE — auth, picker, sync, read/write
========================================================= */
let gapiInited = false, gisInited = false, tokenClient = null, accessToken = null, tokenExpiry = 0;
let driveFolderId = null, driveFolderName = null, autoSyncTimer = null;
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return null;
}

window.__gapiLoaded = function () { gapi.load('client:picker', initGapiClient); };
window.__gisLoaded = function () { gisInited = true; maybeEnableAuth(); };

async function initGapiClient() {
  const { apiKey } = await loadSettingsSilently();
  try {
    await gapi.client.init({ apiKey: apiKey || undefined, discoveryDocs: [DISCOVERY_DOC] });
    gapiInited = true;
  } catch (e) { console.error('gapi init failed', e); }
  maybeEnableAuth();
}
async function loadSettingsSilently() {
  return {
    clientId: (await idbGet('kv', 'googleClientId')) || '',
    apiKey: (await idbGet('kv', 'googleApiKey')) || ''
  };
}

async function maybeEnableAuth() {
  const { clientId, apiKey } = await loadSettingsSilently();
  const btn = $('auth-btn');
  if (!clientId || !apiKey) {
    btn.disabled = true;
    $('gdrive-account-text').textContent = 'Add your Client ID & API Key in Settings first';
    return;
  }
  if (gapiInited && gisInited) {
    btn.disabled = false;
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: DRIVE_SCOPE, callback: '' // set per-request
      });
    }
  }
}

$('auth-btn').addEventListener('click', () => {
  if (!tokenClient) { toast('Google auth not ready yet — try again in a second.', true); return; }
  tokenClient.callback = async (resp) => {
    if (resp.error) { toast('Google sign-in failed: ' + resp.error, true); return; }
    accessToken = resp.access_token;
    tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
    await onDriveConnected();
  };
  tokenClient.requestAccessToken({ prompt: '' });
});

$('signout-btn').addEventListener('click', () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null; tokenExpiry = 0;
  clearInterval(autoSyncTimer);
  $('gdrive-account-text').textContent = 'Not connected';
  $('auth-btn').classList.remove('hidden');
  $('pick-folder-btn').classList.add('hidden');
  $('sync-btn').classList.add('hidden');
  $('signout-btn').classList.add('hidden');
});

async function onDriveConnected() {
  $('gdrive-account-text').textContent = 'Connected';
  $('auth-btn').classList.add('hidden');
  $('pick-folder-btn').classList.remove('hidden');
  $('signout-btn').classList.remove('hidden');
  driveFolderId = (await idbGet('kv', 'driveFolderId')) || null;
  driveFolderName = (await idbGet('kv', 'driveFolderName')) || null;
  if (driveFolderId) {
    $('sync-btn').classList.remove('hidden');
    $('current-folder-name').textContent = driveFolderName || driveFolderId;
    syncDriveFolder();
  }
  toast('Google Drive connected.');
}

$('pick-folder-btn').addEventListener('click', async () => {
  const { apiKey } = await loadSettingsSilently();
  const token = getAccessToken();
  if (!token) { toast('Connect your Google account first.', true); return; }
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setSelectFolderEnabled(true).setIncludeFolders(true);
  const picker = new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(token)
    .setDeveloperKey(apiKey)
    .setCallback(async (data) => {
      if (data.action === google.picker.Action.PICKED) {
        const folder = data.docs[0];
        driveFolderId = folder.id; driveFolderName = folder.name;
        await idbSet('kv', 'driveFolderId', driveFolderId);
        await idbSet('kv', 'driveFolderName', driveFolderName);
        $('current-folder-name').textContent = driveFolderName;
        $('sync-btn').classList.remove('hidden');
        syncDriveFolder();
      }
    })
    .build();
  picker.setVisible(true);
});

$('sync-btn').addEventListener('click', () => syncDriveFolder());
$('auto-sync-toggle').addEventListener('change', (e) => {
  clearInterval(autoSyncTimer);
  if (e.target.checked) autoSyncTimer = setInterval(() => syncDriveFolder(true), 45000);
});

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i;

async function syncDriveFolder(silent = false) {
  if (!driveFolderId) { toast('Choose a Drive folder first.', true); return; }
  const token = getAccessToken();
  if (!token) { toast('Reconnect your Google account — the session expired.', true); return; }
  if (!silent) { $('sync-status').classList.remove('hidden'); $('sync-status').classList.add('flex'); }
  try {
    const q = encodeURIComponent(`'${driveFolderId}' in parents and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=1000`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Drive API returned ' + res.status);
    const data = await res.json();
    const audioFiles = (data.files || []).filter(f => f.mimeType.startsWith('audio/') || AUDIO_EXT.test(f.name));

    const existingIds = new Set(tracks.filter(t => t.source === 'drive').map(t => t.fileId));
    let added = 0;
    for (const f of audioFiles) {
      if (existingIds.has(f.id)) continue;
      const track = {
        id: 'drive_' + f.id, source: 'drive', fileId: f.id,
        title: stripExt(f.name), artist: 'Unknown Artist', album: '',
        mimeType: f.mimeType, coverUrl: null, addedAt: Date.now(), driveModifiedTime: f.modifiedTime
      };
      await idbPut('tracks', track);
      tracks.push(track);
      added++;
      // Best-effort tag read in background (small head fetch would be ideal; for simplicity, skip auto-parsing large files here)
    }
    $('drive-files-list').innerHTML = audioFiles.length
      ? audioFiles.map(f => `<div class="flex items-center gap-2 py-1"><i class="fa-solid fa-file-audio text-gray-500"></i> ${escapeHtml(f.name)}</div>`).join('')
      : 'No audio files found in this folder.';
    if (added > 0) { refreshAllViews(); toast(`${added} new track(s) synced from Drive.`); }
    else if (!silent) toast('Everything is already in sync.');
  } catch (err) {
    toast('Drive sync failed: ' + err.message, true);
  } finally {
    $('sync-status').classList.add('hidden'); $('sync-status').classList.remove('flex');
  }
}

async function driveUpdateFileMedia(fileId, blob, mimeType) {
  const token = getAccessToken();
  if (!token) throw new Error('Reconnect Google Drive.');
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'audio/mpeg' },
    body: blob
  });
  if (!res.ok) throw new Error('Drive update failed (' + res.status + ')');
}

/* =========================================================
   BOOTSTRAP
========================================================= */
async function boot() {
  await loadSettings();
  await loadPlaylists();
  tracks = await idbAll('tracks');
  // rehydrate cover object URLs stay as stored (drive/http covers) — local blob covers were object URLs from this session only and are lost on reload, that's expected browser behavior.
  refreshAllViews();

  const lastId = await idbGet('kv', 'lastTrackId');
  if (lastId && tracks.find(t => t.id === lastId)) {
    queue = tracks.map(t => t.id);
    queuePos = queue.indexOf(lastId);
    updateNowPlayingUI(tracks.find(t => t.id === lastId));
  }

  registerServiceWorker();
  setupInstallPrompt();
}
boot();

/* =========================================================
   PWA install + service worker
========================================================= */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
}
let deferredInstallPrompt = null;
function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('install-pwa-btn').disabled = false;
  });
  $('install-pwa-btn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) { toast('Your browser doesn\'t support install prompts, or the app is already installed. Use the browser menu → "Install App" / "Add to Home Screen".'); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
}
