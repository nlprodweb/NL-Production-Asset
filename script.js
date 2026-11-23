'use strict';

// Tempel URL Web App Apps Script yang berakhiran /exec di bawah ini.
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzjFSm4n2XjOpzwZHalHa8KG1ZcpxmuZqdPug8mM16KKcoiq_St4Kh4lnr8vRYS0_o/exec';
const API_POLL_INTERVAL_MS = 1500;
const API_MESSAGE_SOURCE = 'nl-production-api';
const API_TOKEN_KEY = 'nlProduction.adminToken.v1';
const STORAGE_KEY = 'nlProduction.assets.v2';
const LEGACY_STORAGE_KEYS = ['trainz_assets', 'railworksStudio.assets.v1'];
const SESSION_KEY = 'nlProduction.adminSession.v1';

const clone = value => JSON.parse(JSON.stringify(value));
const makeId = () => `asset-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const today = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const padCount = value => String(value).padStart(2, '0');
const categoryLabel = category => ({ GD: 'Gerbong Datar', GB: 'Gerbong Barang', Commodity: 'Commodity' }[category] || category || 'Asset');

const DEFAULT_SITE_SETTINGS = {
  releaseInfoTitle: 'Informasi rilisan',
  releaseInfoText: 'Link yang berstatus Coming Soon belum bisa dibuka. Informasi versi, kompatibilitas, dan detail aset ditampilkan pada tombol detail setiap rilisan.',
  tickerEnabled: true,
  tickerText: 'Pantau informasi rilisan terbaru NL Production. Cek versi, kompatibilitas, dan status aset melalui Detail Asset. Rilisan Coming Soon akan diumumkan saat tersedia.',
  maintenanceEnabled: false,
  maintenanceTitle: 'Sedang Dalam Pemeliharaan',
  maintenanceMessage: 'Website NL Production sedang menjalani pemeliharaan. Silakan kembali beberapa saat lagi.'
};

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function isAdminPage() {
  if (document.body && document.body.dataset.page === 'admin') return true;
  const path = (window.location.pathname || '/').replace(/\/+$/, '');
  const hash = (window.location.hash || '').toLowerCase();
  const params = new URLSearchParams(window.location.search || '');
  return /\/admin(?:\.html)?$/i.test(path) || hash === '#/admin' || hash === '#admin' || params.has('admin');
}

function safeExternalUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeReleaseStatus(value, fallback = 'Available') {
  const status = String(value || '').toLowerCase().replace(/[ _]/g, '-');
  return ['coming-soon', 'comingsoon', 'soon'].includes(status) ? 'Coming Soon' : fallback;
}

function normalizePublication(item) {
  if (item.publishStatus === 'draft' || item.status === 'draft') return 'draft';
  if (item.publishStatus === 'published' || item.status === 'published') return 'published';
  return 'published';
}

function isApiConfigured() {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(GAS_WEB_APP_URL)
    && !GAS_WEB_APP_URL.includes('PASTE_APPS_SCRIPT_WEB_APP_URL_HERE');
}

function getAdminToken() {
  try { return sessionStorage.getItem(API_TOKEN_KEY) || ''; } catch (_) { return ''; }
}

function clearAdminSession() {
  isAdminLoggedIn = false;
  try {
    sessionStorage.removeItem(API_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}

function apiGetJsonp(action = 'listPublic') {
  if (!isApiConfigured()) return Promise.reject(new Error('URL Apps Script belum diatur di script.js.'));
  return new Promise((resolve, reject) => {
    const callbackName = `__nlProductionJsonp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const script = document.createElement('script');
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('Permintaan data ke Apps Script timeout.')), 18000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      script.remove();
      if (error) reject(error); else resolve(result);
    }
    window[callbackName] = result => finish(null, result);
    script.onerror = () => finish(new Error('Tidak bisa menghubungi Apps Script. Periksa URL Web App dan izin deployment.'));
    const separator = GAS_WEB_APP_URL.includes('?') ? '&' : '?';
    script.src = `${GAS_WEB_APP_URL}${separator}action=${encodeURIComponent(action)}&callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

function apiPost(action, payload = {}, token = '') {
  if (!isApiConfigured()) return Promise.reject(new Error('URL Apps Script belum diatur di script.js.'));
  return new Promise((resolve, reject) => {
    const requestId = `nlp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const frame = document.createElement('iframe');
    frame.name = `${requestId}_frame`;
    frame.title = 'Permintaan API NL Production';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'display:none;width:0;height:0;border:0';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = GAS_WEB_APP_URL;
    form.target = frame.name;
    form.acceptCharset = 'UTF-8';
    form.style.display = 'none';

    const fields = { action, payload: JSON.stringify(payload), token, requestId };
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = String(value ?? '');
      form.appendChild(input);
    }

    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('Apps Script tidak mengirim jawaban.')), 25000);
    function cleanup() {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      window.setTimeout(() => { frame.remove(); form.remove(); }, 150);
    }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    }
    function onMessage(event) {
      const message = event.data;
      let trustedGoogleOrigin = false;
      try {
        const originUrl = new URL(event.origin);
        trustedGoogleOrigin = originUrl.protocol === 'https:' && (
          originUrl.hostname === 'script.google.com' ||
          originUrl.hostname === 'googleusercontent.com' ||
          originUrl.hostname.endsWith('.googleusercontent.com')
        );
      } catch (_) {}
      const expectedFrame = event.source === frame.contentWindow;
      const opaqueSandboxOrigin = event.origin === 'null';
      if (!expectedFrame && !trustedGoogleOrigin && !opaqueSandboxOrigin) return;
      if (!message || message.source !== API_MESSAGE_SOURCE || message.requestId !== requestId) return;
      finish(null, message.result);
    }

    window.addEventListener('message', onMessage);
    document.body.append(frame, form);
    try { form.submit(); } catch (error) { finish(error); }
  });
}

