/*
 * SEC Physics Lab Inventory — web app
 * Talks to the Google Apps Script backend (Sheet for the inventory, Drive for photos).
 */
'use strict';

const STATUSES = ['Working', 'Broken', 'For Repair', 'Missing'];
const STATUS_COLORS = {
  'Working': '#16A34A',
  'Broken': '#DC2626',
  'For Repair': '#EA8A00',
  'Missing': '#9F1239',
};
const FIELDS = [
  { key: 'item_name', label: 'Name of Item', full: true, required: true },
  { key: 'description', label: 'Description', full: true, multiline: true },
  { key: 'qty_previous', label: 'Qty. Previous (M/Y)' },
  { key: 'qty_present', label: 'Qty. Present (M/Y)' },
  { key: 'status', label: 'Status', options: STATUSES },
  { key: 'date_acquired', label: 'Date Acquired' },
  { key: 'model_number', label: 'Model Number' },
  { key: 'serial_number', label: 'Serial Number' },
  { key: 'property_code', label: 'Property Code Number', full: true },
  { key: 'remarks', label: 'Remarks', full: true, multiline: true },
];
const PHOTO_SHORT_SIDE = 240;  // px ("240p"): 320x240 or 240x320, all the catalog cards need
const PHOTO_QUALITY = 0.7;     // JPEG quality; a photo ends up around 8–15 KB
const THUMB_BATCH = 24;        // photos fetched per request (matches the Apps Script limit)
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const FINE_POINTER = window.matchMedia('(pointer: fine)').matches;

const state = {
  items: [],
  photos: [],
  folderUrl: '',
  status: 'All',
  search: '',
  sort: 'no',
  uploading: new Map(),   // itemId -> number of uploads in progress
  previews: {},           // photoId -> data URL (fetched through the script, or just taken)
  loaded: false,
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ------------------------------------------------------------------ settings

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('physlab.' + key) || '';
    localStorage.setItem('physlab.' + key, value);
  } catch (e) {
    return '';
  }
}

const settings = {
  get url() { return store('apiUrl') || (window.APP_CONFIG && window.APP_CONFIG.API_URL) || ''; },
  get key() { return store('accessKey'); },
  get ready() { return Boolean(this.url && this.key); },
};

// ------------------------------------------------------------------ backend

async function api(action, payload = {}, conn = settings) {
  // text/plain body = "simple" CORS request, which Apps Script accepts without a preflight
  const res = await fetch(conn.url, {
    method: 'POST',
    body: JSON.stringify({ action, key: conn.key, ...payload }),
  });
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  let out;
  try {
    out = await res.json();
  } catch (e) {
    throw new Error('Unexpected reply. Check the web app URL and that it is deployed for "Anyone".');
  }
  if (!out.ok) throw new Error(out.error || 'Request failed');
  return out.data;
}

async function load() {
  if (!settings.ready) {
    renderEmpty('Connect the app to your Google Sheet to begin.');
    openSettings(true);
    return;
  }
  if (!state.loaded) renderEmpty('Loading inventory…');
  try {
    const data = await api('list');
    state.items = data.items;
    state.photos = data.photos;
    state.folderUrl = data.folderUrl;
    state.loaded = true;
    render();
  } catch (err) {
    renderEmpty('Could not load the inventory.\n' + err.message);
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------ helpers

const findItem = id => state.items.find(i => i.id === Number(id));
const photosOf = id => state.photos.filter(p => p.itemId === Number(id));
const coverOf = id => {
  const photos = photosOf(id);
  return photos.find(p => p.cover) || photos[0] || null;
};
const thumbUrl = photo => state.previews[photo.id] || BLANK;
const driveUrl = photo => `https://drive.google.com/file/d/${encodeURIComponent(photo.id)}/view`;

// ------------------------------------------------------------------ photo loading
// Photos come through the Apps Script as data URLs, so they show even when the
// Drive account doesn't allow link sharing. Only photos scrolled into view are fetched.

const thumbQueue = new Set();
const thumbLoading = new Set();
let thumbTimer;
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      thumbObserver.unobserve(entry.target);
      queueThumb(entry.target.dataset.photoId);
    }), { rootMargin: '400px' })
  : null;

function observeThumbs(root = document) {
  $$('img[data-photo-id]', root).forEach(img => {
    if (state.previews[img.dataset.photoId]) return;
    if (thumbObserver) thumbObserver.observe(img);
    else queueThumb(img.dataset.photoId);
  });
}

