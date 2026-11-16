'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  item: $('item'),
  manifestState: $('manifestState'),
  details: $('details'),
  settings: $('settings'),
  description: $('description'),
  instructions: $('instructions'),
  repoLink: $('repoLink'),
  options: $('options'),
  convert: $('convert'),
  status: $('status'),
  workEmpty: $('workEmpty'),
  workEmptyText: $('workEmptyText'),
  uploads: $('uploads'),
  result: $('result'),
  resultInfo: $('resultInfo'),
  viewer: $('viewer'),
  download: $('download'),
  slotTemplate: $('slotTemplate'),
};

const STORE_KEY = 'conv-house:item';
const store = {
  get() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, v); } catch { /* private mode */ } },
};

const state = {
  converters: [],
  manifest: null,
  files: {}, // input key → { blob, name, previewUrl }
  resultUrl: null,
  loadToken: 0,
  busy: false,
};

async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `錯誤 ${res.status}`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function setWorkEmpty(text) {
  els.workEmptyText.textContent = text;
  els.workEmpty.hidden = false;
  els.uploads.hidden = true;
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  els.viewer.removeAttribute('src');
  els.result.hidden = true;
}

function clearFiles() {
  for (const f of Object.values(state.files)) URL.revokeObjectURL(f.previewUrl);
  state.files = {};
}

/* ---------- Converter list (ITEMS) ---------- */

async function loadConverters() {
  try {
    state.converters = await (await api('/api/converters')).json();
  } catch (err) {
    els.item.innerHTML = '<option>無法載入</option>';
    els.item.disabled = true;
    showManifestState(`無法載入轉換器清單：${err.message}`, true);
    return;
  }
  els.item.innerHTML = '';
  const placeholder = new Option('— 選擇物件 —', '');
  placeholder.disabled = true;
  els.item.add(placeholder);
  for (const c of state.converters) {
    const opt = new Option(`${c.icon} ${c.name}${c.available ? '' : '（即將推出）'}`, c.id);
    opt.disabled = !c.available;
    els.item.add(opt);
  }
  const saved = store.get();
  const initial = state.converters.find((c) => c.available && c.id === saved)
    || state.converters.find((c) => c.available);
  if (initial) {
    els.item.value = initial.id;
    selectConverter(initial.id);
  } else {
    els.item.value = '';
  }
}

function showManifestState(text, isError = false) {
  els.manifestState.textContent = text;
  els.manifestState.className = `state${isError ? ' error' : ''}`;
  els.manifestState.hidden = false;
}

async function selectConverter(id) {
  const token = ++state.loadToken;
  const converter = state.converters.find((c) => c.id === id);
  store.set(id);
  state.manifest = null;
  clearResult();
  clearFiles();
  els.details.hidden = true;
  els.settings.hidden = true;
  setStatus('');
  setWorkEmpty(`正在連線到「${converter.name}」轉換器…`);
  showManifestState('正在讀取轉換器需要的資料…');

  // Free hosting sleeps when idle; tell the user why it is slow.
  const slow = setTimeout(() => {
    if (token === state.loadToken) showManifestState('轉換器可能在休眠中，正在喚醒，最多約 1 分鐘…');
  }, 3000);

  try {
    const manifest = await (await api(`/api/converters/${encodeURIComponent(id)}/manifest`)).json();
    if (token !== state.loadToken) return;
    state.manifest = manifest;
    renderManifest(manifest);
    els.manifestState.hidden = true;
  } catch (err) {
    if (token !== state.loadToken) return;
    showManifestState(err.message, true);
    setWorkEmpty('轉換器目前無法使用');
  } finally {
    clearTimeout(slow);
  }
}

/* ---------- Manifest → instructions, upload slots, options ---------- */