function applyAssetSnapshot(list, options = {}) {
  if (!Array.isArray(list)) throw new Error('Format data dari Apps Script tidak valid.');
  const nextAssets = list.map(normalizeAsset);
  const changed = JSON.stringify(assets) !== JSON.stringify(nextAssets);
  assets = nextAssets;
  if (changed && options.persist !== false) persistAssets();
  if (changed || options.forceRender === true) {
    renderUserView();
    renderAdminView();
  }
  if (changed && options.broadcast === true && catalogSyncChannel) {
    try { catalogSyncChannel.postMessage({ type: 'assets-snapshot', assets: nextAssets, settings: clone(siteSettings) }); }
    catch (_) {}
  }
  return changed;
}

async function refreshPublicCatalog(showErrors = false) {
  if (!isApiConfigured() || isAdminLoggedIn || apiMutationInProgress) return false;
  const revisionAtStart = apiMutationRevision;
  try {
    const result = await apiGetJsonp('listPublic');
    if (revisionAtStart !== apiMutationRevision || apiMutationInProgress) return false;
    if (!result || !result.ok) throw new Error((result && result.error) || 'Gagal membaca katalog publik.');
    if (!isAdminLoggedIn) {
      applySiteSettings(result.settings || DEFAULT_SITE_SETTINGS);
      applyAssetSnapshot(result.assets || []);
    }
    apiErrorToastShown = false;
    return true;
  } catch (error) {
    if ((showErrors || !apiErrorToastShown) && isApiConfigured()) {
      showToast(`Sinkronisasi belum berhasil: ${error.message}`);
      apiErrorToastShown = true;
    }
    return false;
  }
}

async function refreshAdminData(showErrors = false) {
  const token = getAdminToken();
  if (!isApiConfigured() || !token || apiMutationInProgress) return false;
  const revisionAtStart = apiMutationRevision;
  try {
    const result = await apiPost('listAdmin', {}, token);
    if (revisionAtStart !== apiMutationRevision || apiMutationInProgress) return false;
    if (!result || !result.ok) {
      if (result && /sesi|token|login/i.test(result.error || '')) {
        clearAdminSession();
        syncViewVisibility();
      }
      throw new Error((result && result.error) || 'Gagal membaca data admin.');
    }
    isAdminLoggedIn = true;
    applySiteSettings(result.settings || DEFAULT_SITE_SETTINGS);
    applyAssetSnapshot(result.assets || [], { broadcast: true });
    syncViewVisibility();
    apiErrorToastShown = false;
    return true;
  } catch (error) {
    if (showErrors && !apiErrorToastShown) {
      showToast(`Sinkronisasi admin gagal: ${error.message}`);
      apiErrorToastShown = true;
    }
    return false;
  }
}

async function runAdminMutation(action, payload) {
  if (!isApiConfigured()) throw new Error('URL Apps Script belum dipasang di script.js.');
  const token = getAdminToken();
  if (!token || !isAdminLoggedIn) throw new Error('Sesi admin tidak ditemukan. Silakan login kembali.');
  if (apiMutationInProgress) throw new Error('Perubahan lain masih disimpan. Tunggu sebentar lalu coba lagi.');
  apiMutationRevision += 1;
  apiMutationInProgress = true;
  try {
    const result = await apiPost(action, payload, token);
    if (!result || !result.ok) throw new Error((result && result.error) || 'Operasi database gagal.');
    if (result.settings) applySiteSettings(result.settings);
    applyAssetSnapshot(result.assets || [], { broadcast: true });
    return result;
  } finally {
    apiMutationInProgress = false;
  }
}

const initialAssets = [
  {
    id: 'asset-commodity', name: 'Commodity', category: 'Commodity', version: 'v1.0',
    publishStatus: 'published', status: 'Available', date: '2026-10-16', format: 'Google Drive Folder',
    compatibility: 'Trainz Simulator',
    description: 'Kumpulan muatan commodity kustom untuk berbagai tipe gerbong. Pilih folder sesuai jenis muatan yang ingin diakses.',
    downloadUrl: '',
    folderLinks: [
      { name: 'Commodity Peternakan Dan Hasil Bumi', url: 'https://drive.google.com/drive/folders/1qOHiOs_YnDilhWJp7u3SUUvrvzVl7CFa?usp=sharing', status: 'Available' },
      { name: 'Commodity Industri & Tambang', url: '', status: 'Coming Soon' }
    ], moreInfoUrl: '', coverUrl: ''
  },
  {
    id: 'asset-gd-new-generation', name: 'GD New Generation', category: 'GD', version: 'v1.0',
    publishStatus: 'published', status: 'Available', date: '2026-10-16', format: 'Google Drive Folder',
    compatibility: 'Trainz Simulator 2022',
    description: 'Gerbong Datar varian New Generation untuk Trainz Simulator.',
    downloadUrl: 'https://drive.google.com/drive/folders/1gnTjFpf-EL757qpUpVRqOgfmQPxLqZxi?usp=drive_link',
    folderLinks: [], moreInfoUrl: '', coverUrl: ''
  },
  {
    id: 'asset-gd-biasa', name: 'GD Biasa', category: 'GD', version: 'TBA',
    publishStatus: 'published', status: 'Coming Soon', date: '', format: 'Google Drive Folder',
    compatibility: 'Trainz Simulator',
    description: 'Gerbong Datar versi standar. Rilisan ini masih disiapkan dan akan diumumkan ketika tersedia.',
    downloadUrl: 'https://drive.google.com/drive/folders/1ywTqeQ76YDeR2BDq4EkiLVuBsIWqJ16r?usp=drive_link',
    folderLinks: [], moreInfoUrl: '', coverUrl: ''
  },
  {
    id: 'asset-gb-ballast', name: 'GB Ballast', category: 'GB', version: 'v1.0',
    publishStatus: 'published', status: 'Available', date: '2026-10-16', format: 'Google Drive Folder',
    compatibility: 'Trainz Simulator 2022',
    description: 'Gerbong Barang untuk muatan kricak/ballast di Trainz Simulator.',
    downloadUrl: 'https://drive.google.com/drive/folders/1DW5NaNSosTom0BLVeC4bsic__Mc_P3ot?usp=drive_link',
    folderLinks: [], moreInfoUrl: '', coverUrl: ''
  }
];

