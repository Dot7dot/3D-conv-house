'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const PROTOCOL = '3d-conv/1';
const DEFAULT_PATH = '/api/convert';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** CONVERTER_<ID>_URL, e.g. CONVERTER_CARD_URL for id "card". */
const envKey = (id) => `CONVERTER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;

/**
 * Reads converters.json. Each entry is one converter repo; an entry without a
 * URL is listed in the UI as "coming soon". The URL can be overridden per
 * deployment with CONVERTER_<ID>_URL.
 */
function loadRegistry({ file, entries, env = process.env }) {
  const list = entries ?? JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error('converters.json 必須是陣列');
  const seen = new Set();
  return list.map((raw) => {
    const id = String(raw.id || '').trim();
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`轉換器 id 只能用小寫英數與 -：「${raw.id}」`);
    if (seen.has(id)) throw new Error(`轉換器 id 重複：${id}`);
    seen.add(id);
    // An empty variable (e.g. an unset GitHub Actions variable) means "not set".
    const url = (env[envKey(id)]?.trim() || raw.url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) throw new Error(`${envKey(id)} 必須是 http(s) 網址：${url}`);
    return {
      id,
      name: String(raw.name || id),
      icon: raw.icon || '📦',
      repo: raw.repo || null,
      url: url || null,
      path: raw.path || DEFAULT_PATH,
      endpoint: url ? url + (raw.path || DEFAULT_PATH) : null,
    };
  });
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function createApp(options = {}) {
  const env = options.env ?? process.env;
  const converters = loadRegistry({
    file: options.registryFile ?? path.join(__dirname, '..', 'converters.json'),
    entries: options.converters,
    env,
  });
  const byId = new Map(converters.map((c) => [c.id, c]));
  const maxUploadBytes = (options.maxUploadMb ?? Number(env.MAX_UPLOAD_MB || 40)) * 1024 * 1024;
  // Free hosts (e.g. Render) sleep when idle and need up to a minute to wake.
  const manifestTimeout = options.manifestTimeoutMs ?? 75_000;
  const convertTimeout = options.convertTimeoutMs ?? 120_000;

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  const api = express.Router();

  const converterFor = (req) => {
    const c = byId.get(req.params.id);
    if (!c) throw new HttpError(404, '沒有這個轉換器');
    if (!c.endpoint) throw new HttpError(503, `「${c.name}」轉換器還沒有上線`);
    return c;
  };

  const unreachable = (c, err) => {
    if (err.name === 'AbortError') return new HttpError(504, `「${c.name}」轉換器沒有回應，請稍後再試`);
    console.error(`[${c.id}] ${err.message}`);
    return new HttpError(502, `無法連線到「${c.name}」轉換器`);
  };

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.get('/converters', (req, res) => {
    res.json(converters.map(({ id, name, icon, repo, endpoint }) => ({ id, name, icon, repo, available: Boolean(endpoint) })));
  });

  api.get('/converters/:id/manifest', async (req, res) => {
    const c = converterFor(req);
    let r;
    try {
      r = await fetchWithTimeout(`${c.endpoint}/manifest`, { headers: { accept: 'application/json' } }, manifestTimeout);
    } catch (err) {
      throw unreachable(c, err);
    }
    let manifest;
    try {
      manifest = await r.json();
    } catch {
      throw new HttpError(502, `「${c.name}」轉換器回傳的不是 JSON`);
    }
    if (!r.ok) throw new HttpError(502, manifest?.error || `「${c.name}」轉換器錯誤（${r.status}）`);
    if (manifest?.protocol !== PROTOCOL || !Array.isArray(manifest.inputs)) {
      throw new HttpError(502, `「${c.name}」轉換器不支援 ${PROTOCOL} 協定`);
    }
    res.set('Cache-Control', 'no-store').json({ ...manifest, id: c.id, repo: c.repo });
  });

  // The multipart body is streamed straight through to the converter.
  api.post('/converters/:id/convert', async (req, res) => {
    const c = converterFor(req);
    if (!req.is('multipart/form-data')) throw new HttpError(400, '請用 multipart/form-data 上傳');
    const declared = Number(req.get('content-length') || 0);
    if (declared > maxUploadBytes) throw new HttpError(413, `上傳內容不可超過 ${maxUploadBytes / 1024 / 1024} MB`);

    let tooLarge = false;
    async function* limited() {
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > maxUploadBytes) {
          tooLarge = true;
          throw new Error('too large');
        }
        yield chunk;
      }
    }

    const headers = { 'content-type': req.get('content-type') };
    if (declared) headers['content-length'] = String(declared);
    let r;
    try {
      r = await fetchWithTimeout(c.endpoint, { method: 'POST', headers, body: limited(), duplex: 'half' }, convertTimeout);
    } catch (err) {
      if (tooLarge) throw new HttpError(413, `上傳內容不可超過 ${maxUploadBytes / 1024 / 1024} MB`);
      throw unreachable(c, err);
    }

    const body = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      let message;
      try {
        message = JSON.parse(body.toString('utf8')).error;
      } catch { /* not JSON */ }
      // Converter validation errors (4xx) are shown to the user as-is.
      throw new HttpError(r.status >= 500 ? 502 : r.status, message || `「${c.name}」轉換失敗（${r.status}）`);
    }
    for (const h of ['content-type', 'content-disposition', 'x-model-dimensions']) {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('Cache-Control', 'no-store').send(body);
  });

  api.use((req, res) => res.status(404).json({ error: '找不到這個 API' }));
  app.use('/api', api);

  // 3D preview component, served locally so the page works without a CDN.
  const modelViewerDir = path.dirname(require.resolve('@google/model-viewer/dist/model-viewer.min.js'));
  app.get('/vendor/model-viewer.min.js', (req, res) => {
    res.sendFile(path.join(modelViewerDir, 'model-viewer.min.js'), { maxAge: '7d' });
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (status >= 500 && !(err instanceof HttpError)) {
      console.error(err);
      message = '伺服器發生錯誤';
      status = 500;
    }
    res.status(status).json({ error: message });
  });

  app.locals.converters = converters;
  return app;
}

module.exports = { createApp, loadRegistry, envKey, PROTOCOL };