function renderManifest(m) {
  els.description.textContent = m.description || '';
  els.instructions.innerHTML = '';
  for (const line of [].concat(m.instructions || [])) {
    const p = document.createElement('p');
    p.textContent = line;
    els.instructions.append(p);
  }
  if (m.repo) {
    els.repoLink.textContent = m.repo;
    els.repoLink.href = `https://github.com/${m.repo}`;
    els.repoLink.parentElement.hidden = false;
  } else {
    els.repoLink.parentElement.hidden = true;
  }

  els.uploads.innerHTML = '';
  for (const input of m.inputs) els.uploads.append(createSlot(input));
  els.workEmpty.hidden = true;
  els.uploads.hidden = false;

  els.options.innerHTML = '';
  for (const opt of m.options || []) els.options.append(createOption(opt));
  els.options.hidden = !(m.options || []).length;

  els.details.hidden = false;
  els.settings.hidden = false;
  updateConvertButton();
}

function createSlot(input) {
  const node = els.slotTemplate.content.firstElementChild.cloneNode(true);
  const fileInput = node.querySelector('input');
  const img = node.querySelector('img');
  const empty = node.querySelector('.drop-empty');
  const remove = node.querySelector('.remove');
  const badge = node.querySelector('.badge');

  node.dataset.key = input.key;
  node.querySelector('.slot-label').textContent = input.label;
  badge.textContent = input.required ? '必填' : '選填';
  badge.classList.toggle('required', Boolean(input.required));
  node.querySelector('.slot-hint').textContent = input.hint || '';
  fileInput.accept = input.image ? 'image/*' : [].concat(input.accept || []).join(',');

  const show = () => {
    const f = state.files[input.key];
    img.hidden = !f;
    empty.hidden = Boolean(f);
    remove.hidden = !f;
    node.classList.toggle('filled', Boolean(f));
    if (f) {
      img.src = f.previewUrl;
      img.alt = `${input.label}：${f.name}`;
    } else {
      img.removeAttribute('src');
    }
    updateConvertButton();
  };

  const take = async (file) => {
    if (!file) return;
    setStatus(`處理「${input.label}」圖片中…`);
    try {
      const blob = await prepareFile(file, input);
      const old = state.files[input.key];
      if (old) URL.revokeObjectURL(old.previewUrl);
      state.files[input.key] = { blob, name: file.name, previewUrl: URL.createObjectURL(blob) };
      setStatus('');
    } catch (err) {
      setStatus(err.message, 'error');
    }
    show();
  };

  fileInput.addEventListener('change', () => {
    take(fileInput.files[0]);
    fileInput.value = '';
  });
  remove.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = state.files[input.key];
    if (f) URL.revokeObjectURL(f.previewUrl);
    delete state.files[input.key];
    show();
  });
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    node.classList.add('dragover');
  });
  node.addEventListener('dragleave', () => node.classList.remove('dragover'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('dragover');
    take(e.dataTransfer.files[0]);
  });

  show();
  return node;
}

/**
 * When a converter asks for images (input.image), they are decoded, rotated
 * per EXIF, scaled down to maxDimension and re-encoded as PNG or JPEG in the
 * browser, so phone photos, WEBP and HEIC (where the browser can read it) work.
 */
async function prepareFile(file, input) {
  const accept = [].concat(input.accept || []);
  if (!input.image) {
    if (accept.length && !accept.includes(file.type)) throw new Error(`${input.label} 只接受：${accept.join('、')}`);
    return file;
  }
  if (!file.type.startsWith('image/') && file.type !== '') throw new Error(`${input.label} 需要圖片檔`);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`瀏覽器讀不了「${file.name}」，請改用 PNG 或 JPG`);
  }
  const max = input.image.maxDimension || 4096;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const keepsAlpha = ['image/png', 'image/webp', 'image/gif'].includes(file.type);
  let type = keepsAlpha && accept.includes('image/png') ? 'image/png' : 'image/jpeg';
  if (accept.length && !accept.includes(type)) type = accept.find((t) => t === 'image/png' || t === 'image/jpeg') || type;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!blob) throw new Error('圖片轉換失敗');
  return blob;
}