function normalizeAsset(raw = {}) {
  const category = ['GD', 'GB', 'Commodity'].includes(raw.category) ? raw.category : 'Commodity';
  const rawName = String(raw.name || raw.title || 'Asset tanpa nama').trim() || 'Asset tanpa nama';
  const releaseStatus = raw.releaseState === 'coming-soon' ? 'Coming Soon'
    : normalizeReleaseStatus(raw.availability || raw.status, 'Available');
  const output = {
    id: String(raw.id ?? makeId()),
    name: rawName,
    category,
    version: String(raw.version || 'TBA'),
    publishStatus: normalizePublication(raw),
    status: releaseStatus,
    date: String(raw.date || ''),
    format: String(raw.format || 'Google Drive Folder'),
    compatibility: String(raw.compatibility || 'Trainz Simulator'),
    description: String(raw.description || raw.desc || ''),
    downloadUrl: safeExternalUrl(raw.downloadUrl || raw.link || ''),
    folderLinks: [],
    moreInfoUrl: safeExternalUrl(raw.moreInfoUrl || raw.previewUrl || ''),
    coverUrl: safeExternalUrl(raw.coverUrl || '')
  };

  const oldFolders = Array.isArray(raw.folderLinks) ? raw.folderLinks : (Array.isArray(raw.subfolders) ? raw.subfolders : []);
  output.folderLinks = oldFolders.map((folder, index) => {
    const url = safeExternalUrl(folder && (folder.url || folder.link));
    const folderStatus = folder && folder.status ? normalizeReleaseStatus(folder.status, url ? 'Available' : 'Coming Soon') : (url ? 'Available' : 'Coming Soon');
    return {
      name: String((folder && folder.name) || `Folder Tujuan ${index + 1}`).trim(),
      url,
      status: folderStatus === 'Available' && !url ? 'Coming Soon' : folderStatus
    };
  }).filter(folder => folder.name);

  if (category === 'Commodity' && rawName.toLowerCase() !== 'commodity') {
    if (output.downloadUrl && !output.folderLinks.some(folder => folder.url === output.downloadUrl)) {
      output.folderLinks.unshift({ name: rawName, url: output.downloadUrl, status: releaseStatus });
      output.downloadUrl = '';
    }
    output.name = 'Commodity';
  }
  return output;
}

function readStoredArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function loadAssets() {
  const current = readStoredArray(STORAGE_KEY);
  if (current) return current.map(normalizeAsset);
  for (const key of LEGACY_STORAGE_KEYS) {
    const legacy = readStoredArray(key);
    if (legacy) return legacy.map(normalizeAsset);
  }
  const fresh = clone(initialAssets);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)); } catch (_) {}
  return fresh;
}

let assets = loadAssets();
let siteSettings = clone(DEFAULT_SITE_SETTINGS);
let settingsFormDirty = false;
let currentFilter = 'all';
let catalogQuery = '';
let adminQuery = '';
let adminPublicationFilter = 'all';
let isAdminLoggedIn = false;
let toastTimer = null;
let apiMutationInProgress = false;
let apiMutationRevision = 0;
let apiPollInProgress = false;
let apiErrorToastShown = false;
let pendingDeleteId = null;
let pendingDeleteTimer = null;

const el = id => document.getElementById(id);

function normalizeSiteSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    releaseInfoTitle: String(source.releaseInfoTitle ?? DEFAULT_SITE_SETTINGS.releaseInfoTitle).slice(0, 80),
    releaseInfoText: String(source.releaseInfoText ?? DEFAULT_SITE_SETTINGS.releaseInfoText).slice(0, 1000),
    tickerEnabled: source.tickerEnabled !== false,
    tickerText: String(source.tickerText ?? DEFAULT_SITE_SETTINGS.tickerText).slice(0, 500),
    maintenanceEnabled: source.maintenanceEnabled === true,
    maintenanceTitle: String(source.maintenanceTitle ?? DEFAULT_SITE_SETTINGS.maintenanceTitle).slice(0, 100),
    maintenanceMessage: String(source.maintenanceMessage ?? DEFAULT_SITE_SETTINGS.maintenanceMessage).slice(0, 1000)
  };
}

function populateSettingsForm() {
  if (!el('site-settings-form')) return;
  el('release-info-title-input').value = siteSettings.releaseInfoTitle;
  el('release-info-text-input').value = siteSettings.releaseInfoText;
  el('ticker-enabled').checked = siteSettings.tickerEnabled;
  el('ticker-text-input').value = siteSettings.tickerText;
  el('maintenance-enabled').checked = siteSettings.maintenanceEnabled;
  el('maintenance-title-input').value = siteSettings.maintenanceTitle;
  el('maintenance-message-input').value = siteSettings.maintenanceMessage;
  settingsFormDirty = false;
}