function queueThumb(id) {
  if (!id || state.previews[id] || thumbLoading.has(id)) return;
  thumbQueue.add(id);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(flushThumbs, 80);
}

async function flushThumbs() {
  while (thumbQueue.size) {
    const ids = [...thumbQueue].slice(0, THUMB_BATCH);
    ids.forEach(id => { thumbQueue.delete(id); thumbLoading.add(id); });
    try {
      const data = await api('thumbs', { ids });
      ids.forEach(id => {
        if (!data[id]) return;
        state.previews[id] = data[id];
        $$(`img[data-photo-id="${CSS.escape(id)}"]`).forEach(img => { img.src = data[id]; });
      });
    } catch (err) {
      console.warn('Could not load photos:', err.message);
    } finally {
      ids.forEach(id => thumbLoading.delete(id));
    }
  }
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
}

// ------------------------------------------------------------------ catalog rendering

function visibleItems() {
  const term = state.search.trim().toLowerCase();
  let items = state.items.filter(item => {
    if (state.status !== 'All' && item.status !== state.status) return false;
    if (!term) return true;
    return FIELDS.some(f => String(item[f.key] || '').toLowerCase().includes(term));
  });
  if (state.sort === 'name') {
    items = items.sort((a, b) => a.item_name.localeCompare(b.item_name));
  } else if (state.sort === 'status') {
    const rank = s => (STATUSES.indexOf(s) + 1) || 99;
    items = items.sort((a, b) => rank(a.status) - rank(b.status));
  } else if (state.sort === 'newest') {
    items = items.sort((a, b) => b.id - a.id);
  } else {
    items = items.sort((a, b) => a.id - b.id);
  }
  return items;
}

function renderChips() {
  const count = s => state.items.filter(i => i.status === s).length;
  $('#chips').innerHTML = ['All', ...STATUSES].map(s => `
    <button class="chip ${state.status === s ? 'on' : ''}" data-status="${esc(s)}" role="tab">
      ${esc(s)}<b>${s === 'All' ? state.items.length : count(s)}</b>
    </button>`).join('');
}

function cardHtml(item) {
  const cover = coverOf(item.id);
  const count = photosOf(item.id).length;
  const color = STATUS_COLORS[item.status] || '#6B7280';
  const meta = [`Qty: ${esc(item.qty_present) || '—'}`];
  if (item.property_code) meta.push(`Code: ${esc(item.property_code)}`);

  const photo = cover
    ? `<img src="${esc(thumbUrl(cover))}" data-photo-id="${esc(cover.id)}" alt="">`
    : `<div class="ph"><span>📷</span>${FINE_POINTER ? 'Drop a photo or click' : 'Tap to take a photo'}</div>`;

  return `
    <article class="card" data-id="${item.id}" title="Click to quick-edit Quantity, Status and Remarks">
      <div class="photo ${cover ? 'has' : ''}" data-action="photo" title="Take or add a photo">
        ${photo}
        ${count > 1 ? `<span class="badge">🖼 ${count}</span>` : ''}
        ${cover ? '<span class="camera-btn" aria-hidden="true">📷</span>' : ''}
        ${state.uploading.get(item.id) ? '<div class="uploading"><div class="spinner"></div>Saving to Drive…</div>' : ''}
      </div>
      <div class="body">
        <h3>${esc(item.item_name)}</h3>
        <p class="desc">${esc(item.description) || 'No description'}</p>
        <p class="meta">${meta.join(' · ')}</p>
        <span class="pill" style="--c:${color}">● ${esc(item.status) || 'No status'}</span>
      </div>
      <div class="actions">
        <button class="btn sm" data-action="edit">Edit</button>
        <button class="btn sm" data-action="photos">Photos</button>
        <button class="btn sm danger" data-action="delete">Delete</button>
      </div>
    </article>`;
}

function render() {
  renderChips();
  const items = visibleItems();
  $('#resultCount').textContent = `Showing ${items.length} of ${state.items.length}`;
  if (!items.length) {
    renderEmpty(state.items.length
      ? 'No items match your search or filter.'
      : '📦\nYour catalog is empty.\nClick “+ Add Item” to add the first material.');
    return;
  }
  $('#empty').hidden = true;
  $('#grid').hidden = false;
  $('#grid').innerHTML = items.map(cardHtml).join('');
  observeThumbs($('#grid'));
}

function renderCard(itemId) {
  const old = $(`.card[data-id="${itemId}"]`);
  const item = findItem(itemId);
  if (old && item) {
    old.outerHTML = cardHtml(item);
    observeThumbs($(`.card[data-id="${itemId}"]`));
  }
}

