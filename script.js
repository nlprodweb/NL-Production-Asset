'use strict';

// Tempel URL Web App Apps Script yang berakhiran /exec di bawah ini.
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbytETVLRxhq1Cro30I59qzx0OjOqik_hR9B2L7roCRy15gfQ5mqLLFHr9dR0Mp7EoYi/exec';
const API_POLL_INTERVAL_MS = 1500; // 1,5 detik
const API_MESSAGE_SOURCE = 'nl-production-api';
const API_TOKEN_KEY = 'nlProduction.adminToken.v1';
const STORAGE_KEY = 'nlProduction.assets.v2';
const LEGACY_STORAGE_KEYS = ['trainz_assets', 'railworksStudio.assets.v1'];
const SESSION_KEY = 'nlProduction.adminSession.v1';

const clone = value => JSON.parse(JSON.stringify(value));
const makeId = () => `asset-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const padCount = value => String(value).padStart(2, '0');
const categoryLabel = category => ({ GD: 'Gerbong Datar', GB: 'Gerbong Barang', Commodity: 'Commodity' }[category] || category || 'Asset');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

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

// Read-only JSONP avoids browser CORS restrictions for the public catalog.
function apiGetJsonp(action = 'listPublic') {
  if (!isApiConfigured()) return Promise.reject(new Error('URL Apps Script belum diatur di Script.js.'));
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

// Submit through a normal HTML form to avoid cross-origin fetch/CORS issues.
// Apps Script returns a tiny HTML response that acknowledges via postMessage.
function apiPost(action, payload = {}, token = '') {
  if (!isApiConfigured()) return Promise.reject(new Error('URL Apps Script belum diatur di Script.js.'));
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
    const timeout = window.setTimeout(() => finish(new Error('Apps Script tidak mengirim jawaban. Periksa URL /exec, akses deployment Anyone, lalu deploy versi terbaru.')), 25000);
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
      // Apps Script may wrap HtmlService output in an internal Google iframe.
      // In that case the sender can differ from the outer iframe's contentWindow.
      // Accept only a matching, unguessable requestId from our Google response context.
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

function applyAssetSnapshot(list) {
  if (!Array.isArray(list)) throw new Error('Format data dari Apps Script tidak valid.');
  assets = list.map(normalizeAsset);
  persistAssets(); // cache lokal saja; database Apps Script tetap menjadi sumber utama.
  renderUserView();
  renderAdminView();
}

async function refreshPublicCatalog(showErrors = false) {
  if (!isApiConfigured() || isAdminLoggedIn || apiMutationInProgress) return false;
  try {
    const result = await apiGetJsonp('listPublic');
    if (!result || !result.ok) throw new Error((result && result.error) || 'Gagal membaca katalog publik.');
    if (!isAdminLoggedIn) applyAssetSnapshot(result.assets || []);
    apiErrorToastShown = false;
    return true;
  } catch (error) {
    console.error('Sinkronisasi katalog publik gagal:', error);
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
  try {
    const result = await apiPost('listAdmin', {}, token);
    if (!result || !result.ok) {
      if (result && /sesi|token|login/i.test(result.error || '')) {
        clearAdminSession();
        if (el('admin-view').classList.contains('active')) switchTab('user');
      }
      throw new Error((result && result.error) || 'Gagal membaca data admin.');
    }
    isAdminLoggedIn = true;
    applyAssetSnapshot(result.assets || []);
    apiErrorToastShown = false;
    return true;
  } catch (error) {
    console.error('Sinkronisasi admin gagal:', error);
    if (showErrors && !apiErrorToastShown) {
      showToast(`Sinkronisasi admin gagal: ${error.message}`);
      apiErrorToastShown = true;
    }
    return false;
  }
}

async function runAdminMutation(action, payload) {
  if (!isApiConfigured()) throw new Error('URL Apps Script belum dipasang di Script.js.');
  const token = getAdminToken();
  if (!token || !isAdminLoggedIn) throw new Error('Sesi admin tidak ditemukan. Silakan login kembali.');
  apiMutationInProgress = true;
  try {
    const result = await apiPost(action, payload, token);
    if (!result || !result.ok) throw new Error((result && result.error) || 'Operasi database gagal.');
    applyAssetSnapshot(result.assets || []);
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

function canonicalAssetKey(item) {
  const category = String(item.category || '').trim();
  const title = String(item.name || item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (category === 'Commodity' && (title === 'commodity' || title.includes('peternakan') || title.includes('hasil bumi'))) return 'Commodity:commodity';
  if (category === 'GD' && title.includes('new generation')) return 'GD:new generation';
  if (category === 'GD' && (title.includes('biasa') || title.includes('standard'))) return 'GD:biasa';
  if (category === 'GB' && title.includes('ballast')) return 'GB:ballast';
  return `${category}:${title}`;
}

function normalizeAsset(raw = {}) {
  const category = ['GD', 'GB', 'Commodity'].includes(raw.category) ? raw.category : 'Commodity';
  const rawName = String(raw.name || raw.title || 'Asset tanpa nama').trim() || 'Asset tanpa nama';
  const rawStatus = raw.status;
  const releaseStatus = raw.releaseState === 'coming-soon' ? 'Coming Soon'
    : normalizeReleaseStatus(raw.availability || rawStatus, 'Available');
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

  // Migrasi format lama ketika Commodity pernah disimpan sebagai aset anak tunggal.
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
  } catch (error) {
    console.warn(`Tidak dapat membaca ${key}; data awal akan digunakan.`, error);
    return null;
  }
}

function loadAssets() {
  const current = readStoredArray(STORAGE_KEY);
  if (current) return current.map(normalizeAsset);

  let legacy = null;
  for (const key of LEGACY_STORAGE_KEYS) {
    legacy = readStoredArray(key);
    if (legacy) break;
  }
  if (!legacy) {
    const fresh = clone(initialAssets);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)); } catch (_) {}
    return fresh;
  }

  const merged = initialAssets.map(seed => clone(seed));
  for (const value of legacy) {
    const normalized = normalizeAsset(value);
    const key = canonicalAssetKey(normalized);
    const index = merged.findIndex(seed => canonicalAssetKey(seed) === key || String(seed.id) === String(normalized.id));
    if (index >= 0) {
      const seed = merged[index];
      const previousFolders = seed.folderLinks || [];
      const nextFolders = normalized.folderLinks || [];
      const mergedFolders = [...previousFolders];
      for (const folder of nextFolders) {
        if (!mergedFolders.some(existing => (folder.url && existing.url === folder.url) || existing.name.toLowerCase() === folder.name.toLowerCase())) mergedFolders.push(folder);
      }
      merged[index] = {
        ...seed,
        ...normalized,
        id: seed.id,
        name: seed.name,
        folderLinks: mergedFolders,
        // Data tersimpan lebih diutamakan untuk informasi yang pernah diedit admin.
        description: normalized.description || seed.description,
        version: String(value.version || '').trim() ? normalized.version : seed.version,
        date: String(value.date || '').trim() ? normalized.date : seed.date,
        format: String(value.format || '').trim() ? normalized.format : seed.format,
        compatibility: String(value.compatibility || '').trim() ? normalized.compatibility : seed.compatibility
      };
    } else {
      merged.push(normalized);
    }
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch (_) {}
  return merged;
}

let assets = loadAssets();
let currentFilter = 'all';
let catalogQuery = '';
let adminQuery = '';
let adminPublicationFilter = 'all';
let isAdminLoggedIn = false;
let toastTimer = null;
let apiMutationInProgress = false;
let apiPollInProgress = false;
let apiErrorToastShown = false;

const el = id => document.getElementById(id);
const publicGrid = el('asset-grid');

function persistAssets() {
  // Hanya cache/fallback lokal. Perubahan utama dikirim ke Google Sheets via Apps Script.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(assets)); return true; }
  catch (error) { console.warn('Cache katalog lokal tidak bisa disimpan:', error); return false; }
}

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
    toast.hidden = true;
  }, 3200);
}

function openModal(id) {
  const modal = el(id);
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  const focusable = modal.querySelector('input:not([type="hidden"]), button, select, textarea');
  if (focusable) window.setTimeout(() => focusable.focus(), 25);
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

function statusBadge(status, type = 'availability') {
  const isAvailable = type === 'availability' ? status === 'Available' : status === 'published';
  const label = type === 'availability' ? (isAvailable ? 'Tersedia' : 'Coming Soon') : (isAvailable ? 'Publik' : 'Draft');
  return `<span class="status-indicator ${isAvailable ? 'ready' : 'soon'}"><span class="status-dot"></span>${label}</span>`;
}

function renderFolderLinks(asset, compact = false) {
  const folders = getAssetFolders(asset);
  if (!folders.length) return '<p class="no-subfolders">Folder unduhan belum ditambahkan.</p>';
  return `<div class="subfolder-wrapper ${compact ? 'compact' : ''}">${folders.map(folder => {
    const url = safeExternalUrl(folder.url);
    const ready = folder.status === 'Available' && Boolean(url);
    const action = ready
      ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer" class="btn-sub-download"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Buka Folder</a>`
      : `<button type="button" disabled class="btn-sub-download disabled"><i class="fa-solid fa-clock" aria-hidden="true"></i> Coming Soon</button>`;
    return `<div class="subfolder-item"><span class="subfolder-name"><i class="fa-solid fa-folder" aria-hidden="true"></i> ${escapeHTML(folder.name)}</span>${action}</div>`;
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

function renderPublicCounts() {
  const published = assets.filter(asset => asset.publishStatus === 'published');
  el('count-all').textContent = padCount(published.length);
  el('count-gd').textContent = padCount(published.filter(asset => asset.category === 'GD').length);
  el('count-gb').textContent = padCount(published.filter(asset => asset.category === 'GB').length);
  el('count-commodity').textContent = padCount(published.filter(asset => asset.category === 'Commodity').length);
}

function renderUserView() {
  renderPublicCounts();
  const filtered = visiblePublicAssets();
  el('catalog-count').textContent = `Menampilkan ${padCount(filtered.length)} dari ${padCount(assets.filter(asset => asset.publishStatus === 'published').length)} aset`;
  publicGrid.innerHTML = filtered.map(asset => {
    const availability = asset.status === 'Available' ? 'ready' : 'soon';
    const folders = getAssetFolders(asset);
    const version = asset.version ? `<span class="asset-chip"><i class="fa-solid fa-code-branch"></i> ${escapeHTML(asset.version)}</span>` : '';
    const compat = asset.compatibility ? `<span class="asset-chip"><i class="fa-solid fa-desktop"></i> ${escapeHTML(asset.compatibility)}</span>` : '';
    const coverUrl = safeExternalUrl(asset.coverUrl);
    const cover = coverUrl ? `<div class="asset-cover-image"><img src="${escapeHTML(coverUrl)}" alt="Cover ${escapeHTML(asset.name)}" loading="lazy" /></div>` : '';
    return `<article class="asset-card">
      ${cover}
      <div class="card-top">
        <div class="card-meta"><span class="cat-badge ${asset.category === 'GD' ? 'cat-gd' : asset.category === 'GB' ? 'cat-gb' : 'cat-commodity'}">${escapeHTML(asset.category)}</span>${statusBadge(asset.status)}</div>
        <h3 class="card-title">${escapeHTML(asset.name)}</h3>
        <p class="card-desc">${escapeHTML(asset.description || 'Belum ada deskripsi untuk aset ini.')}</p>
        <div class="asset-chips">${version}${compat}</div>
        ${folders.length ? renderFolderLinks(asset, true) : '<p class="no-subfolders">Folder unduhan belum ditambahkan.</p>'}
        <div class="asset-card-footer"><span class="folder-total"><i class="fa-solid fa-folder-tree"></i> ${folders.length} folder tujuan</span><button type="button" class="btn-detail" data-detail-id="${escapeHTML(asset.id)}"><i class="fa-solid fa-circle-info"></i> Detail Asset</button></div>
      </div>
    </article>`;
  }).join('');
  el('empty-assets').hidden = filtered.length > 0;
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
    <div class="detail-description"><h4>Deskripsi</h4><p>${escapeHTML(asset.description || 'Belum ada deskripsi untuk aset ini.')}</p></div>
    <div class="detail-folders"><h4>Folder unduhan</h4>${renderFolderLinks(asset)}</div>
    ${info ? `<p class="detail-extra-link"><a class="btn-primary" href="${escapeHTML(info)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Video / Informasi Tambahan</a></p>` : ''}`;
  openModal('detail-modal');
}

function renderAdminStats() {
  const published = assets.filter(asset => asset.publishStatus === 'published').length;
  el('stat-total').textContent = padCount(assets.length);
  el('stat-published').textContent = padCount(published);
  el('stat-draft').textContent = padCount(assets.length - published);
  el('stat-folders').textContent = padCount(assets.reduce((sum, asset) => sum + getAssetFolders(asset).length, 0));
}

function renderAdminView() {
  renderAdminStats();
  const query = adminQuery.trim().toLowerCase();
  const filtered = [...assets].filter(asset => adminPublicationFilter === 'all' || asset.publishStatus === adminPublicationFilter)
    .filter(asset => !query || [asset.name, asset.category, categoryLabel(asset.category), asset.description, asset.version, asset.compatibility].join(' ').toLowerCase().includes(query))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.name).localeCompare(String(b.name)));
  el('admin-table-body').innerHTML = filtered.map((asset, index) => {
    const folders = getAssetFolders(asset).length;
    return `<tr>
      <td>${index + 1}</td><td><span class="cat-badge ${asset.category === 'GD' ? 'cat-gd' : asset.category === 'GB' ? 'cat-gb' : 'cat-commodity'}">${escapeHTML(asset.category)}</span></td>
      <td><strong>${escapeHTML(asset.name)}</strong><small class="table-subtitle">${escapeHTML(asset.version || 'TBA')}</small></td>
      <td><span class="subfolder-count">${folders} folder</span></td><td>${statusBadge(asset.status)}</td><td>${statusBadge(asset.publishStatus, 'publication')}</td>
      <td><div class="action-flex">
        <button class="btn-icon-edit" type="button" data-edit-id="${escapeHTML(asset.id)}" title="Edit aset"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn-icon-publish" type="button" data-publish-id="${escapeHTML(asset.id)}" title="${asset.publishStatus === 'published' ? 'Jadikan draft' : 'Tampilkan ke publik'}"><i class="fa-solid fa-${asset.publishStatus === 'published' ? 'eye-slash' : 'eye'}"></i></button>
        <button class="btn-icon-delete" type="button" data-delete-id="${escapeHTML(asset.id)}" title="Hapus aset"><i class="fa-solid fa-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');
  el('admin-empty').hidden = filtered.length > 0;
}

function switchTab(role) {
  if (role === 'admin' && !isApiConfigured()) {
    showToast('URL Web App Apps Script belum diatur pada Script.js.');
    return;
  }
  if (role === 'admin' && !isAdminLoggedIn) {
    openModal('login-modal');
    return;
  }
  el('btn-role-user').classList.toggle('active', role === 'user');
  el('btn-role-admin').classList.toggle('active', role === 'admin');
  el('user-view').classList.toggle('active', role === 'user');
  el('admin-view').classList.toggle('active', role === 'admin');
  if (role === 'user') renderUserView();
  else renderAdminView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function addSubfolderInputRow(folder = { name: '', url: '', status: 'Available' }) {
  const container = el('subfolder-inputs-container');
  const row = document.createElement('div');
  row.className = 'subfolder-input-row';
  row.innerHTML = `
    <input type="text" class="sub-name" value="${escapeHTML(folder.name || '')}" placeholder="Nama sub-folder" aria-label="Nama sub-folder" maxlength="120" />
    <input type="url" class="sub-link" value="${escapeHTML(folder.url || '')}" placeholder="Link Google Drive (opsional jika Coming Soon)" aria-label="Link sub-folder" />
    <select class="sub-status" aria-label="Status sub-folder"><option value="Available" ${folder.status !== 'Coming Soon' ? 'selected' : ''}>Tersedia</option><option value="Coming Soon" ${folder.status === 'Coming Soon' ? 'selected' : ''}>Coming Soon</option></select>
    <button type="button" class="btn-remove-sub" aria-label="Hapus baris sub-folder" title="Hapus sub-folder"><i class="fa-solid fa-trash"></i></button>`;
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
    if (!folderName) { showToast(`Nama sub-folder pada baris ${index + 1} belum diisi.`); row.querySelector('.sub-name').focus(); return; }
    if (rawUrl && !safeExternalUrl(rawUrl)) { showToast(`Link sub-folder "${folderName}" harus berupa URL HTTP/HTTPS yang valid.`); row.querySelector('.sub-link').focus(); return; }
    if (status === 'Available' && !safeExternalUrl(rawUrl)) { showToast(`Folder "${folderName}" berstatus Tersedia, jadi masukkan link atau ubah status ke Coming Soon.`); row.querySelector('.sub-link').focus(); return; }
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
    showToast(oldAsset ? 'Perubahan aset tersimpan ke database online.' : 'Aset baru berhasil ditambahkan ke database online.');
  } catch (error) {
    console.error('Gagal menyimpan aset:', error);
    showToast(`Gagal menyimpan aset: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = oldAsset ? 'Simpan Perubahan' : 'Simpan Asset';
  }
}

async function deleteAsset(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset) return;
  if (!window.confirm(`Hapus "${asset.name}" dari database NL Production? Tindakan ini tidak dapat dibatalkan.`)) return;
  try {
    await runAdminMutation('deleteAsset', { id: String(id) });
    showToast('Aset berhasil dihapus dari database online.');
  } catch (error) {
    console.error('Gagal menghapus aset:', error);
    showToast(`Gagal menghapus aset: ${error.message}`);
  }
}

async function togglePublication(id) {
  const asset = assets.find(item => String(item.id) === String(id));
  if (!asset) return;
  const updatedAsset = { ...asset, publishStatus: asset.publishStatus === 'published' ? 'draft' : 'published' };
  try {
    await runAdminMutation('saveAsset', { asset: updatedAsset });
    showToast(updatedAsset.publishStatus === 'published' ? 'Aset sekarang tampil di katalog publik.' : 'Aset dipindahkan ke draft dan disembunyikan dari pengunjung.');
  } catch (error) {
    console.error('Gagal mengubah status publikasi:', error);
    showToast(`Status publikasi gagal diubah: ${error.message}`);
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  if (!isApiConfigured()) {
    showToast('URL Web App Apps Script belum diatur pada Script.js.');
    return;
  }
  const username = el('admin-username').value.trim();
  const password = el('admin-password').value;
  const submitButton = el('login-form').querySelector('button[type="submit"]');
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
    if (Array.isArray(result.assets)) applyAssetSnapshot(result.assets);
    el('login-form').reset();
    closeModal('login-modal');
    switchTab('admin');
    showToast('Login admin berhasil. Data terhubung ke Google Sheets.');
  } catch (error) {
    console.error('Login Apps Script gagal:', error);
    el('login-error').textContent = `Login gagal terhubung: ${error.message}`;
    el('login-error').hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Masuk Admin';
  }
}

async function logoutAdmin() {
  const token = getAdminToken();
  clearAdminSession();
  switchTab('user');
  showToast('Kamu sudah keluar dari panel admin.');
  if (token && isApiConfigured()) {
    try { await apiPost('logout', {}, token); } catch (error) { console.warn('Logout server tidak terkonfirmasi:', error); }
  }
  await refreshPublicCatalog(true);
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

function init() {
  // Sesi dianggap valid hanya bila token dari Apps Script juga berhasil diverifikasi.
  isAdminLoggedIn = false;
  el('current-year').textContent = String(new Date().getFullYear());

  document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.role)));
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderUserView();
  }));

  el('catalog-search').addEventListener('input', event => { catalogQuery = event.target.value; renderUserView(); });
  el('reset-catalog').addEventListener('click', () => {
    currentFilter = 'all'; catalogQuery = ''; el('catalog-search').value = '';
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
    renderUserView();
  });
  publicGrid.addEventListener('click', event => {
    const detailButton = event.target.closest('[data-detail-id]');
    if (detailButton) openAssetDetails(detailButton.dataset.detailId);
  });

  el('admin-search').addEventListener('input', event => { adminQuery = event.target.value; renderAdminView(); });
  el('admin-publish-filter').addEventListener('change', event => { adminPublicationFilter = event.target.value; renderAdminView(); });
  el('add-asset-btn').addEventListener('click', openAddModal);
  el('logout-btn').addEventListener('click', logoutAdmin);
  el('add-subfolder-btn').addEventListener('click', () => addSubfolderInputRow());
  el('login-form').addEventListener('submit', handleLoginSubmit);
  el('asset-form').addEventListener('submit', handleAssetFormSubmit);

  el('admin-table-body').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-id]');
    const remove = event.target.closest('[data-delete-id]');
    const publish = event.target.closest('[data-publish-id]');
    if (edit) openEditModal(edit.dataset.editId);
    else if (remove) deleteAsset(remove.dataset.deleteId);
    else if (publish) togglePublication(publish.dataset.publishId);
  });

  document.querySelectorAll('.modal-backdrop').forEach(modal => modal.addEventListener('click', handleModalClick));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop.is-open').forEach(modal => closeModal(modal.id));
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && el('user-view').classList.contains('active')) {
      event.preventDefault(); el('catalog-search').focus();
    }
  });

  renderUserView();
  renderAdminView();

  if (isApiConfigured()) {
    // Kunci juga sinkronisasi awal, supaya tidak bertabrakan dengan polling pertama.
    const runInitialSync = async () => {
      if (apiPollInProgress) return;
      apiPollInProgress = true;
      try {
        const savedToken = getAdminToken();
        if (savedToken) {
          const valid = await refreshAdminData(false);
          if (valid) switchTab('admin');
          else await refreshPublicCatalog(false);
        } else {
          await refreshPublicCatalog(false);
        }
      } finally {
        apiPollInProgress = false;
      }
    };
    runInitialSync();

    // Polling tiap 1,5 detik. Tidak memulai request baru jika polling sebelumnya belum selesai.
    window.setInterval(async () => {
      if (apiMutationInProgress || apiPollInProgress) return;
      apiPollInProgress = true;
      try {
        if (isAdminLoggedIn && getAdminToken()) await refreshAdminData(false);
        else await refreshPublicCatalog(false);
      } finally {
        apiPollInProgress = false;
      }
    }, API_POLL_INTERVAL_MS);
  }
}

init();