function renderSiteChrome() {
  if (el('release-info-title')) el('release-info-title').textContent = siteSettings.releaseInfoTitle;
  if (el('release-info-text')) el('release-info-text').textContent = siteSettings.releaseInfoText;
  const tickerMessage = siteSettings.tickerText.trim();
  if (el('ticker-copy-a')) el('ticker-copy-a').textContent = tickerMessage ? `${tickerMessage}  •` : '';
  if (el('ticker-copy-b')) el('ticker-copy-b').textContent = tickerMessage ? `${tickerMessage}  •` : '';
  if (el('announcement-ticker')) el('announcement-ticker').hidden = !siteSettings.tickerEnabled || !tickerMessage;
  if (el('maintenance-title')) el('maintenance-title').textContent = siteSettings.maintenanceTitle;
  if (el('maintenance-message')) el('maintenance-message').textContent = siteSettings.maintenanceMessage;
  if (el('maintenance-overlay')) el('maintenance-overlay').hidden = !(siteSettings.maintenanceEnabled && !isAdminPage());
}

function applySiteSettings(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return false;
  const next = normalizeSiteSettings(raw);
  const changed = JSON.stringify(siteSettings) !== JSON.stringify(next);
  siteSettings = next;
  if (changed || options.forceRender === true) renderSiteChrome();
  if ((changed || options.forceForm === true) && !settingsFormDirty) populateSettingsForm();
  return changed;
}

function updateSiteClock() {
  const now = new Date();
  if (el('site-date')) {
    el('site-date').textContent = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta'
    }).format(now);
  }
  if (el('site-time')) {
    el('site-time').textContent = new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
    }).format(now);
  }
}

function persistAssets() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(assets)); return true; }
  catch (_) { return false; }
}

function showToast(message) {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3400);
}

function openModal(id) {
  const modal = el(id);
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  const modal = el(id);
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal-backdrop.is-open')) document.body.classList.remove('modal-open');
}

function getAssetFolders(asset) {
  const output = [];
  const seenUrls = new Set();
  const mainUrl = safeExternalUrl(asset.downloadUrl);
  if (mainUrl) {
    output.push({
      name: asset.category === 'Commodity' ? 'Folder Utama Commodity' : `Folder Utama ${asset.name}`,
      url: mainUrl,
      status: asset.status === 'Coming Soon' ? 'Coming Soon' : 'Available'
    });
    seenUrls.add(mainUrl);
  }
  for (const [index, folder] of (Array.isArray(asset.folderLinks) ? asset.folderLinks : []).entries()) {
    const url = safeExternalUrl(folder.url);
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);
    output.push({
      name: String(folder.name || `Folder Tujuan ${index + 1}`),
      url,
      status: folder.status === 'Coming Soon' || !url ? 'Coming Soon' : 'Available'
    });
  }
  return output;
}

function statusPill(status, type = 'availability') {
  const isReady = type === 'availability' ? status === 'Available' : status === 'published';
  const label = type === 'availability' ? (isReady ? 'Tersedia' : 'Coming Soon') : (isReady ? 'Publik' : 'Draft');
  return `<span class="status-pill ${isReady ? 'ready' : 'soon'}"><span class="status-dot"></span>${label}</span>`;
}

