import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-nango-server-'));
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.CONNECTION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.CONNECTION_STORE_PATH = path.join(directory, 'connections.json');

const { createApp } = await import('../src/server.js');

test('health and connection-status endpoints work without provider credentials', async (t) => {
  const server = await createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', provider: 'github' });

  const connections = await fetch(`${origin}/api/connections`);
  assert.equal(connections.status, 200);
  assert.deepEqual(await connections.json(), { connections: [] });

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /GitHub integration POC/);

  const missingConnection = await fetch(`${origin}/api/github/repositories`);
  assert.equal(missingConnection.status, 400);
  assert.equal((await missingConnection.json()).error.code, 'VALIDATION_ERROR');

  const missingAuthSession = await fetch(`${origin}/api/connections/github/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingAuthSession.status, 400);
  assert.equal((await missingAuthSession.json()).error.code, 'VALIDATION_ERROR');
});

test('GitHubDeviceFlow detects Client Secret mistakenly used as Client ID', async () => {
  const { GitHubDeviceFlow } = await import('../src/github-device-flow.js');
  const flow = new GitHubDeviceFlow({
    clientId: '0d91861bf7b88bc3fbbfb6b57ae315a5e4e3c05b',
    connectionStore: null,
    apiBaseUrl: 'https://api.github.com',
  });
  await assert.rejects(
    () => flow.start(),
    (err) => {
      assert.equal(err.code, 'OAUTH_CONFIGURATION_ERROR');
      assert.match(err.message, /Client Secret/);
      return true;
    },
  );
});

