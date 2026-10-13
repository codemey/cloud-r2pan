import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8797';
const adminKey = process.env.TEST_ADMIN_KEY || 'local-test-key';

test('nested folder upload and protected share preserve paths and file streaming', async () => {
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: adminKey }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const admin = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { cookie, ...options.headers },
  });
  const postJson = (path, body) => admin(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const root = `/folder-test-${Date.now()}`;
  const nested = `${root}/nested`;
  let fileId;
  let conflictingFileId;
  let shareId;
  try {
    for (const path of [root, nested]) {
      const response = await postJson('/api/admin/folders', { path });
      assert.equal(response.status, 201, await response.clone().text());
    }
    const folders = await admin('/api/admin/folders');
    assert.ok((await folders.json()).folders.includes(nested));

    const uploaded = await admin('/api/admin/upload', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-file-name': encodeURIComponent('hello.txt'),
        'x-folder-path': nested,
      },
      body: 'folder contents',
    });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    fileId = (await uploaded.json()).id;
    const files = await admin('/api/admin/files');
    assert.equal((await files.json()).files.find(file => file.id === fileId).path, `${nested}/hello.txt`);
    const created = await postJson('/api/admin/folder-shares', {
      path: root, password: 'folder-pass', max_downloads: 1,
    });
    assert.equal(created.status, 201, await created.clone().text());
    shareId = (await created.json()).id;
    const share = `${base}/f/${shareId}`;
    const cleanup = await admin('/api/admin/shares/cleanup', { method: 'POST' });
    assert.equal(cleanup.status, 200);
    const afterCleanup = await admin('/api/admin/files');
    assert.ok((await afterCleanup.json()).files.some(file => file.id === fileId));

    const unauthorized = await fetch(`${share}/manifest`);
    assert.equal(unauthorized.status, 403);
    const badPassword = await fetch(`${share}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(badPassword.status, 401);
    const verified = await fetch(`${share}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'folder-pass' }),
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    const ticket = (await verified.json()).ticket;
    const manifestResponse = await fetch(`${share}/manifest?t=${encodeURIComponent(ticket)}`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.ok(manifest.directories.includes('nested'));
    assert.deepEqual(manifest.files.map(file => file.path), ['nested/hello.txt']);

    const fileUrl = `${share}/file/${fileId}?t=${encodeURIComponent(ticket)}`;
    const range = await fetch(fileUrl, { headers: { range: 'bytes=0-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-5/15');
    assert.equal(await range.text(), 'folder');
    const full = await fetch(fileUrl);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-disposition'), /nested__hello\.txt/);
    assert.equal(await full.text(), 'folder contents');

    const movedOut = await postJson(`/api/admin/files/${fileId}/move`, { path: '/' });
    assert.equal(movedOut.status, 200);
    assert.equal((await fetch(fileUrl)).status, 404);
    const emptyManifest = await fetch(`${share}/manifest?t=${encodeURIComponent(ticket)}`);
    assert.deepEqual((await emptyManifest.json()).files, []);
    const movedBack = await postJson(`/api/admin/files/${fileId}/move`, { path: nested });
    assert.equal(movedBack.status, 200);
    assert.equal((await fetch(fileUrl)).status, 200);
    const conflictingUpload = await admin('/api/admin/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('hello.txt') },
      body: 'another file',
    });
    assert.equal(conflictingUpload.status, 201);
    conflictingFileId = (await conflictingUpload.json()).id;
    const conflict = await postJson(`/api/admin/files/${fileId}/move`, { path: '/' });
    assert.equal(conflict.status, 409);
    const missingTarget = await postJson(`/api/admin/files/${fileId}/move`, { path: `${root}/missing` });
    assert.equal(missingTarget.status, 404);

    const secondAccess = await fetch(`${share}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'folder-pass' }),
    });
    assert.equal(secondAccess.status, 410);
    assert.equal((await fetch(fileUrl)).status, 200);

    const revoked = await admin(`/api/admin/folder-shares/${shareId}`, { method: 'DELETE' });
    assert.equal(revoked.status, 200);
    shareId = undefined;
    assert.equal((await fetch(fileUrl)).status, 404);
  } finally {
    if (shareId) await admin(`/api/admin/folder-shares/${shareId}`, { method: 'DELETE' });
    if (fileId) await admin(`/api/admin/files/${fileId}`, { method: 'DELETE' });
    if (conflictingFileId) await admin(`/api/admin/files/${conflictingFileId}`, { method: 'DELETE' });
    for (const path of [nested, root]) {
      const removed = await admin(`/api/admin/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      assert.equal(removed.status, 200, await removed.text());
    }
  }
});