function renderEmpty(message) {
  $('#grid').hidden = true;
  $('#empty').hidden = false;
  $('#empty').textContent = message;
}

// ------------------------------------------------------------------ photos

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

/** Shrinks a camera photo to a 240p JPEG (PHOTO_SHORT_SIDE on its short side) */
async function prepareImage(file) {
  const img = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, PHOTO_SHORT_SIDE / Math.min(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  return { dataUrl, data: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
}

async function uploadPhotos(itemId, files, makeCover) {
  itemId = Number(itemId);
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) return;

  state.uploading.set(itemId, (state.uploading.get(itemId) || 0) + images.length);
  renderCard(itemId);
  let saved = 0;
  for (const [index, file] of images.entries()) {
    try {
      const image = await prepareImage(file);
      const photo = await api('uploadPhoto', {
        itemId, data: image.data, mimeType: image.mimeType, makeCover: makeCover && index === 0,
      });
      state.previews[photo.id] = image.dataUrl;
      if (photo.cover) photosOf(itemId).forEach(p => { p.cover = false; });
      state.photos.push(photo);
      saved++;
    } catch (err) {
      toast(`Photo not saved: ${err.message}`, true);
    } finally {
      state.uploading.set(itemId, state.uploading.get(itemId) - 1);
      renderCard(itemId);
      refreshGallery(itemId);
    }
  }
  if (saved) toast(saved === 1 ? 'Photo saved to Google Drive' : `${saved} photos saved to Google Drive`);
}

let pendingPhoto = null;   // { itemId, makeCover } for the hidden file inputs

function pickPhoto(itemId, { camera = true, makeCover = true } = {}) {
  pendingPhoto = { itemId, makeCover };
  const input = camera ? $('#cameraInput') : $('#fileInput');
  input.value = '';
  input.click();
}

function onPhotoPicked(e) {
  if (pendingPhoto && e.target.files.length) {
    const { itemId, makeCover } = pendingPhoto;
    if (typeof itemId === 'function') itemId(e.target.files);   // add/edit form stages the file
    else uploadPhotos(itemId, e.target.files, makeCover);
  }
  pendingPhoto = null;
}

// ------------------------------------------------------------------ modals

function openModal(html, className = '') {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
  $('#modalRoot').append(overlay);
  const modal = overlay.firstElementChild;
  modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(modal); });
  return modal;
}

function closeModal(modal) {
  const overlay = modal.closest('.overlay');
  if (overlay) overlay.remove();
  if (modal.onClose) modal.onClose();
}

function topModal() {
  const overlays = $$('#modalRoot .overlay');
  return overlays.length ? overlays[overlays.length - 1].firstElementChild : null;
}

// ------------------------------------------------------------------ quick edit

