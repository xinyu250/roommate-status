import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../netlify/functions/api.mjs';

test('health works without credentials', async () => {
  assert.deepEqual(await (await handler(new Request('https://test/api/health'))).json(), { ok: true });
});

test('invalid writes are rejected before accessing Feishu', async () => {
  const result = await handler(new Request('https://test/api/roommates', { method: 'POST', body: '{}' }));
  assert.equal(result.status, 400);
});

test('read failures return 502 rather than an empty successful list', async () => {
  globalThis.Netlify = { env: { get: () => '' } };
  const result = await handler(new Request('https://test/api/roommates'));
  assert.equal(result.status, 502);
});

test('GET follows pagination and retains the frontend response shape', async () => {
  globalThis.Netlify = { env: { get: () => 'test' } };
  const originalFetch = globalThis.fetch;
  let pages = 0;
  globalThis.fetch = async url => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'test' });
    pages++;
    return Response.json({ code: 0, data: { items: [{ record_id: `rec${pages}`, fields: { name: `person${pages}`, status: '学习中', updated_at: 1 } }], has_more: pages === 1, page_token: 'next' } });
  };
  try {
    const result = await handler(new Request('https://test/api/roommates'));
    const { roommates } = await result.json();
    assert.equal(pages, 2);
    assert.equal(roommates.length, 2);
    assert.equal(roommates[1].recordId, 'rec2');
    assert.equal(roommates[0].updatedAt, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('existing roommate update waits for persistence and does not create a duplicate', async () => {
  globalThis.Netlify = { env: { get: () => 'test' } };
  const originalFetch = globalThis.fetch;
  const writes = [];
  let finishWrite;
  const writeStarted = new Promise(resolve => { finishWrite = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'test' });
    if (options.method === 'GET') return Response.json({ code: 0, data: { items: [{ record_id: 'existing', fields: { name: 'Alice' } }] } });
    if (url.includes('/records')) {
      writes.push({ url, method: options.method });
      finishWrite();
      await gate;
    }
    return Response.json({ code: 0, data: {} });
  };
  try {
    let responded = false;
    const resultPromise = handler(new Request('https://test/api/roommates', { method: 'POST', body: JSON.stringify({ name: 'Alice', status: '学习中' }) })).then(r => { responded = true; return r; });
    await writeStarted;
    assert.equal(responded, false);
    release();
    assert.deepEqual(await (await resultPromise).json(), { success: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'PUT');
    assert.ok(writes[0].url.endsWith('/existing'));
  } finally { release(); globalThis.fetch = originalFetch; }
});
