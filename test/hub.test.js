'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, loadRegistry } = require('../src/app');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

const MANIFEST = {
  protocol: '3d-conv/1',
  id: 'card',
  name: '卡片',
  inputs: [{ key: 'front', label: '正面', required: true }],
  options: [],
  output: { format: 'glb', extension: '.glb' },
};

/** Stand-in for a converter repo such as card-uploader. */
async function startFakeConverter({ manifest = MANIFEST } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === 'GET' && req.url === '/api/convert/manifest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(manifest));
    }
    if (req.method === 'POST' && req.url === '/api/convert') {
      if (!body.includes('name="front"')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '請上傳正面圖片（front）' }));
      }
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-disposition': 'attachment; filename="card.glb"',
        'x-model-dimensions': '63x88x0.6mm',
        'x-secret-internal': 'nope',
      });
      return res.end(Buffer.concat([Buffer.from('glTF'), body.subarray(0, 0)]));
    }
    res.writeHead(404).end();
  });
  const url = await listen(server);
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

async function startHub(converters, options = {}) {
  const app = createApp({ converters, env: {}, ...options });
  const server = http.createServer(app);
  const base = await listen(server);
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const frontForm = () => {
  const f = new FormData();
  f.append('front', new Blob([Buffer.from('fake png')], { type: 'image/png' }), 'front.png');
  f.append('thickness', '0.6');
  return f;
};

test('registry: env overrides the URL, entries without a URL are "coming soon"', () => {
  const list = loadRegistry({
    entries: [
      { id: 'card', name: '卡片', url: 'http://localhost:3000/' },
      { id: 'hat', name: '帽子', url: null },
      { id: 'book-2', name: '書本' },
    ],
    env: { CONVERTER_HAT_URL: 'https://hat.example.com', CONVERTER_BOOK_2_URL: 'https://book.example.com' },
  });
  assert.deepEqual(list.map((c) => c.endpoint), [
    'http://localhost:3000/api/convert',
    'https://hat.example.com/api/convert',
    'https://book.example.com/api/convert',
  ]);
  const blank = loadRegistry({ entries: [{ id: 'card', url: 'http://localhost:3000' }], env: { CONVERTER_CARD_URL: '' } });
  assert.equal(blank[0].endpoint, 'http://localhost:3000/api/convert', 'an empty variable keeps the default');
  assert.throws(() => loadRegistry({ entries: [{ id: 'Bad Id' }], env: {} }), /id/);
  assert.throws(() => loadRegistry({ entries: [{ id: 'x', type: 'magic' }], env: {} }), /type/);
  const embed = loadRegistry({ entries: [{ id: 'char', type: 'embed', url: 'https://a.example/app/' }], env: {} });
  assert.equal(embed[0].url, 'https://a.example/app/');
  assert.equal(embed[0].endpoint, null);
  assert.throws(() => loadRegistry({ entries: [{ id: 'a' }, { id: 'a' }], env: {} }), /重複/);
  assert.throws(() => loadRegistry({ entries: [{ id: 'a', url: 'ftp://x' }], env: {} }), /http/);
});

test('the shipped converters.json lists card (live) plus hat and book (coming soon)', async (t) => {
  const app = createApp({ env: {} });
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  const list = await (await fetch(`${base}/api/converters`)).json();
  assert.deepEqual(list.map((c) => [c.id, c.type, c.available]), [
    ['card', 'api', true], ['char', 'embed', true], ['hat', 'api', false], ['book', 'api', false],
  ]);
  assert.equal(list[0].endpoint, undefined, 'converter URLs are not exposed');
  assert.equal(list[0].url, undefined, 'API converter URLs stay behind the proxy');
  assert.equal(list[1].url, 'https://dot7dot.github.io/char-3d-converter-/', 'an embedded page keeps its trailing slash');
  assert.equal(list[1].repo, 'Dot7dot/char-3d-converter-');

  // An embedded page has no manifest or convert API.
  const res = await fetch(`${base}/api/converters/char/manifest`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /嵌入式/);
  const page = await fetch(base);
  assert.match(await page.text(), /3D 轉換屋/);
  const viewer = await fetch(`${base}/vendor/model-viewer.min.js`);
  assert.equal(viewer.status, 200);
});

test('manifest and convert are proxied to the converter repo', async (t) => {
  const conv = await startFakeConverter();
  t.after(conv.close);
  const hub = await startHub([{ id: 'card', name: '卡片', url: conv.url, repo: 'Dot7dot/card-uploader' }]);
  t.after(hub.close);

  const m = await (await fetch(`${hub.base}/api/converters/card/manifest`)).json();
  assert.equal(m.protocol, '3d-conv/1');
  assert.equal(m.repo, 'Dot7dot/card-uploader');

  const res = await fetch(`${hub.base}/api/converters/card/convert`, { method: 'POST', body: frontForm() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(res.headers.get('x-model-dimensions'), '63x88x0.6mm');
  assert.match(res.headers.get('content-disposition'), /card\.glb/);
  assert.equal(res.headers.get('x-secret-internal'), null);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'glTF');

  const post = conv.seen.find((s) => s.method === 'POST');
  assert.match(post.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(post.body.includes('fake png'));
  assert.ok(post.body.includes('name="thickness"'));
});

test('converter validation errors reach the user unchanged', async (t) => {
  const conv = await startFakeConverter();
  t.after(conv.close);
  const hub = await startHub([{ id: 'card', name: '卡片', url: conv.url }]);
  t.after(hub.close);
  const f = new FormData();
  f.append('back', new Blob(['x'], { type: 'image/png' }), 'b.png');
  const res = await fetch(`${hub.base}/api/converters/card/convert`, { method: 'POST', body: f });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, '請上傳正面圖片（front）');
});

test('unknown, unavailable, unreachable and incompatible converters give clear errors', async (t) => {
  const bad = await startFakeConverter({ manifest: { hello: 'world' } });
  t.after(bad.close);
  const hub = await startHub([
    { id: 'card', name: '卡片', url: 'http://127.0.0.1:9' },
    { id: 'hat', name: '帽子', url: null },
    { id: 'old', name: '舊版', url: bad.url },
  ]);
  t.after(hub.close);

  let res = await fetch(`${hub.base}/api/converters/nope/manifest`);
  assert.equal(res.status, 404);

  res = await fetch(`${hub.base}/api/converters/hat/manifest`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /還沒有上線/);

  res = await fetch(`${hub.base}/api/converters/card/manifest`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /無法連線/);

  res = await fetch(`${hub.base}/api/converters/card/convert`, { method: 'POST', body: frontForm() });
  assert.equal(res.status, 502);

  res = await fetch(`${hub.base}/api/converters/old/manifest`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /3d-conv\/1/);

  res = await fetch(`${hub.base}/api/converters/old/convert`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 400);
});

test('uploads over the size limit are refused', async (t) => {
  const conv = await startFakeConverter();
  t.after(conv.close);
  const hub = await startHub([{ id: 'card', name: '卡片', url: conv.url }], { maxUploadMb: 0.001 });
  t.after(hub.close);
  const f = new FormData();
  f.append('front', new Blob([Buffer.alloc(5000)], { type: 'image/png' }), 'f.png');
  const res = await fetch(`${hub.base}/api/converters/card/convert`, { method: 'POST', body: f });
  assert.equal(res.status, 413);
  assert.equal(conv.seen.filter((s) => s.method === 'POST').length, 0);
});
