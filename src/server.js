import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ConnectionStore } from './connection-store.js';
import { AppError } from './errors.js';
import { GitHubDeviceFlow } from './github-device-flow.js';
import { GitHubOperations } from './github-operations.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(currentDirectory, '..', 'public');

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  const normalized = error instanceof AppError
    ? error
    : new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
  if (!(error instanceof AppError)) console.error(error);
  sendJson(response, normalized.status, {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > 1_000_000) {
        if (!tooLarge) {
          tooLarge = true;
          reject(new AppError(413, 'REQUEST_TOO_LARGE', 'Request body must be smaller than 1 MB.'));
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          throw new Error('Expected an object.');
        }
        resolve(value);
      } catch {
        reject(new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.'));
      }
    });
    request.on('error', reject);
  });
}

function decodedSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new AppError(400, 'INVALID_PATH', 'URL path contains invalid encoding.');
  }
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(requested)) {
    throw new AppError(404, 'NOT_FOUND', 'Route not found.');
  }
  const filePath = path.join(publicDirectory, requested);
  const mimeType = requested.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : requested.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8';
  const contents = await fs.readFile(filePath);
  response.writeHead(200, {
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(contents);
}

export async function createApp() {
  const connectionStore = new ConnectionStore(config.connectionStorePath);
  await connectionStore.initialize();
  const deviceFlow = new GitHubDeviceFlow({
    clientId: config.githubClientId,
    connectionStore,
    apiBaseUrl: config.githubApiBaseUrl,
  });
  const github = new GitHubOperations({ connectionStore, apiBaseUrl: config.githubApiBaseUrl });

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const segments = decodedSegments(url.pathname);

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { status: 'ok', provider: 'github' });
      }
      if (request.method === 'GET' && url.pathname === '/api/connections') {
        return sendJson(response, 200, { connections: await connectionStore.listPublic() });
      }
      if (request.method === 'POST' && url.pathname === '/api/connections/github/device/start') {
        return sendJson(response, 201, await deviceFlow.start());
      }
      if (request.method === 'POST' && url.pathname === '/api/connections/github/device/poll') {
        return sendJson(response, 200, await deviceFlow.poll((await readJson(request)).authSessionId));
      }
      if (segments[0] === 'api' && segments[1] === 'connections' && segments.length === 3) {
        const connectionId = segments[2];
        if (request.method === 'GET') {
          const connection = await connectionStore.getRequired(connectionId);
          const { encryptedAccessToken, ...safeConnection } = connection;
          return sendJson(response, 200, { connection: safeConnection });
        }
        if (request.method === 'DELETE') {
          await connectionStore.remove(connectionId);
          return sendJson(response, 200, { disconnected: true, connectionId });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/github/repositories') {
        return sendJson(response, 200, await github.listOrSearchRepositories({
          connectionId: url.searchParams.get('connectionId'),
          query: url.searchParams.get('query') || undefined,
          page: url.searchParams.get('page') || undefined,
          perPage: url.searchParams.get('perPage') || undefined,
        }));
      }
      if (request.method === 'POST' && url.pathname === '/api/github/issues') {
        return sendJson(response, 201, { issue: await github.createIssue(await readJson(request)) });
      }
      if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'github' && segments[2] === 'issues' && segments.length === 6) {
        return sendJson(response, 200, { issue: await github.getIssue({
          connectionId: url.searchParams.get('connectionId'),
          owner: segments[3],
          repository: segments[4],
          issueNumber: segments[5],
        }) });
      }
      if (!url.pathname.startsWith('/api/')) {
        return await serveStatic(url.pathname, response);
      }
      throw new AppError(404, 'NOT_FOUND', 'Route not found.');
    } catch (error) {
      sendError(response, error);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp()
    .then((server) => {
      server.listen(config.port, () => {
        console.log(`Mini-Nango GitHub POC listening on http://localhost:${config.port}`);
      });
    })
    .catch((error) => {
      console.error(`Unable to start: ${error.message}`);
      process.exitCode = 1;
    });
}