test('folder deletion removes nested files, shares, links and pending uploads in batches', async () => {
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
  const root = `/delete-test-${Date.now()}`;
  const nested = `${root}/nested`;
  const deleteRoot = () => admin(`/api/admin/folders?path=${encodeURIComponent(root)}`, { method: 'DELETE' });
  let sessionId;
  try {
    assert.equal((await postJson('/api/admin/folders', { path: root })).status, 201);
    assert.equal((await postJson('/api/admin/folders', { path: nested })).status, 201);
    const ids = [];
    for (let n = 0; n < 11; n++) {
      const uploaded = await admin('/api/admin/upload', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(`file-${n}.txt`),
          'x-folder-path': nested },
        body: `content-${n}`,
      });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      ids.push((await uploaded.json()).id);
    }
    const share = await postJson('/api/admin/shares', { file_id: ids[0] });
    assert.equal(share.status, 201);
    const shareUrl = (await share.json()).url;
    const direct = await postJson('/api/admin/direct-links', { file_id: ids[0] });
    assert.equal(direct.status, 201);
    const directUrl = (await direct.json()).url;
    const folderShare = await postJson('/api/admin/folder-shares', { path: nested });
    assert.equal(folderShare.status, 201);
    const folderUrl = (await folderShare.json()).url;
    const pending = await postJson('/api/admin/upload/multipart', {
      name: 'unfinished.bin', size: 100 * 1024 * 1024, path: nested,
    });
    assert.equal(pending.status, 201);
    sessionId = (await pending.json()).sessionId;

    let batches = 0;
    for (;;) {
      const response = await deleteRoot();
      assert.equal(response.status, 200, await response.clone().text());
      batches++;
      if ((await response.json()).done) break;
      assert.ok(batches < 10);
    }
    assert.ok(batches >= 4);
    const remaining = (await (await admin('/api/admin/files')).json()).files;
    assert.ok(ids.every(id => !remaining.some(file => file.id === id)));
    assert.equal((await admin(`/api/admin/upload/multipart/${sessionId}`)).status, 404);
    assert.equal((await fetch(`${base}${shareUrl}/download`)).status, 404);
    assert.equal((await fetch(`${base}${directUrl}`)).status, 404);
    assert.equal((await fetch(`${base}${folderUrl}/info`)).status, 404);
    assert.ok(!(await (await admin('/api/admin/folders')).json()).folders.includes(root));
    const objects = (await (await admin('/api/admin/storage/objects?prefix=files/')).json()).entries;
    assert.ok(ids.every(id => !objects.some(object => object.key === `files/${id}`)));
  } finally {
    for (let n = 0; n < 10; n++) {
      const response = await deleteRoot();
      if (response.status === 404 || (await response.json()).done) break;
    }
  }
});

test('storage reconciliation removes records for objects deleted outside file management', async () => {
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
  let id;
  try {
    const uploaded = await admin('/api/admin/upload', {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'reconcile.txt' },
      body: 'missing later',
    });
    assert.equal(uploaded.status, 201);
    id = (await uploaded.json()).id;
    assert.equal((await admin('/api/admin/storage/objects', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: `files/${id}` }),
    })).status, 200);
    assert.ok((await (await admin('/api/admin/files')).json()).files.some(file => file.id === id));
    let after = '';
    const missing = [];
    for (;;) {
      const response = await postJson('/api/admin/files/reconcile', { after });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      missing.push(...result.missing);
      if (result.done) break;
      after = result.next;
    }
    assert.ok(missing.includes(id));
    assert.ok((await (await admin('/api/admin/files')).json()).files.some(file => file.id === id));
    const cleaned = await admin('/api/admin/files/reconcile', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    assert.equal(cleaned.status, 200);
    assert.equal((await cleaned.json()).removed, 1);
    assert.ok(!(await (await admin('/api/admin/files')).json()).files.some(file => file.id === id));
  } finally {
    if (id) await admin(`/api/admin/files/${id}`, { method: 'DELETE' });
  }
});