function renderFolderLinks(asset) {
  const folders = getAssetFolders(asset);
  if (!folders.length) return '<p class="no-folders">Folder unduhan belum ditambahkan.</p>';
  return `<div class="folder-list">${folders.map(folder => {
    const url = safeExternalUrl(folder.url);
    const ready = folder.status === 'Available' && Boolean(url);
    const btn = ready
      ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" class="btn-folder"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Buka Folder</a>`
      : `<button type="button" disabled class="btn-folder disabled"><i class="fa-regular fa-clock" aria-hidden="true"></i> Coming Soon</button>`;
    return `<div class="folder-row"><span class="folder-name"><i class="fa-solid fa-folder" aria-hidden="true"></i> ${escapeHTML(folder.name)}</span>${btn}</div>`;
  }).join('')}</div>`;
}

function visiblePublicAssets() {
  const query = catalogQuery.trim().toLowerCase();
  return assets.filter(asset => asset.publishStatus === 'published')
    .filter(asset => currentFilter === 'all' || asset.category === currentFilter)
    .filter(asset => !query || [
      asset.name, asset.category, categoryLabel(asset.category), asset.description, asset.version,
      asset.format, asset.compatibility, ...getAssetFolders(asset).map(folder => folder.name)
    ].join(' ').toLowerCase().includes(query))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.name).localeCompare(String(b.name)));
}

function renderUserView() {
  const grid = el('asset-grid');
  if (!grid) return;
  const published = assets.filter(asset => asset.publishStatus === 'published');
  const ready = published.filter(asset => asset.status === 'Available').length;
  const soon = published.length - ready;
  const pct = published.length ? Math.round((ready / published.length) * 100) : 0;

  if (el('count-all')) el('count-all').textContent = padCount(published.length);
  if (el('count-gd')) el('count-gd').textContent = padCount(published.filter(a => a.category === 'GD').length);
  if (el('count-gb')) el('count-gb').textContent = padCount(published.filter(a => a.category === 'GB').length);
  if (el('count-commodity')) el('count-commodity').textContent = padCount(published.filter(a => a.category === 'Commodity').length);
  if (el('hero-total-count')) el('hero-total-count').textContent = padCount(published.length);
  if (el('hero-ready-count')) el('hero-ready-count').textContent = padCount(ready);
  if (el('hero-soon-count')) el('hero-soon-count').textContent = padCount(soon);
  if (el('manifest-bar-fill')) el('manifest-bar-fill').style.width = `${pct}%`;
  if (el('nav-release-summary')) el('nav-release-summary').textContent = `${padCount(published.length)} Rilisan Publik`;

  const filtered = visiblePublicAssets();
  if (el('catalog-count')) el('catalog-count').textContent = `${padCount(filtered.length)} / ${padCount(published.length)} aset`;

  grid.innerHTML = filtered.map(asset => {
    const folders = getAssetFolders(asset);
    const catClass = asset.category === 'GD' ? 'cat-gd' : asset.category === 'GB' ? 'cat-gb' : 'cat-commodity';
    const coverUrl = safeExternalUrl(asset.coverUrl);
    const cover = coverUrl ? `<div class="asset-cover"><img src="${escapeHTML(coverUrl)}" alt="Cover ${escapeHTML(asset.name)}" loading="lazy" /></div>` : '';
    return `<article class="asset-card">
      ${cover}
      <div class="card-body">
        <div class="card-head-row">
          <span class="cat-tag ${catClass}">${escapeHTML(asset.category)}</span>
          ${statusPill(asset.status)}
        </div>
        <h3 class="card-title">${escapeHTML(asset.name)}</h3>
        <p class="card-desc">${escapeHTML(asset.description || 'Belum ada deskripsi untuk aset ini.')}</p>
        <div class="meta-chips">
          <span class="meta-chip"><i class="fa-solid fa-code-branch"></i> ${escapeHTML(asset.version || 'TBA')}</span>
          <span class="meta-chip"><i class="fa-solid fa-desktop"></i> ${escapeHTML(asset.compatibility || 'Trainz Simulator')}</span>
        </div>
        ${renderFolderLinks(asset)}
        <div class="card-foot">
          <span class="folder-meta-count"><i class="fa-solid fa-folder-tree"></i> ${folders.length} folder</span>
          <button type="button" class="btn-detail" data-detail-id="${escapeHTML(asset.id)}">
            Detail Asset <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>
      </div>
    </article>`;
  }).join('');

  if (el('empty-assets')) el('empty-assets').hidden = filtered.length > 0;
}

function openAssetDetails(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset || asset.publishStatus !== 'published') return;
  el('detail-title').textContent = asset.name;
  const metadata = [
    ['Kategori', categoryLabel(asset.category)],
    ['Versi', asset.version || 'Belum diatur'],
    ['Ketersediaan', asset.status === 'Available' ? 'Tersedia' : 'Coming Soon'],
    ['Tanggal rilis', asset.date ? formatDate(asset.date) : 'Belum diatur'],
    ['Format', asset.format || 'Belum diatur'],
    ['Kompatibilitas', asset.compatibility || 'Belum diatur']
  ];
  const metaHtml = metadata.map(([label, value]) => `<div class="detail-meta-item"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join('');
  const info = safeExternalUrl(asset.moreInfoUrl);
  el('detail-content').innerHTML = `
    ${safeExternalUrl(asset.coverUrl) ? `<div class="detail-cover"><img src="${escapeHTML(safeExternalUrl(asset.coverUrl))}" alt="Cover ${escapeHTML(asset.name)}" /></div>` : ''}
    <div class="detail-meta-grid">${metaHtml}</div>
    <div class="detail-block"><h4>Deskripsi</h4><p>${escapeHTML(asset.description || 'Belum ada deskripsi untuk aset ini.')}</p></div>
    <div class="detail-block"><h4>Folder unduhan</h4>${renderFolderLinks(asset)}</div>
    ${info ? `<a class="btn-primary" href="${escapeHTML(info)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Video / Informasi Tambahan</a>` : ''}`;
  openModal('detail-modal');
}

function renderAdminView() {
  const tbody = el('admin-table-body');
  if (!tbody) return;
  const published = assets.filter(asset => asset.publishStatus === 'published').length;
  if (el('stat-total')) el('stat-total').textContent = padCount(assets.length);
  if (el('stat-published')) el('stat-published').textContent = padCount(published);
  if (el('stat-draft')) el('stat-draft').textContent = padCount(assets.length - published);
  if (el('stat-folders')) el('stat-folders').textContent = padCount(assets.reduce((sum, a) => sum + getAssetFolders(a).length, 0));

  const query = adminQuery.trim().toLowerCase();
  const filtered = [...assets]
    .filter(a => adminPublicationFilter === 'all' || a.publishStatus === adminPublicationFilter)
    .filter(a => !query || [a.name, a.category, categoryLabel(a.category), a.description, a.version, a.compatibility].join(' ').toLowerCase().includes(query))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.name).localeCompare(String(b.name)));

  tbody.innerHTML = filtered.map((asset, index) => {
    const folders = getAssetFolders(asset).length;
    const catClass = asset.category === 'GD' ? 'cat-gd' : asset.category === 'GB' ? 'cat-gb' : 'cat-commodity';
    const isConfirming = String(pendingDeleteId) === String(asset.id);
    return `<tr>
      <td>${index + 1}</td>
      <td><span class="cat-tag ${catClass}">${escapeHTML(asset.category)}</span></td>
      <td><strong>${escapeHTML(asset.name)}</strong><span class="table-sub">${escapeHTML(asset.version || 'TBA')}</span></td>
      <td>${folders} folder</td>
      <td>${statusPill(asset.status)}</td>
      <td>${statusPill(asset.publishStatus, 'publication')}</td>
      <td><div class="row-actions">
        <button class="btn-act" type="button" data-edit-id="${escapeHTML(asset.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn-act" type="button" data-publish-id="${escapeHTML(asset.id)}" title="${asset.publishStatus === 'published' ? 'Jadikan draft' : 'Publikasikan'}"><i class="fa-solid fa-${asset.publishStatus === 'published' ? 'eye-slash' : 'eye'}"></i></button>
        <button class="btn-act btn-act-del" type="button" data-delete-id="${escapeHTML(asset.id)}" title="Hapus">${isConfirming ? 'Yakin?' : '<i class="fa-solid fa-trash"></i>'}</button>
      </div></td>
    </tr>`;
  }).join('');

  if (el('admin-empty')) el('admin-empty').hidden = filtered.length > 0;
}

