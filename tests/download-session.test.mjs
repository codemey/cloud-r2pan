import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8797';
const adminKey = process.env.TEST_ADMIN_KEY || 'local-test-key';

test('Range requests share one download record and one download slot', async () => {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: adminKey }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const admin = (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { cookie, ...options.headers },
  });
  const postJson = (path, body) => admin(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const folder = `/download-session-${randomUUID()}`;
  const name = `session-${randomUUID()}.txt`;
  let fileId, shareId, parallelShareId, directId, folderShareId;
  try {
    assert.equal((await postJson('/api/admin/folders', { path: folder })).status, 201);
    const upload = await admin('/api/admin/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-folder-path': folder },
      body: '0123456789',
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    fileId = (await upload.json()).id;

    const share = await postJson('/api/admin/shares', { file_id: fileId, max_downloads: 1 });
    assert.equal(share.status, 201);
    shareId = (await share.json()).id;
    const shareUrl = `${base}/s/${shareId}/download`;
    assert.equal((await fetch(shareUrl, { method: 'HEAD' })).status, 200);
    const shareDownload = randomUUID();
    for (const range of ['bytes=0-3', 'bytes=4-9']) {
      const response = await fetch(`${shareUrl}?dl=${shareDownload}`, { headers: { range } });
      assert.equal(response.status, 206, await response.clone().text());
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${shareUrl}?dl=${randomUUID()}`, { headers: { range: 'bytes=0-1' } })).status, 410);

    const parallelShare = await postJson('/api/admin/shares', { file_id: fileId, max_downloads: 1 });
    assert.equal(parallelShare.status, 201);
    parallelShareId = (await parallelShare.json()).id;
    const parallelDownload = randomUUID();
    const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      fetch(`${base}/s/${parallelShareId}/download?dl=${parallelDownload}`, {
        headers: { range: `bytes=${index}-${index}` },
      })));
    assert.deepEqual(parallel.map((response) => response.status), Array(6).fill(206));
    await Promise.all(parallel.map((response) => response.arrayBuffer()));

    const direct = await postJson('/api/admin/direct-links', { file_id: fileId, max_downloads: 1 });
    assert.equal(direct.status, 201);
    const directData = await direct.json();
    directId = directData.id;
    const directUrl = `${base}${directData.url}`;
    for (const range of ['bytes=0-4', 'bytes=5-9']) {
      const response = await fetch(directUrl, { headers: { range } });
      assert.equal(response.status, 206, await response.clone().text());
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${directUrl}?dl=${randomUUID()}`, { headers: { range: 'bytes=0-1' } })).status, 410);

    const folderShare = await postJson('/api/admin/folder-shares', { path: folder });
    assert.equal(folderShare.status, 201);
    folderShareId = (await folderShare.json()).id;
    const verify = await fetch(`${base}/f/${folderShareId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(verify.status, 200);
    const ticket = (await verify.json()).ticket;
    const folderUrl = `${base}/f/${folderShareId}/file/${fileId}?t=${encodeURIComponent(ticket)}`;
    const folderDownload = randomUUID();
    for (const range of ['bytes=0-4', 'bytes=5-9']) {
      const response = await fetch(`${folderUrl}&dl=${folderDownload}`, { headers: { range } });
      assert.equal(response.status, 206, await response.clone().text());
      await response.arrayBuffer();
    }
    const next = await fetch(`${folderUrl}&dl=${randomUUID()}`, { headers: { range: 'bytes=0-1' } });
    assert.equal(next.status, 206);
    await next.arrayBuffer();

    const logsResponse = await admin(`/api/admin/logs?q=${encodeURIComponent(name)}`);
    assert.equal(logsResponse.status, 200);
    const logs = (await logsResponse.json()).logs;
    const rows = (token) => logs.filter((log) => log.share_id === token);
    assert.equal(rows(shareId).length, 1);
    assert.equal(rows(shareId)[0].bytes, 10);
    assert.equal(rows(parallelShareId).length, 1);
    assert.equal(rows(parallelShareId)[0].bytes, 6);
    assert.equal(rows(directId).length, 1);
    assert.equal(rows(directId)[0].bytes, 10);
    assert.equal(rows(folderShareId).length, 2);
    assert.deepEqual(rows(folderShareId).map((log) => log.bytes).sort((a, b) => a - b), [2, 10]);
  } finally {
    if (shareId) await admin(`/api/admin/shares/${shareId}`, { method: 'DELETE' });
    if (parallelShareId) await admin(`/api/admin/shares/${parallelShareId}`, { method: 'DELETE' });
    if (directId) await admin(`/api/admin/direct-links/${directId}`, { method: 'DELETE' });
    if (folderShareId) await admin(`/api/admin/folder-shares/${folderShareId}`, { method: 'DELETE' });
    if (fileId) await admin(`/api/admin/files/${fileId}`, { method: 'DELETE' });
    await admin(`/api/admin/folders?path=${encodeURIComponent(folder)}`, { method: 'DELETE' });
  }
});
