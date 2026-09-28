import crypto from 'node:crypto';
import { encrypt } from './config.js';
import { AppError, requireString } from './errors.js';
import { GitHubClient } from './github-client.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

async function oauthRequest(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'mini-nango-github-poc',
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach GitHub authentication. Please try again.', {
      cause: error.name,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(502, 'PROVIDER_API_ERROR', 'GitHub authentication returned an invalid response.');
  }
  if (!response.ok || payload.error) {
    if (response.status === 404 || payload.error === 'Not Found' || payload.message === 'Not Found') {
      throw new AppError(
        400,
        'OAUTH_CONFIGURATION_ERROR',
        'GitHub returned 404 Not Found for this Client ID. Please verify: (1) You copied the Client ID (not the 40-character Client Secret) into .env; (2) "Enable Device Flow" is checked in your GitHub OAuth App settings; (3) You restarted the service after updating .env.',
      );
    }
    throw new AppError(502, 'PROVIDER_API_ERROR', payload.error_description || payload.error || payload.message || 'GitHub authentication failed.');
  }
  return payload;
}

export class GitHubDeviceFlow {
  constructor({ clientId, connectionStore, apiBaseUrl }) {
    this.clientId = clientId;
    this.connectionStore = connectionStore;
    this.apiBaseUrl = apiBaseUrl;
    this.sessions = new Map();
  }

  clearExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  async start() {
    this.clearExpiredSessions();
    const trimmedId = (this.clientId || '').trim();
    if (/^[0-9a-f]{40}$/i.test(trimmedId)) {
      throw new AppError(
        400,
        'OAUTH_CONFIGURATION_ERROR',
        'GITHUB_CLIENT_ID appears to be a GitHub Client Secret (40 hex characters), not a Client ID. GitHub OAuth App Client IDs are 20 characters (typically starting with "Ov23li" or "Iv1."). Please copy the Client ID from GitHub Developer Settings -> OAuth Apps into .env and restart the service.',
      );
    }
    const device = await oauthRequest(DEVICE_CODE_URL, {
      client_id: this.clientId,
      scope: 'repo read:user',
    });
    const authSessionId = crypto.randomUUID();
    const intervalSeconds = Number(device.interval) || 5;
    this.sessions.set(authSessionId, {
      deviceCode: device.device_code,
      expiresAt: Date.now() + Number(device.expires_in) * 1000,
      intervalSeconds,
      nextPollAt: Date.now(),
    });

    return {
      authSessionId,
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: Number(device.expires_in),
      pollAfterSeconds: intervalSeconds,
    };
  }

  async poll(authSessionId) {
    const selectedSessionId = requireString(authSessionId, 'authSessionId', { maxLength: 100 });
    this.clearExpiredSessions();
    const session = this.sessions.get(selectedSessionId);
    if (!session) {
      throw new AppError(404, 'AUTH_SESSION_NOT_FOUND', 'This authorization session is missing or expired. Start again.');
    }
    if (Date.now() < session.nextPollAt) {
      return { status: 'pending', pollAfterSeconds: Math.ceil((session.nextPollAt - Date.now()) / 1000) };
    }

    let response;
    try {
      response = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'mini-nango-github-poc',
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: session.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'Could not reach GitHub authentication. Please try again.', {
        cause: error.name,
      });
    }

    const payload = await response.json().catch(() => ({}));
    if (payload.error === 'authorization_pending') {
      session.nextPollAt = Date.now() + session.intervalSeconds * 1000;
      return { status: 'pending', pollAfterSeconds: session.intervalSeconds };
    }
    if (payload.error === 'slow_down') {
      session.intervalSeconds += 5;
      session.nextPollAt = Date.now() + session.intervalSeconds * 1000;
      return { status: 'pending', pollAfterSeconds: session.intervalSeconds };
    }
    if (payload.error === 'expired_token') {
      this.sessions.delete(selectedSessionId);
      throw new AppError(400, 'AUTHORIZATION_EXPIRED', 'The GitHub device code expired. Start again.');
    }
    if (payload.error || !response.ok || !payload.access_token) {
      this.sessions.delete(selectedSessionId);
      throw new AppError(502, 'PROVIDER_API_ERROR', payload.error_description || payload.error || 'GitHub authentication failed.');
    }

    const client = new GitHubClient({ accessToken: payload.access_token, apiBaseUrl: this.apiBaseUrl });
    const account = await client.request('/user');
    const connection = {
      id: crypto.randomUUID(),
      provider: 'github',
      accountId: String(account.id),
      accountLogin: account.login,
      accountName: account.name || account.login,
      credentialType: 'oauth_access_token',
      scopes: payload.scope ? payload.scope.split(/[ ,]+/).filter(Boolean) : [],
      encryptedAccessToken: encrypt(payload.access_token),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const savedConnection = await this.connectionStore.create(connection);
    this.sessions.delete(selectedSessionId);
    return { status: 'connected', connection: savedConnection };
  }
}