function syncViewVisibility() {
  const userView = el('user-view');
  const loginView = el('admin-login-view');
  const adminView = el('admin-view');
  const adminMode = isAdminPage();

  if (userView) userView.classList.toggle('active', !adminMode);
  if (loginView) loginView.classList.toggle('active', adminMode && !isAdminLoggedIn);
  if (adminView) adminView.classList.toggle('active', adminMode && isAdminLoggedIn);

  if (!adminMode) renderUserView();
  else if (isAdminLoggedIn) renderAdminView();
  renderSiteChrome();
}

function addSubfolderInputRow(folder = { name: '', url: '', status: 'Available' }) {
  const container = el('subfolder-inputs-container');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'subfolder-input-row';
  row.innerHTML = `
    <input type="text" class="sub-name" value="${escapeHTML(folder.name || '')}" placeholder="Nama sub-folder" maxlength="120" />
    <input type="url" class="sub-link" value="${escapeHTML(folder.url || '')}" placeholder="Link Google Drive (opsional jika Coming Soon)" />
    <select class="sub-status"><option value="Available" ${folder.status !== 'Coming Soon' ? 'selected' : ''}>Tersedia</option><option value="Coming Soon" ${folder.status === 'Coming Soon' ? 'selected' : ''}>Coming Soon</option></select>
    <button type="button" class="btn-remove-sub" title="Hapus sub-folder"><i class="fa-solid fa-trash"></i></button>`;
  row.querySelector('.btn-remove-sub').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function clearAssetForm() {
  el('asset-form').reset();
  el('asset-id').value = '';
  el('asset-version').value = 'v1.0';
  el('asset-date').value = today();
  el('asset-format').value = 'Google Drive Folder';
  el('asset-compatibility').value = 'Trainz Simulator';
  el('asset-status').value = 'Available';
  el('asset-publication').value = 'published';
  el('subfolder-inputs-container').innerHTML = '';
  addSubfolderInputRow({ name: '', url: '', status: 'Coming Soon' });
}

function openAddModal() {
  clearAssetForm();
  el('asset-modal-title').textContent = 'Tambah Asset Baru';
  el('save-asset-btn').textContent = 'Simpan Asset';
  openModal('asset-modal');
}

function openEditModal(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset) return;
  clearAssetForm();
  el('asset-id').value = asset.id;
  el('asset-category').value = asset.category;
  el('asset-title').value = asset.name;
  el('asset-version').value = asset.version || '';
  el('asset-date').value = asset.date || '';
  el('asset-status').value = asset.status;
  el('asset-publication').value = asset.publishStatus;
  el('asset-desc').value = asset.description || '';
  el('asset-format').value = asset.format || '';
  el('asset-compatibility').value = asset.compatibility || '';
  el('asset-download').value = asset.downloadUrl || '';
  el('asset-more-info').value = asset.moreInfoUrl || '';
  el('asset-cover').value = asset.coverUrl || '';
  const container = el('subfolder-inputs-container');
  container.innerHTML = '';
  (asset.folderLinks || []).forEach(folder => addSubfolderInputRow(folder));
  if (!asset.folderLinks || !asset.folderLinks.length) addSubfolderInputRow({ name: '', url: '', status: 'Coming Soon' });
  el('asset-modal-title').textContent = 'Edit Asset';
  el('save-asset-btn').textContent = 'Simpan Perubahan';
  openModal('asset-modal');
}

function validateOptionalUrl(label, value) {
  if (!String(value || '').trim()) return '';
  return safeExternalUrl(value) ? '' : `${label} harus berupa URL HTTP/HTTPS yang valid.`;
}