function quickEdit(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  const modal = openModal(`
    <div class="modal-head"><h2>${esc(item.item_name)}</h2><button class="x" data-close aria-label="Close">✕</button></div>
    <div class="tabs">
      ${['Quantity', 'Status', 'Remarks'].map((t, i) => `<button class="tab" data-page="${i}">${t}</button>`).join('')}
    </div>
    <div class="pages">
      <section class="page">
        <label>Qty. Present (M/Y)<input class="big qty" value="${esc(item.qty_present)}" enterkeyhint="done"></label>
        <p class="muted">Previous: ${esc(item.qty_previous) || '—'}</p>
      </section>
      <section class="page">
        <div class="status-grid">
          ${STATUSES.map((s, i) => `<button class="status-btn" data-status="${esc(s)}" style="--c:${STATUS_COLORS[s]}">${i + 1}&nbsp;&nbsp;${esc(s)}</button>`).join('')}
        </div>
      </section>
      <section class="page"><textarea class="remarks" rows="4">${esc(item.remarks)}</textarea></section>
    </div>
    <div class="quick-foot">
      <button class="btn sm" data-step="-1" aria-label="Previous field">◀</button>
      <span class="hint muted"></span>
      <button class="btn sm" data-step="1" aria-label="Next field">▶</button>
      <button class="btn primary" data-save>Save</button>
    </div>`, 'quick');

  const pages = $$('.page', modal), tabs = $$('.tab', modal);
  const qty = $('.qty', modal), remarks = $('.remarks', modal), hint = $('.hint', modal);
  const hints = FINE_POINTER
    ? ['← → switch · Enter save', '1–4 pick · ← → switch', 'Ctrl+Enter save']
    : ['Swipe or ◀ ▶ to switch', 'Tap a status', 'Swipe or ◀ ▶ to switch'];
  let page = 0;
  let status = item.status;

  const paintStatus = () => $$('.status-btn', modal).forEach(b => b.classList.toggle('on', b.dataset.status === status));
  function show(index) {
    page = (index + pages.length) % pages.length;
    pages.forEach((p, i) => { p.hidden = i !== page; });
    tabs.forEach((t, i) => t.classList.toggle('on', i === page));
    hint.textContent = hints[page];
    if (!FINE_POINTER) return;   // don't pop up the phone keyboard on every switch
    if (page === 0) { qty.focus(); qty.select(); }
    else if (page === 1) modal.focus();
    else { remarks.focus(); remarks.setSelectionRange(remarks.value.length, remarks.value.length); }
  }

  // Arrows switch fields only when the text cursor can't move further that way
  function atEdge(el, left) {
    const start = el.selectionStart, end = el.selectionEnd, len = el.value.length;
    if (el === qty && start === 0 && end === len) return true;
    if (start !== end) return false;
    return left ? start === 0 : start === len;
  }

  async function save() {
    const button = $('[data-save]', modal);
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const updated = await api('updateItem', {
        id: item.id,
        changes: { qty_present: qty.value, status, remarks: remarks.value },
      });
      Object.assign(item, updated);
      closeModal(modal);
      render();
      toast(`Updated ${item.item_name}`);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      button.textContent = 'Save';
    }
  }

  modal.addEventListener('click', e => {
    const tab = e.target.closest('[data-page]');
    const step = e.target.closest('[data-step]');
    const pick = e.target.closest('[data-status]');
    if (tab) show(Number(tab.dataset.page));
    if (step) show(page + Number(step.dataset.step));
    if (pick) { status = pick.dataset.status; paintStatus(); }
    if (e.target.closest('[data-save]')) save();
  });

  modal.addEventListener('keydown', e => {
    const inText = e.target === qty || e.target === remarks;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plain) {
      if (!inText || atEdge(e.target, e.key === 'ArrowLeft')) {
        e.preventDefault();
        show(page + (e.key === 'ArrowRight' ? 1 : -1));
      }
    } else if (e.key === 'Enter') {
      if (e.target === remarks && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      save();
    } else if (page === 1 && /^[1-4]$/.test(e.key)) {
      status = STATUSES[Number(e.key) - 1];
      paintStatus();
    } else if (page === 1 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const i = Math.max(STATUSES.indexOf(status), 0) + (e.key === 'ArrowUp' ? -1 : 1);
      status = STATUSES[(i + STATUSES.length) % STATUSES.length];
      paintStatus();
    }
  });

  // Swipe left/right on phones
  let touchX = null;
  const area = $('.pages', modal);
  area.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  area.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) show(page + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  paintStatus();
  show(0);
  if (!FINE_POINTER) modal.focus();
}

// ------------------------------------------------------------------ add / edit form

