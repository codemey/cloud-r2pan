import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8797';
const adminKey = process.env.TEST_ADMIN_KEY || 'local-test-key';

test('copied files share storage while keeping independent folder entries and links', async () => {
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
  const root = `/copy-test-${Date.now()}`;
  const sourceFolder = `${root}/source`;
  const targetFolder = `${root}/target`;
  let sourceId;
  try {
    for (const path of [root, sourceFolder, targetFolder]) {
      const response = await postJson('/api/admin/folders', { path });
      assert.equal(response.status, 201, await response.clone().text());
    }
    const uploaded = await admin('/api/admin/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': 'shared.txt', 'x-folder-path': sourceFolder },
      body: 'one stored object',
    });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    sourceId = (await uploaded.json()).id;
    const key = `files/${sourceId}`;

    const copies = await Promise.all([
      postJson(`/api/admin/files/${sourceId}/copy`, { path: targetFolder }),
      postJson(`/api/admin/files/${sourceId}/copy`, { path: targetFolder }),
    ]);
    assert.deepEqual(copies.map(response => response.status).sort(), [201, 409]);
    const copiedId = (await copies.find(response => response.status === 201).json()).id;
    assert.notEqual(copiedId, sourceId);
    assert.equal((await postJson(`/api/admin/files/${sourceId}/copy`, { path: targetFolder })).status, 409);
    assert.equal((await postJson(`/api/admin/files/${sourceId}/copy`, { path: `${root}/missing` })).status, 404);
    const extraCopy = await postJson(`/api/admin/files/${sourceId}/copy`, { path: root });
    assert.equal(extraCopy.status, 201);
    const extraId = (await extraCopy.json()).id;
    assert.equal((await admin(`/api/admin/files/${extraId}`, { method: 'DELETE' })).status, 200);
    const rows = (await (await admin('/api/admin/files')).json()).files;
    assert.equal(rows.find(file => file.id === sourceId).path, `${sourceFolder}/shared.txt`);
    assert.equal(rows.find(file => file.id === copiedId).path, `${targetFolder}/shared.txt`);
    const objects = (await (await admin('/api/admin/storage/objects?prefix=files/')).json()).entries;
    assert.equal(objects.filter(object => object.key === key).length, 1);
    assert.ok(!objects.some(object => object.key === `files/${copiedId}`));

    const share = await postJson('/api/admin/shares', { file_id: copiedId });
    assert.equal(share.status, 201);
    const shareUrl = (await share.json()).url;
    const originalDeleted = await admin(`/api/admin/files/${sourceId}`, { method: 'DELETE' });
    assert.equal(originalDeleted.status, 200);
    const download = await fetch(`${base}${shareUrl}/download`);
    assert.equal(download.status, 200, await download.clone().text());
    assert.equal(await download.text(), 'one stored object');

    const destinationDeleted = await admin(`/api/admin/folders?path=${encodeURIComponent(targetFolder)}`, { method: 'DELETE' });
    assert.equal(destinationDeleted.status, 200);
    assert.equal((await destinationDeleted.json()).done, false);
    const after = (await (await admin('/api/admin/storage/objects?prefix=files/')).json()).entries;
    assert.ok(!after.some(object => object.key === key));
    assert.equal((await fetch(`${base}${shareUrl}/download`)).status, 404);
  } finally {
    for (let n = 0; n < 5; n++) {
      const response = await admin(`/api/admin/folders?path=${encodeURIComponent(root)}`, { method: 'DELETE' });
      if (response.status === 404 || (await response.json()).done) break;
    }
  }
});