async function handleAssetFormSubmit(event) {
  event.preventDefault();
  const id = el('asset-id').value.trim();
  const name = el('asset-title').value.trim();
  const downloadUrl = el('asset-download').value.trim();
  const moreInfoUrl = el('asset-more-info').value.trim();
  const coverUrl = el('asset-cover').value.trim();
  if (!name) return showToast('Nama aset wajib diisi.');
  for (const [label, value] of [['Link folder utama', downloadUrl], ['Link informasi tambahan', moreInfoUrl], ['URL cover', coverUrl]]) {
    const error = validateOptionalUrl(label, value);
    if (error) return showToast(error);
  }

  const folderLinks = [];
  for (const [index, row] of [...document.querySelectorAll('.subfolder-input-row')].entries()) {
    const folderName = row.querySelector('.sub-name').value.trim();
    const rawUrl = row.querySelector('.sub-link').value.trim();
    const status = row.querySelector('.sub-status').value;
    if (!folderName && !rawUrl) continue;
    if (!folderName) { showToast(`Nama sub-folder baris ${index + 1} belum diisi.`); return; }
    if (rawUrl && !safeExternalUrl(rawUrl)) { showToast(`Link sub-folder "${folderName}" tidak valid.`); return; }
    if (status === 'Available' && !safeExternalUrl(rawUrl)) { showToast(`Folder "${folderName}" butuh link jika berstatus Tersedia.`); return; }
    folderLinks.push({ name: folderName, url: safeExternalUrl(rawUrl), status: status === 'Available' && rawUrl ? 'Available' : 'Coming Soon' });
  }

  const oldAsset = id ? assets.find(item => String(item.id) === id) : null;
  const entry = {
    id: oldAsset ? oldAsset.id : makeId(),
    name,
    category: el('asset-category').value,
    version: el('asset-version').value.trim() || 'TBA',
    publishStatus: el('asset-publication').value,
    status: el('asset-status').value,
    date: el('asset-date').value || '',
    format: el('asset-format').value.trim() || 'Belum diatur',
    compatibility: el('asset-compatibility').value.trim() || 'Trainz Simulator',
    description: el('asset-desc').value.trim(),
    downloadUrl: safeExternalUrl(downloadUrl),
    folderLinks,
    moreInfoUrl: safeExternalUrl(moreInfoUrl),
    coverUrl: safeExternalUrl(coverUrl)
  };

  const saveButton = el('save-asset-btn');
  saveButton.disabled = true;
  saveButton.textContent = 'Menyimpan...';
  try {
    await runAdminMutation('saveAsset', { asset: entry });
    closeModal('asset-modal');
    showToast(oldAsset ? 'Perubahan aset tersimpan.' : 'Aset baru berhasil ditambahkan.');
  } catch (error) {
    showToast(`Gagal menyimpan aset: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = oldAsset ? 'Simpan Perubahan' : 'Simpan Asset';
  }
}

async function handleSiteSettingsSubmit(event) {
  event.preventDefault();
  const settings = {
    releaseInfoTitle: el('release-info-title-input').value.trim(),
    releaseInfoText: el('release-info-text-input').value.trim(),
    tickerEnabled: el('ticker-enabled').checked,
    tickerText: el('ticker-text-input').value.trim(),
    maintenanceEnabled: el('maintenance-enabled').checked,
    maintenanceTitle: el('maintenance-title-input').value.trim(),
    maintenanceMessage: el('maintenance-message-input').value.trim()
  };
  if (!settings.releaseInfoTitle || !settings.releaseInfoText) return showToast('Judul dan isi informasi rilisan wajib diisi.');
  if (!settings.maintenanceTitle || !settings.maintenanceMessage) return showToast('Judul dan pesan maintenance wajib diisi.');

  const saveButton = el('save-site-settings-btn');
  saveButton.disabled = true;
  saveButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';
  try {
    const result = await runAdminMutation('saveSettings', { settings });
    if (result.settings) applySiteSettings(result.settings, { forceRender: true });
    settingsFormDirty = false;
    populateSettingsForm();
    renderSiteChrome();
    if (catalogSyncChannel) {
      try { catalogSyncChannel.postMessage({ type: 'assets-snapshot', assets: clone(assets), settings: clone(siteSettings) }); } catch (_) {}
    }
    showToast('Pengaturan website berhasil disimpan.');
  } catch (error) {
    showToast(`Pengaturan gagal disimpan: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Simpan Pengaturan';
  }
}

async function deleteAsset(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset) return;
  if (String(pendingDeleteId) !== String(id)) {
    pendingDeleteId = String(id);
    renderAdminView();
    showToast(`Klik "Yakin?" lagi untuk menghapus "${asset.name}".`);
    window.clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = window.setTimeout(() => { pendingDeleteId = null; renderAdminView(); }, 3500);
    return;
  }
  pendingDeleteId = null;
  window.clearTimeout(pendingDeleteTimer);
  try {
    await runAdminMutation('deleteAsset', { id: String(id) });
    showToast('Aset berhasil dihapus.');
  } catch (error) {
    showToast(`Gagal menghapus aset: ${error.message}`);
  }
}

async function togglePublication(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset) return;
  const updatedAsset = { ...asset, publishStatus: asset.publishStatus === 'published' ? 'draft' : 'published' };
  try {
    await runAdminMutation('saveAsset', { asset: updatedAsset });
    showToast(updatedAsset.publishStatus === 'published' ? 'Aset ditampilkan ke publik.' : 'Aset dipindahkan ke draft.');
  } catch (error) {
    showToast(`Status publikasi gagal diubah: ${error.message}`);
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  if (!isApiConfigured()) return showToast('URL Apps Script belum diatur di script.js.');
  const username = el('admin-username').value.trim();
  const password = el('admin-password').value;
  const submitButton = el('login-submit-btn');
  submitButton.disabled = true;
  submitButton.textContent = 'Memeriksa...';
  el('login-error').hidden = true;
  try {
    const result = await apiPost('login', { username, password });
    if (!result || !result.ok || !result.token) {
      el('login-error').textContent = (result && result.error) || 'Username atau password salah.';
      el('login-error').hidden = false;
      el('admin-password').value = '';
      el('admin-password').focus();
      return;
    }
    try {
      sessionStorage.setItem(API_TOKEN_KEY, result.token);
      sessionStorage.setItem(SESSION_KEY, 'true');
    } catch (_) {}
    isAdminLoggedIn = true;
    if (result.settings) applySiteSettings(result.settings);
    if (Array.isArray(result.assets)) applyAssetSnapshot(result.assets, { broadcast: true });
    el('login-form').reset();
    syncViewVisibility();
    showToast('Login admin berhasil.');
  } catch (error) {
    el('login-error').textContent = `Login gagal terhubung: ${error.message}`;
    el('login-error').hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Masuk ke Panel Admin';
  }
}

async function logoutAdmin() {
  const token = getAdminToken();
  clearAdminSession();
  syncViewVisibility();
  showToast('Kamu sudah keluar dari panel admin.');
  if (token && isApiConfigured()) {
    try { await apiPost('logout', {}, token); } catch (_) {}
  }
}

function formatDate(value) {
  if (!value) return 'Belum diatur';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function handleModalClick(event) {
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) { closeModal(closeButton.dataset.close); return; }
  if (event.target.classList.contains('modal-backdrop')) closeModal(event.target.id);
}