function createOption(opt) {
  const wrap = document.createElement('label');
  wrap.className = 'opt';
  const title = document.createElement('span');
  title.textContent = opt.label;
  wrap.append(title);

  let control;
  if (opt.type === 'select') {
    control = document.createElement('select');
    for (const c of opt.choices || []) control.add(new Option(c.label, c.value));
    control.value = opt.default ?? '';
    wrap.classList.add('wide');
    wrap.append(control);
  } else if (opt.type === 'color') {
    control = document.createElement('input');
    control.type = 'color';
    control.value = opt.default || '#000000';
    wrap.append(control);
  } else {
    control = document.createElement('input');
    control.type = opt.type === 'number' ? 'number' : 'text';
    if (opt.type === 'number') {
      control.inputMode = 'decimal';
      for (const k of ['min', 'max', 'step']) if (opt[k] !== undefined) control[k] = opt[k];
    }
    control.value = opt.default ?? '';
    if (opt.unit) {
      const box = document.createElement('div');
      box.className = 'with-unit';
      const unit = document.createElement('i');
      unit.textContent = opt.unit;
      box.append(control, unit);
      wrap.append(box);
    } else {
      wrap.append(control);
    }
  }
  control.name = opt.key;
  if (opt.hint) {
    const hint = document.createElement('small');
    hint.textContent = opt.hint;
    wrap.append(hint);
  }
  return wrap;
}

function missingInputs() {
  return (state.manifest?.inputs || []).filter((i) => i.required && !state.files[i.key]);
}

function updateConvertButton() {
  const missing = missingInputs();
  els.convert.disabled = state.busy || !state.manifest || missing.length > 0;
  els.convert.title = missing.length ? `請先上傳：${missing.map((i) => i.label).join('、')}` : '';
}

/* ---------- Convert ---------- */

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg' };

function outputName(manifest) {
  const first = manifest.inputs.map((i) => state.files[i.key]).find(Boolean);
  const base = (first?.name || manifest.id).replace(/\.[^.]+$/, '').replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '') || manifest.id;
  return `${manifest.id}-${base}${manifest.output?.extension || '.glb'}`;
}

async function convert() {
  const m = state.manifest;
  if (!m || state.busy) return;
  const missing = missingInputs();
  if (missing.length) {
    setStatus(`請先上傳：${missing.map((i) => i.label).join('、')}`, 'error');
    return;
  }

  const form = new FormData();
  for (const input of m.inputs) {
    const f = state.files[input.key];
    if (f) form.append(input.key, f.blob, `${input.key}${EXT[f.blob.type] || ''}`);
  }
  for (const el of els.options.elements) {
    if (el.name) form.append(el.name, el.value);
  }

  state.busy = true;
  els.convert.classList.add('busy');
  els.convert.textContent = '轉換中…';
  updateConvertButton();
  setStatus('正在產生 3D 物件…');
  try {
    const res = await api(`/api/converters/${encodeURIComponent(m.id)}/convert`, { method: 'POST', body: form });
    const blob = await res.blob();
    clearResult();
    state.resultUrl = URL.createObjectURL(blob);
    els.viewer.src = state.resultUrl;
    els.download.href = state.resultUrl;
    els.download.download = outputName(m);
    const dims = res.headers.get('x-model-dimensions');
    const size = blob.size > 1024 * 1024 ? `${(blob.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(blob.size / 1024)} KB`;
    els.resultInfo.textContent = [dims && `尺寸 ${dims.replace(/x/g, ' × ')}`, size].filter(Boolean).join('　·　');
    els.result.hidden = false;
    setStatus('完成！可以預覽並下載 .glb。', 'ok');
    if (window.matchMedia('(max-width: 860px)').matches) els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    state.busy = false;
    els.convert.classList.remove('busy');
    els.convert.textContent = '開始轉換';
    updateConvertButton();
  }
}

els.item.addEventListener('change', () => selectConverter(els.item.value));
els.convert.addEventListener('click', convert);
els.options.addEventListener('submit', (e) => {
  e.preventDefault();
  convert();
});

// Paste an image into the first empty slot.
document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (!file || !state.manifest) return;
  const target = state.manifest.inputs.find((i) => !state.files[i.key]) || state.manifest.inputs[0];
  const slot = els.uploads.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
  slot?.dispatchEvent(Object.assign(new Event('drop', { cancelable: true }), { dataTransfer: { files: [file] } }));
});

loadConverters();
