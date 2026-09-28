import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConnectionStore } from '../src/connection-store.js';

test('ConnectionStore never returns the encrypted token in public connection data', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-nango-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new ConnectionStore(path.join(directory, 'connections.json'));
  await store.initialize();
  const connection = {
    id: 'connection-1',
    provider: 'github',
    accountId: '42',
    accountLogin: 'octocat',
    accountName: 'The Octocat',
    encryptedAccessToken: 'sensitive-value',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const created = await store.create(connection);
  assert.equal(created.encryptedAccessToken, undefined);
  assert.deepEqual(await store.listPublic(), [created]);
  assert.equal((await store.getRequired('connection-1')).encryptedAccessToken, 'sensitive-value');

  await store.remove('connection-1');
  assert.deepEqual(await store.listPublic(), []);
});