let catalogSyncChannel = null;
try {
  if ('BroadcastChannel' in window) {
    catalogSyncChannel = new BroadcastChannel('nl-production-catalog-sync-v1');
    catalogSyncChannel.addEventListener('message', event => {
      const message = event.data;
      if (!message || message.type !== 'assets-snapshot' || !Array.isArray(message.assets)) return;
      if (message.settings) applySiteSettings(message.settings);
      const snapshot = isAdminLoggedIn ? message.assets : message.assets.filter(item => normalizePublication(item) === 'published');
      applyAssetSnapshot(snapshot, { persist: false, broadcast: false });
    });
  }
} catch (_) {}

async function syncCatalogNow() {
  if (!isApiConfigured() || apiMutationInProgress || apiPollInProgress) return false;
  apiPollInProgress = true;
  try {
    const token = getAdminToken();
    if (isAdminPage() && isAdminLoggedIn && token) return await refreshAdminData(false);
    if (!isAdminPage()) return await refreshPublicCatalog(false);
    return false;
  } finally {
    apiPollInProgress = false;
  }
}

function init() {
  isAdminLoggedIn = false;
  if (el('current-year')) el('current-year').textContent = String(new Date().getFullYear());
  updateSiteClock();
  window.setInterval(updateSiteClock, 1000);
  populateSettingsForm();
  syncViewVisibility();

  window.addEventListener('hashchange', syncViewVisibility);
  window.addEventListener('popstate', syncViewVisibility);

  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderUserView();
  }));

  if (el('catalog-search')) {
    el('catalog-search').addEventListener('input', event => { catalogQuery = event.target.value; renderUserView(); });
  }
  if (el('reset-catalog')) {
    el('reset-catalog').addEventListener('click', () => {
      currentFilter = 'all'; catalogQuery = '';
      if (el('catalog-search')) el('catalog-search').value = '';
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
      renderUserView();
    });
  }
  if (el('asset-grid')) {
    el('asset-grid').addEventListener('click', event => {
      const detailButton = event.target.closest('[data-detail-id]');
      if (detailButton) openAssetDetails(detailButton.dataset.detailId);
    });
  }

  if (el('admin-search')) el('admin-search').addEventListener('input', event => { adminQuery = event.target.value; renderAdminView(); });
  if (el('admin-publish-filter')) el('admin-publish-filter').addEventListener('change', event => { adminPublicationFilter = event.target.value; renderAdminView(); });
  if (el('add-asset-btn')) el('add-asset-btn').addEventListener('click', openAddModal);
  if (el('logout-btn')) el('logout-btn').addEventListener('click', logoutAdmin);
  if (el('add-subfolder-btn')) el('add-subfolder-btn').addEventListener('click', () => addSubfolderInputRow());
  if (el('login-form')) el('login-form').addEventListener('submit', handleLoginSubmit);
  if (el('toggle-password-btn') && el('admin-password')) {
    el('toggle-password-btn').addEventListener('click', () => {
      const pwInput = el('admin-password');
      const icon = el('toggle-password-btn').querySelector('i');
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      if (icon) {
        icon.classList.toggle('fa-eye', !show);
        icon.classList.toggle('fa-eye-slash', show);
      }
    });
  }
  if (el('maintenance-check-btn')) {
    el('maintenance-check-btn').addEventListener('click', async () => {
      const btn = el('maintenance-check-btn');
      const st = el('maintenance-check-status');
      btn.disabled = true;
      if (st) st.textContent = 'Memeriksa status server...';
      try {
        if (isApiConfigured()) {
          await refreshPublicCatalog(false);
          if (st) st.textContent = siteSettings.maintenanceEnabled ? 'Pemeliharaan masih berlangsung.' : 'Sistem sudah normal kembali!';
        } else {
          window.location.reload();
        }
      } catch (_) {
        if (st) st.textContent = 'Belum dapat terhubung ke server. Coba lagi sebentar.';
      } finally {
        btn.disabled = false;
      }
    });
  }
  if (el('asset-form')) el('asset-form').addEventListener('submit', handleAssetFormSubmit);
  if (el('site-settings-form')) {
    el('site-settings-form').addEventListener('submit', handleSiteSettingsSubmit);
    el('site-settings-form').addEventListener('input', () => { settingsFormDirty = true; });
    el('site-settings-form').addEventListener('change', () => { settingsFormDirty = true; });
  }
  if (el('admin-table-body')) {
    el('admin-table-body').addEventListener('click', event => {
      const edit = event.target.closest('[data-edit-id]');
      const remove = event.target.closest('[data-delete-id]');
      const publish = event.target.closest('[data-publish-id]');
      if (edit) openEditModal(edit.dataset.editId);
      else if (remove) deleteAsset(remove.dataset.deleteId);
      else if (publish) togglePublication(publish.dataset.publishId);
    });
  }

  document.querySelectorAll('.modal-backdrop').forEach(modal => modal.addEventListener('click', handleModalClick));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop.is-open').forEach(modal => closeModal(modal.id));
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && el('catalog-search')) {
      event.preventDefault(); el('catalog-search').focus();
    }
  });

  if (isApiConfigured()) {
    (async () => {
      if (apiPollInProgress) return;
      apiPollInProgress = true;
      try {
        const savedToken = getAdminToken();
        if (isAdminPage() && savedToken) {
          const valid = await refreshAdminData(false);
          if (!valid) syncViewVisibility();
        } else if (!isAdminPage()) {
          await refreshPublicCatalog(false);
        }
      } finally {
        apiPollInProgress = false;
      }
    })();

    window.setInterval(() => { void syncCatalogNow(); }, API_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncCatalogNow(); });
    window.addEventListener('focus', () => { void syncCatalogNow(); });
    window.addEventListener('pageshow', () => { void syncCatalogNow(); });
    window.addEventListener('online', () => { void syncCatalogNow(); });
  }
}

init();
