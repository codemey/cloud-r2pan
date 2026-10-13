import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8797';
const adminKey = process.env.TEST_ADMIN_KEY || 'local-test-key';

test('multipart upload becomes one R2 file with resumable downloads', async () => {
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

  let sessionId;
  let fileId;
  let plannedSessionId;
  let folderShareId;
  const folderPath = `/multipart-test-${Date.now()}`;
  try {
    const folder = await postJson('/api/admin/folders', { path: folderPath });
    assert.equal(folder.status, 201);
    const planned = await postJson('/api/admin/upload/multipart', {
      name: 'planned-2.5-gib.bin', size: 2.5 * 1024 ** 3, mime: 'application/octet-stream', path: folderPath,
    });
    assert.equal(planned.status, 201);
    const plan = await planned.json();
    plannedSessionId = plan.sessionId;
    assert.equal(plan.partSize, 32 * 1024 ** 2);
    assert.equal(plan.partCount, 80);
    const plannedPart = await admin(`/api/admin/upload/multipart/${plannedSessionId}/parts/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(plan.partSize, 7),
    });
    assert.equal(plannedPart.status, 200);
    const pending = await admin('/api/admin/upload/multipart');
    assert.equal(pending.status, 200);
    const pendingRow = (await pending.json()).sessions.find(row => row.id === plannedSessionId);
    assert.equal(pendingRow.key, `files/${plannedSessionId}`);
    assert.equal(pendingRow.uploaded_parts, 1);
    const cancelled = await admin(`/api/admin/upload/multipart/${plannedSessionId}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    assert.equal((await admin(`/api/admin/upload/multipart/${plannedSessionId}`)).status, 404);
    const afterAbort = await admin('/api/admin/upload/multipart');
    assert.ok(!(await afterAbort.json()).sessions.some(row => row.id === plannedSessionId));
    plannedSessionId = undefined;

    const size = 90 * 1024 * 1024 + 17;
    const init = await postJson('/api/admin/upload/multipart', {
      name: 'large-upload-test.bin', size, mime: 'application/octet-stream', path: folderPath,
    });
    assert.equal(init.status, 201, init.status === 201 ? undefined : await init.text());
    const session = await init.json();
    sessionId = session.sessionId;
    assert.equal(session.partCount, 3);

    const uploadPart = async (n) => {
      const length = Math.min(session.partSize, size - (n - 1) * session.partSize);
      const response = await admin(`/api/admin/upload/multipart/${sessionId}/parts/${n}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(length, n),
      });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    };

    await uploadPart(1);
    const status = await admin(`/api/admin/upload/multipart/${sessionId}`);
    const uploadStatus = await status.json();
    assert.deepEqual(uploadStatus.uploadedParts, [1]);
    assert.equal(uploadStatus.path, folderPath);
    const early = await postJson(`/api/admin/upload/multipart/${sessionId}/complete`, {});
    assert.equal(early.status, 409);

    await uploadPart(2);
    await uploadPart(3);
    const completed = await postJson(`/api/admin/upload/multipart/${sessionId}/complete`, {});
    assert.equal(completed.status, 201, completed.status === 201 ? undefined : await completed.text());
    fileId = (await completed.json()).id;
    const again = await postJson(`/api/admin/upload/multipart/${sessionId}/complete`, {});
    assert.equal(again.status, 200);
    const completedAbort = await admin(`/api/admin/upload/multipart/${sessionId}`, { method: 'DELETE' });
    assert.equal(completedAbort.status, 409);
    const afterComplete = await admin('/api/admin/upload/multipart');
    assert.ok(!(await afterComplete.json()).sessions.some(row => row.id === sessionId));

    const files = await admin('/api/admin/files');
    const file = (await files.json()).files.find((row) => row.id === fileId);
    assert.equal(file.size, size);
    assert.equal(file.path, `${folderPath}/large-upload-test.bin`);
    const objects = await admin('/api/admin/storage/objects?prefix=files/');
    const stored = (await objects.json()).entries.filter((entry) => entry.key === `files/${fileId}`);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].size, size);

    const direct = await postJson('/api/admin/direct-links', { file_id: fileId, max_downloads: 1 });
    assert.equal(direct.status, 201);
    const directUrl = (await direct.json()).url;
    const head = await fetch(`${base}${directUrl}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(size));
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    const range = await fetch(`${base}${directUrl}`, { headers: { range: 'bytes=0-15' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-15/${size}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.alloc(16, 1));

    const share = await postJson('/api/admin/shares', { file_id: fileId });
    assert.equal(share.status, 201);
    const shareUrl = `/s/${(await share.json()).id}/download`;
    const boundary = await fetch(`${base}${shareUrl}`, {
      headers: { range: `bytes=${session.partSize - 4}-${session.partSize + 3}` },
    });
    assert.equal(boundary.status, 206);
    assert.deepEqual(Buffer.from(await boundary.arrayBuffer()),
      Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(4, 2)]));
    const invalid = await fetch(`${base}${shareUrl}`, { headers: { range: `bytes=${size}-` } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${size}`);

    const folderShare = await postJson('/api/admin/folder-shares', { path: folderPath });
    assert.equal(folderShare.status, 201);
    folderShareId = (await folderShare.json()).id;
    const folderVerify = await fetch(`${base}/f/${folderShareId}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(folderVerify.status, 200);
    const ticket = (await folderVerify.json()).ticket;
    const folderManifest = await fetch(`${base}/f/${folderShareId}/manifest?t=${encodeURIComponent(ticket)}`);
    assert.equal(folderManifest.status, 200);
    assert.deepEqual((await folderManifest.json()).files.map(file => file.id), [fileId]);
    const full = await fetch(`${base}/f/${folderShareId}/file/${fileId}?t=${encodeURIComponent(ticket)}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(size));
    const actual = createHash('sha256');
    let received = 0;
    for await (const chunk of full.body) {
      actual.update(chunk);
      received += chunk.length;
    }
    const expected = createHash('sha256');
    for (let n = 1; n <= session.partCount; n++) {
      expected.update(Buffer.alloc(Math.min(session.partSize, size - (n - 1) * session.partSize), n));
    }
    assert.equal(received, size);
    assert.equal(actual.digest('hex'), expected.digest('hex'));
  } finally {
    if (folderShareId) await admin(`/api/admin/folder-shares/${folderShareId}`, { method: 'DELETE' });
    if (fileId) await admin(`/api/admin/files/${fileId}`, { method: 'DELETE' });
    else if (sessionId) await admin(`/api/admin/upload/multipart/${sessionId}`, { method: 'DELETE' });
    if (plannedSessionId) await admin(`/api/admin/upload/multipart/${plannedSessionId}`, { method: 'DELETE' });
    await admin(`/api/admin/folders?path=${encodeURIComponent(folderPath)}`, { method: 'DELETE' });
  }
});