function editItem(itemId) {
  const item = itemId ? findItem(itemId) : null;
  const cover = item ? coverOf(item.id) : null;
  let staged = null;   // File waiting to be uploaded on save

  const fieldHtml = f => {
    const value = item ? item[f.key] : (f.key === 'status' ? 'Working' : '');
    let input;
    if (f.options) {
      const options = f.options.includes(value) || !value ? f.options : [...f.options, value];
      input = `<select name="${f.key}">${options.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.multiline) {
      input = `<textarea name="${f.key}" rows="2">${esc(value)}</textarea>`;
    } else {
      input = `<input name="${f.key}" value="${esc(value)}" ${f.required ? 'required' : ''}>`;
    }
    return `<label class="${f.full ? 'full' : ''}">${esc(f.label)}${f.required ? ' *' : ''}${input}</label>`;
  };

  const modal = openModal(`
    <div class="modal-head"><h2>${item ? esc(item.item_name) : 'New Item'}</h2><button class="x" data-close aria-label="Close">✕</button></div>
    <form class="form-layout" novalidate>
      <div class="form-photo">
        <div class="photo ${cover ? 'has' : ''}" data-pick="camera">
          ${cover ? `<img src="${esc(thumbUrl(cover))}" data-photo-id="${esc(cover.id)}" alt="">` : '<div class="ph"><span>📷</span>Add a photo</div>'}
        </div>
        <div class="photo-actions">
          <button type="button" class="btn sm" data-pick="camera">📷 Take photo</button>
          <button type="button" class="btn sm" data-pick="file">Choose file</button>
        </div>
        <p class="note">The photo is saved to Google Drive and shown on the catalog card.</p>
      </div>
      <div class="fields">${FIELDS.map(fieldHtml).join('')}</div>
    </form>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save>${item ? 'Save Item' : 'Add Item'}</button>
    </div>`, 'wide');

  const form = $('form', modal);
  const photoBox = $('.form-photo .photo', modal);
  observeThumbs(modal);

  function stage(files) {
    staged = files[0];
    const url = URL.createObjectURL(staged);
    photoBox.classList.add('has');
    photoBox.innerHTML = `<img src="${url}" alt="">`;
    $('.note', modal).textContent = `New photo: ${staged.name || 'camera photo'} — saved to Drive when you click ${item ? 'Save Item' : 'Add Item'}.`;
  }

  modal.addEventListener('click', e => {
    const pick = e.target.closest('[data-pick]');
    if (pick) pickPhoto(stage, { camera: pick.dataset.pick === 'camera' });
    if (e.target.closest('[data-save]')) save();
  });
  setupDrop(photoBox, files => stage(files));
  form.addEventListener('submit', e => { e.preventDefault(); save(); });

  async function save() {
    const data = Object.fromEntries(new FormData(form).entries());
    if (!String(data.item_name || '').trim()) {
      toast('Please enter the name of the item.', true);
      form.elements.item_name.focus();
      return;
    }
    const button = $('[data-save]', modal);
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      let saved;
      if (item) {
        saved = await api('updateItem', { id: item.id, changes: data });
        Object.assign(item, saved);
      } else {
        saved = await api('addItem', { item: data });
        state.items.push(saved);
      }
      closeModal(modal);
      render();
      toast(item ? 'Item saved' : 'Item added');
      if (staged) uploadPhotos(saved.id, [staged], true);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      button.textContent = item ? 'Save Item' : 'Add Item';
    }
  }

  if (FINE_POINTER) form.elements.item_name.focus();
}

// ------------------------------------------------------------------ gallery

function galleryHtml(itemId) {
  const photos = photosOf(itemId).sort((a, b) => (b.cover - a.cover));
  const uploading = state.uploading.get(itemId);
  if (!photos.length && !uploading) {
    return '<p class="muted">No photos yet. Take one with the camera or choose files.</p>';
  }
  return `<div class="gallery">
    ${photos.map(p => `
      <div class="shot ${p.cover ? 'cover' : ''}">
        <img src="${esc(thumbUrl(p))}" data-photo-id="${esc(p.id)}" alt="">
        <div class="cap">${p.cover ? '★ Cover · ' : ''}${esc(p.uploaded || p.name)}</div>
        <div class="row">
          ${p.cover ? '' : `<button class="btn" data-cover="${esc(p.id)}">★ Cover</button>`}
          <a class="btn" href="${esc(driveUrl(p))}" target="_blank" rel="noopener">Open</a>
          <button class="btn danger" data-remove="${esc(p.id)}">Delete</button>
        </div>
      </div>`).join('')}
    ${uploading ? '<div class="shot"><div class="photo"><div class="uploading"><div class="spinner"></div>Saving…</div></div></div>' : ''}
  </div>`;
}

function openGallery(itemId) {
  const item = findItem(itemId);
  if (!item) return;
  const modal = openModal(`
    <div class="modal-head"><h2>Photos — ${esc(item.item_name)}</h2><button class="x" data-close aria-label="Close">✕</button></div>
    <div class="gallery-actions">
      <button class="btn primary" data-pick="camera">📷 Take photo</button>
      <button class="btn" data-pick="file">Choose photos…</button>
      ${state.folderUrl ? `<a class="btn" href="${esc(state.folderUrl)}" target="_blank" rel="noopener">Open Drive folder</a>` : ''}
    </div>
    <div class="gallery-body">${galleryHtml(item.id)}</div>`, 'wide');
  observeThumbs(modal);
  modal.dataset.gallery = item.id;
  setupDrop(modal, files => uploadPhotos(item.id, files, false));

  modal.addEventListener('click', async e => {
    const pick = e.target.closest('[data-pick]');
    const cover = e.target.closest('[data-cover]');
    const remove = e.target.closest('[data-remove]');
    if (pick) pickPhoto(item.id, { camera: pick.dataset.pick === 'camera', makeCover: false });
    try {
      if (cover) {
        await api('setCover', { itemId: item.id, photoId: cover.dataset.cover });
        photosOf(item.id).forEach(p => { p.cover = p.id === cover.dataset.cover; });
        refreshGallery(item.id);
        renderCard(item.id);
      }
      if (remove && confirm('Delete this photo? It moves to the Google Drive trash.')) {
        await api('deletePhoto', { photoId: remove.dataset.remove });
        state.photos = state.photos.filter(p => p.id !== remove.dataset.remove);
        refreshGallery(item.id);
        renderCard(item.id);
        toast('Photo deleted');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function refreshGallery(itemId) {
  const modal = $(`.modal[data-gallery="${itemId}"]`);
  if (!modal) return;
  $('.gallery-body', modal).innerHTML = galleryHtml(Number(itemId));
  observeThumbs(modal);
}

// ------------------------------------------------------------------ delete & settings

async function deleteItem(itemId) {
  const item = findItem(itemId);
  if (!item || !confirm(`Delete “${item.item_name}”?\nIts photos stay in the Google Drive folder.`)) return;
  try {
    await api('deleteItem', { id: item.id });
    state.items = state.items.filter(i => i.id !== item.id);
    state.photos = state.photos.filter(p => p.itemId !== item.id);
    render();
    toast('Item deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

function openSettings(firstRun = false) {
  if ($('.modal.settings')) return;
  const modal = openModal(`
    <div class="modal-head"><h2>${firstRun ? 'Connect to Google' : 'Connection settings'}</h2>
      ${firstRun ? '' : '<button class="x" data-close aria-label="Close">✕</button>'}</div>
    <p>Paste the Apps Script web app URL and the access key (in the Google Sheet:
       <b>Physics Lab → Show access key</b>). This device will remember them.</p>
    <label>Web app URL<input name="url" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label>Access key<input name="key" value="${esc(settings.key)}" autocomplete="off"></label>
    <div class="modal-foot">
      ${firstRun ? '' : '<button class="btn" data-close>Cancel</button>'}
      <button class="btn primary" data-connect>Connect</button>
    </div>`, 'settings');

  $('[data-connect]', modal).addEventListener('click', async () => {
    const conn = { url: $('[name=url]', modal).value.trim(), key: $('[name=key]', modal).value.trim() };
    if (!conn.url || !conn.key) { toast('Enter both the URL and the access key.', true); return; }
    const button = $('[data-connect]', modal);
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      await api('list', {}, conn);
      store('apiUrl', conn.url);
      store('accessKey', conn.key);
      closeModal(modal);
      toast('Connected');
      state.loaded = false;
      load();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });
}

// ------------------------------------------------------------------ drag & drop (desktop)

function setupDrop(el, onFiles) {
  el.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    el.classList.add('drag');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag');
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------ wiring

function init() {
  const grid = $('#grid');

  grid.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const action = e.target.closest('[data-action]');
    switch (action && action.dataset.action) {
      case 'photo': pickPhoto(id); break;
      case 'edit': editItem(id); break;
      case 'photos': openGallery(id); break;
      case 'delete': deleteItem(id); break;
      default: quickEdit(id);
    }
  });

  // Drop a photo onto a card's picture
  grid.addEventListener('dragover', e => {
    const photo = e.target.closest('.photo');
    if (!photo || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    $$('.photo.drag', grid).forEach(p => p !== photo && p.classList.remove('drag'));
    photo.classList.add('drag');
  });
  grid.addEventListener('dragleave', e => {
    const photo = e.target.closest('.photo');
    if (photo && !photo.contains(e.relatedTarget)) photo.classList.remove('drag');
  });
  grid.addEventListener('drop', e => {
    const photo = e.target.closest('.photo');
    if (!photo) return;
    e.preventDefault();
    photo.classList.remove('drag');
    uploadPhotos(photo.closest('.card').dataset.id, e.dataTransfer.files, true);
  });

  $('#chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-status]');
    if (chip) { state.status = chip.dataset.status; render(); }
  });
  let searchTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; render(); }, 150);
  });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
  $('#addBtn').addEventListener('click', () => editItem(null));
  $('#refreshBtn').addEventListener('click', () => load());
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#cameraInput').addEventListener('change', onPhotoPicked);
  $('#fileInput').addEventListener('change', onPhotoPicked);

  document.addEventListener('keydown', e => {
    const modal = topModal();
    if (e.key === 'Escape' && modal && !modal.classList.contains('settings')) closeModal(modal);
    else if (!modal && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#search').focus();
    }
  });

  load();
}

init();
